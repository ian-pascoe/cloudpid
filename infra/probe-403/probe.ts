// Throwaway probe for #403 (Verify MCP sign-in on a deployed stage). Not part of cloudpid; never merged.
//
// Stands in for a stage's main Worker on the MCP sign-in paths of ADR-0035: behind Worker-level Access (the owner-email
// policy of `deployment(stage)`), it serves the public client document (`/oauth/mcp/client.json`), starts a sign-in
// (`/oauth/mcp/start`, behind Access), takes the authorization response on `/oauth/mcp/callback` (public on role
// `prod`, behind Access on role `preview`), refreshes, and calls `tools/list` with the token. It logs every fetch of
// the document and every step, read back from `/` and `/log`. Each response carries `x-probe-path`, the path the
// Worker saw, so path-normalization tricks against the bypass can be checked from outside.

import { DurableObject } from "cloudflare:workers";
import { ICON_192, ICON_512 } from "./icons.ts";

interface Env {
  readonly ROLE: "prod" | "preview";
  /** The configured origin (prod); empty on preview, which takes the request's origin. */
  readonly HOST: string;
  readonly STORE: DurableObjectNamespace<Store>;
}

const SERVERS: Record<string, string> = {
  sentry: "https://mcp.sentry.dev/mcp",
  linear: "https://mcp.linear.app/mcp",
};

type Mode = "document" | "dcr";

interface Pending {
  server: string;
  mode: Mode;
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  verifier: string;
  createdAt: number;
}

interface SignIn {
  server: string;
  mode: Mode;
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  resource: string;
  accessToken: string;
  refreshToken?: string;
  scope?: string;
  expiresAt?: number;
  obtainedAt: number;
  refreshedAt?: number;
  refreshes: number;
}

export class Store extends DurableObject {
  async get<T>(key: string): Promise<T | undefined> {
    return this.ctx.storage.get<T>(key);
  }
  async put(key: string, value: unknown): Promise<void> {
    await this.ctx.storage.put(key, value);
  }
  async take<T>(key: string): Promise<T | undefined> {
    const value = await this.ctx.storage.get<T>(key);
    await this.ctx.storage.delete(key);
    return value;
  }
  async append(key: string, entry: unknown): Promise<void> {
    const list = (await this.ctx.storage.get<unknown[]>(key)) ?? [];
    list.push(entry);
    await this.ctx.storage.put(key, list.slice(-200));
  }
  async list(prefix: string): Promise<Record<string, unknown>> {
    return Object.fromEntries(await this.ctx.storage.list({ prefix }));
  }
}

const store = (env: Env) => env.STORE.get(env.STORE.idFromName("main"));

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

const sha256 = async (s: string) =>
  b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

const trimSlash = (s: string) => s.replace(/\/$/, "");

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const short = (s: string) => (s.length > 300 ? s.slice(0, 300) + "…" : s);

const origin = (env: Env, request: Request) => env.HOST || new URL(request.url).origin;

const event = (env: Env, kind: string, detail: Record<string, unknown>) =>
  store(env).append("events", { ts: new Date().toISOString(), kind, ...detail });

// Where the request came from, without secrets: enough to tell an authorization server's fetcher from a browser.
const requester = (request: Request) => {
  const cf = (request as unknown as { cf?: Record<string, unknown> }).cf ?? {};
  const cookie = request.headers.get("cookie") ?? "";
  return {
    ip: request.headers.get("cf-connecting-ip"),
    asn: cf.asn,
    asOrganization: cf.asOrganization,
    country: cf.country,
    userAgent: request.headers.get("user-agent"),
    accept: request.headers.get("accept"),
    cookieNames: cookie
      .split(";")
      .map((c) => c.split("=")[0]?.trim())
      .filter(Boolean),
    accessJwt: request.headers.has("cf-access-jwt-assertion"),
    accessEmail: request.headers.get("cf-access-authenticated-user-email"),
    ray: request.headers.get("cf-ray"),
  };
};

const fetchJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, {
    ...init,
    headers: { accept: "application/json", ...init?.headers },
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return {
    status: response.status,
    ok: response.ok,
    body: body as Record<string, any> | undefined,
    text,
  };
};

// RFC 9728 then RFC 8414, as the MCP spec orders them.
const discover = async (serverUrl: string) => {
  const url = new URL(serverUrl);
  let prm = await fetchJson(`${url.origin}/.well-known/oauth-protected-resource${url.pathname}`);
  if (!prm.ok) prm = await fetchJson(`${url.origin}/.well-known/oauth-protected-resource`);
  if (!prm.ok || !prm.body) throw new Error(`protected resource metadata: ${prm.status}`);
  const issuer = new URL(prm.body.authorization_servers[0]);
  const path = issuer.pathname === "/" ? "" : issuer.pathname;
  let as = await fetchJson(`${issuer.origin}/.well-known/oauth-authorization-server${path}`);
  if (!as.ok) as = await fetchJson(`${issuer.origin}/.well-known/openid-configuration${path}`);
  if (!as.ok || !as.body) throw new Error(`authorization server metadata: ${as.status}`);
  return { prm: prm.body, as: as.body };
};

const clientDocument = (host: string) => ({
  client_id: `${host}/oauth/mcp/client.json`,
  client_name: "cloudpid",
  client_uri: host,
  redirect_uris: [`${host}/oauth/mcp/callback`],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  application_type: "web",
});

const start = async (request: Request, env: Env) => {
  const params = new URL(request.url).searchParams;
  const server = params.get("server") ?? "";
  const mode = (params.get("mode") ?? "document") as Mode;
  const serverUrl = SERVERS[server];
  if (!serverUrl)
    return json({ reached: "start", error: "unknown server", requester: requester(request) }, 400);

  const host = origin(env, request);
  const redirectUri = `${host}/oauth/mcp/callback`;
  const { prm, as } = await discover(serverUrl);
  const issuer: string = as.issuer;

  let clientId: string;
  if (mode === "document") {
    if (!as.client_id_metadata_document_supported)
      return json({ error: "AS has no CIMD support", as }, 400);
    clientId = `${host}/oauth/mcp/client.json`;
  } else {
    const key = `client:${issuer}:${redirectUri}`;
    const known = await store(env).get<{ client_id: string }>(key);
    if (known) {
      clientId = known.client_id;
    } else {
      const registered = await fetchJson(as.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "cloudpid (probe-403 preview)",
          redirect_uris: [redirectUri],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          application_type: "web",
        }),
      });
      await event(env, "dcr", { server, status: registered.status, body: short(registered.text) });
      if (!registered.ok || !registered.body)
        return json({ error: "DCR refused", ...registered }, 502);
      clientId = registered.body.client_id;
      await store(env).put(key, registered.body);
    }
  }

  const verifier = random(32);
  const state = random(32);
  const resource: string = prm.resource ?? serverUrl;
  const scopes: string[] = [...(prm.scopes_supported ?? [])];
  if ((as.scopes_supported ?? []).includes("offline_access")) scopes.push("offline_access");

  const pending: Pending = {
    server,
    mode,
    issuer,
    tokenEndpoint: as.token_endpoint,
    clientId,
    redirectUri,
    resource,
    verifier,
    createdAt: Date.now(),
  };
  await store(env).put(`state:${state}`, pending);

  const authorize = new URL(as.authorization_endpoint);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: await sha256(verifier),
    code_challenge_method: "S256",
    state,
    resource,
    ...(scopes.length ? { scope: scopes.join(" ") } : {}),
  }).toString();
  await event(env, "start", {
    server,
    mode,
    issuer,
    clientId,
    scope: scopes.join(" "),
    requester: requester(request),
  });
  return Response.redirect(authorize.toString(), 302);
};

const callbackPage = (title: string, detail: unknown, home: string) => {
  const nonce = random(16);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>${title}</title><style>body{font:15px system-ui;margin:16px}pre{white-space:pre-wrap;word-break:break-all;background:#f4f4f4;padding:8px}</style>
</head><body><h1>${title}</h1><pre>${escape(JSON.stringify(detail, null, 2))}</pre>
<p><a href="${home}">Back to the probe</a></p>
<script nonce="${nonce}">history.replaceState(null, "", "/oauth/mcp/callback");</script></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
  });
};

const escape = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const callback = async (request: Request, env: Env) => {
  const params = new URL(request.url).searchParams;
  const who = requester(request);
  const home = origin(env, request) + "/";
  const state = params.get("state") ?? "";
  const pending = state ? await store(env).take<Pending>(`state:${state}`) : undefined;
  if (!pending || Date.now() - pending.createdAt > 10 * 60_000) {
    await event(env, "callback-rejected", {
      reason: pending ? "expired" : "unknown state",
      requester: who,
    });
    return callbackPage(
      "Sign-in failed",
      { reason: "unknown or expired state", requester: who },
      home,
    );
  }
  if (params.get("error")) {
    await event(env, "callback-error", {
      server: pending.server,
      error: params.get("error"),
      requester: who,
    });
    return callbackPage(
      "Sign-in refused",
      { error: params.get("error"), description: params.get("error_description") },
      home,
    );
  }
  const iss = params.get("iss");
  if (iss !== null && trimSlash(iss) !== trimSlash(pending.issuer)) {
    await event(env, "callback-rejected", {
      reason: "iss mismatch",
      iss,
      issuer: pending.issuer,
      requester: who,
    });
    return callbackPage("Sign-in failed", { reason: "iss mismatch" }, home);
  }
  const token = await fetchJson(pending.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.get("code") ?? "",
      redirect_uri: pending.redirectUri,
      client_id: pending.clientId,
      code_verifier: pending.verifier,
      resource: pending.resource,
    }),
  });
  if (!token.ok || !token.body?.access_token) {
    await event(env, "token-failed", {
      server: pending.server,
      mode: pending.mode,
      status: token.status,
      body: short(token.text),
    });
    return callbackPage(
      "Token exchange failed",
      { status: token.status, body: short(token.text) },
      home,
    );
  }
  const signIn: SignIn = {
    server: pending.server,
    mode: pending.mode,
    issuer: pending.issuer,
    tokenEndpoint: pending.tokenEndpoint,
    clientId: pending.clientId,
    resource: pending.resource,
    accessToken: token.body.access_token,
    refreshToken: token.body.refresh_token,
    scope: token.body.scope,
    expiresAt: token.body.expires_in ? Date.now() + token.body.expires_in * 1000 : undefined,
    obtainedAt: Date.now(),
    refreshes: 0,
  };
  await store(env).put(`signin:${pending.server}:${pending.mode}`, signIn);
  const summary = {
    server: pending.server,
    mode: pending.mode,
    issPresent: iss !== null,
    tokenFields: Object.keys(token.body),
    expiresIn: token.body.expires_in,
    refreshToken: Boolean(token.body.refresh_token),
    scope: token.body.scope,
    requester: who,
  };
  await event(env, "signed-in", summary);
  return callbackPage("Signed in", summary, home);
};

const refresh = async (request: Request, env: Env) => {
  const params = new URL(request.url).searchParams;
  const key = `signin:${params.get("server")}:${params.get("mode") ?? "document"}`;
  const signIn = await store(env).get<SignIn>(key);
  if (!signIn?.refreshToken) return json({ error: "no sign-in with a refresh token", key }, 404);
  const before = Date.now();
  const token = await fetchJson(signIn.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: signIn.refreshToken,
      client_id: signIn.clientId,
      resource: signIn.resource,
    }),
  });
  await new Promise((r) => setTimeout(r, 1500));
  const fetches = ((await store(env).get<{ ts: string }[]>("document-fetches")) ?? []).filter(
    (f) => Date.parse(f.ts) >= before - 500,
  );
  const result = {
    key,
    status: token.status,
    body: token.ok
      ? { fields: Object.keys(token.body ?? {}), expires_in: token.body?.expires_in }
      : short(token.text),
    rotatedRefreshToken: token.ok
      ? token.body?.refresh_token !== undefined && token.body.refresh_token !== signIn.refreshToken
      : undefined,
    documentFetchedDuringRefresh: fetches,
  };
  if (token.ok && token.body?.access_token) {
    await store(env).put(key, {
      ...signIn,
      accessToken: token.body.access_token,
      refreshToken: token.body.refresh_token ?? signIn.refreshToken,
      expiresAt: token.body.expires_in ? Date.now() + token.body.expires_in * 1000 : undefined,
      refreshedAt: Date.now(),
      refreshes: signIn.refreshes + 1,
    } satisfies SignIn);
  }
  await event(env, "refresh", result);
  return json(result, token.ok ? 200 : 502);
};

// initialize, notifications/initialized, tools/list over Streamable HTTP; answers may be JSON or one SSE event.
const call = async (request: Request, env: Env) => {
  const params = new URL(request.url).searchParams;
  const key = `signin:${params.get("server")}:${params.get("mode") ?? "document"}`;
  const signIn = await store(env).get<SignIn>(key);
  if (!signIn) return json({ error: "no sign-in", key }, 404);
  const url = SERVERS[signIn.server]!;
  let session: string | null = null;
  const rpc = async (body: Record<string, unknown>) => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${signIn.accessToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
    });
    session = response.headers.get("mcp-session-id") ?? session;
    const text = await response.text();
    if (!("id" in body)) return { status: response.status };
    const data = response.headers.get("content-type")?.includes("text/event-stream")
      ? text
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .map((l) => JSON.parse(l))
          .find((m) => m.id === body.id)
      : JSON.parse(text || "null");
    return {
      status: response.status,
      data,
      wwwAuthenticate: response.headers.get("www-authenticate"),
    };
  };
  try {
    const init = await rpc({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "cloudpid-probe-403", version: "0" },
      },
    });
    if (init.status !== 200) return json({ step: "initialize", ...init }, 502);
    await rpc({ method: "notifications/initialized" });
    const tools = await rpc({ id: 2, method: "tools/list" });
    const names: string[] = tools.data?.result?.tools?.map((t: { name: string }) => t.name) ?? [];
    const result = {
      key,
      server: init.data?.result?.serverInfo,
      protocolVersion: init.data?.result?.protocolVersion,
      toolCount: names.length,
      tools: names.slice(0, 8),
    };
    await event(env, "call", result);
    return json(result);
  } catch (error) {
    return json({ error: String(error) }, 502);
  }
};

const home = async (request: Request, env: Env) => {
  const s = store(env);
  const signIns = (await s.list("signin:")) as Record<string, SignIn>;
  const rows = Object.entries(signIns)
    .map(
      ([k, v]) =>
        `<li><b>${k}</b>: obtained ${new Date(v.obtainedAt).toISOString()}, refreshes ${v.refreshes}, refresh token ${Boolean(v.refreshToken)}, expires ${v.expiresAt ? new Date(v.expiresAt).toISOString() : "?"}, client ${escape(v.clientId)}</li>`,
    )
    .join("");
  const modes: Mode[] = env.ROLE === "prod" ? ["document", "dcr"] : ["dcr"];
  const buttons = Object.keys(SERVERS)
    .flatMap((server) =>
      modes.map(
        (mode) =>
          `<p><b>${server} (${mode})</b>: <a class="b" href="/oauth/mcp/start?server=${server}&mode=${mode}">Sign in</a>
<button onclick="act('refresh','${server}','${mode}')">Refresh</button>
<button onclick="act('call','${server}','${mode}')">tools/list</button></p>`,
      ),
    )
    .join("");
  const events = ((await s.get<unknown[]>("events")) ?? []).slice(-25).reverse();
  const fetches = ((await s.get<unknown[]>("document-fetches")) ?? []).slice(-25).reverse();
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>probe-403 ${env.ROLE}</title><link rel="manifest" href="/manifest.webmanifest"><link rel="apple-touch-icon" href="/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="theme-color" content="#5b3fd9">
<style>body{font:15px system-ui;margin:16px}pre{white-space:pre-wrap;word-break:break-all;background:#f4f4f4;padding:8px;font-size:12px}
a.b,button{display:inline-block;padding:6px 10px;margin:2px;border:1px solid #5b3fd9;border-radius:6px;background:#fff;color:#5b3fd9;text-decoration:none;font:inherit}</style>
</head><body><h1>probe-403 (${env.ROLE})</h1>
<p>Standalone: <span id="pwa"></span>. Origin ${escape(origin(env, request))}.</p>
${buttons}<pre id="out"></pre><h2>Sign-ins</h2><ul>${rows || "<li>none</li>"}</ul>
<h2>Document fetches</h2><pre>${escape(JSON.stringify(fetches, null, 2))}</pre>
<h2>Events</h2><pre>${escape(JSON.stringify(events, null, 2))}</pre>
<script>
document.getElementById("pwa").textContent = String(matchMedia("(display-mode: standalone)").matches || navigator.standalone === true);
async function act(what, server, mode) {
  const out = document.getElementById("out"); out.textContent = what + " " + server + "…";
  const r = await fetch("/oauth/mcp/" + what + "?server=" + server + "&mode=" + mode, { method: "POST" });
  out.textContent = r.status + "\\n" + await r.text();
}
</script></body></html>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
};

const png = (b64: string) =>
  new Response(
    Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
    {
      headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
    },
  );

const route = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);
  switch (url.pathname) {
    case "/":
      return home(request, env);
    case "/oauth/mcp/client.json": {
      await store(env).append("document-fetches", {
        ts: new Date().toISOString(),
        query: url.search,
        ...requester(request),
      });
      return json(clientDocument(origin(env, request)), 200, {
        "cache-control": "public, max-age=3600",
      });
    }
    case "/oauth/mcp/start":
      return request.method === "GET" ? start(request, env) : json({ error: "GET only" }, 405);
    case "/oauth/mcp/callback":
      return callback(request, env);
    case "/oauth/mcp/refresh":
      return request.method === "POST"
        ? refresh(request, env)
        : json({ reached: "refresh", requester: requester(request) }, 405);
    case "/oauth/mcp/call":
      return request.method === "POST"
        ? call(request, env)
        : json({ reached: "call", requester: requester(request) }, 405);
    case "/log":
      return json({
        role: env.ROLE,
        signIns: Object.keys(await store(env).list("signin:")),
        documentFetches: await store(env).get("document-fetches"),
        events: await store(env).get("events"),
      });
    case "/manifest.webmanifest":
      return json(
        {
          name: `probe-403 ${env.ROLE}`,
          short_name: "probe-403",
          start_url: "/",
          scope: "/",
          display: "standalone",
          background_color: "#ffffff",
          theme_color: "#5b3fd9",
          icons: [
            { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
          ],
        },
        200,
        { "content-type": "application/manifest+json" },
      );
    case "/icon-192.png":
      return png(ICON_192);
    case "/icon-512.png":
      return png(ICON_512);
    default:
      // Any other path: say what was reached, so a request that slipped past Access shows up as a 404 from the Worker.
      return json({ reached: "worker", path: url.pathname, requester: requester(request) }, 404);
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try {
      response = await route(request, env);
    } catch (error) {
      response = json({ error: String(error) }, 500);
    }
    response = new Response(response.body, response);
    response.headers.set("x-probe-path", new URL(request.url).pathname);
    response.headers.set("x-probe-role", env.ROLE);
    return response;
  },
};
