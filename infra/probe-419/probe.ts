// Throwaway probe for #419 (Verify the MCP endpoint behind Access managed OAuth on a deployed stage). Not part of
// cloudpid; never merged.
//
// Stands in for the main Worker's MCP endpoint: a stateless `createMcpHandler` on `/mcp` (`legacy: "stateless"`,
// `responseMode: "sse"`, 15 s keepalives) with two tools, `whoami` (what Access forwarded) and `wait` (waits up to
// 300 s, progress every 10 s when the call carried a `progressToken`). Every request is recorded in a `Store` DO: path,
// method, User-Agent, the JSON-RPC method, `initialize`'s `clientInfo` and protocol version, the Modern envelope, the
// progress token, and the decoded and verified `Cf-Access-Jwt-Assertion` plus `ctx.access` (aud, `getIdentity()`).
// `/mcp/log` reads the record back (JSON); `/`, `/rpc` and `/whoami` answer with the caller's claims, so a 403 from
// Access is told apart from the Worker's answer.

import { DurableObject } from "cloudflare:workers";
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const TEAM_DOMAIN = "https://spirit-led-software.cloudflareaccess.com";
const OWNER_EMAIL = "ian.g.pascoe@gmail.com";

interface Env {
  readonly ROLE: string;
  readonly SERVICE_TOKEN_CLIENT_ID: string;
  readonly STORE: DurableObjectNamespace<Store>;
}

interface AccessCtx {
  readonly aud: string;
  getIdentity(): Promise<Record<string, unknown> | undefined>;
}

export class Store extends DurableObject {
  async add(event: Record<string, unknown>): Promise<void> {
    const n = ((await this.ctx.storage.get<number>("n")) ?? 0) + 1;
    await this.ctx.storage.put({ n, [`e:${String(n).padStart(6, "0")}`]: event });
  }
  async list(since: number): Promise<unknown[]> {
    const map = await this.ctx.storage.list({
      prefix: "e:",
      start: `e:${String(since).padStart(6, "0")}`,
    });
    return [...map.entries()].map(([k, v]) => ({ i: Number(k.slice(2)), ...(v as object) }));
  }
  async clear(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

const b64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const decodePart = (s: string) =>
  JSON.parse(new TextDecoder().decode(b64url(s))) as Record<string, unknown>;

let jwks: { keys: (JsonWebKey & { kid: string })[] } | undefined;

/** Decodes the assertion and checks it as D12 says the main Worker will: signature (team JWKS), iss, aud, exp, nbf. */
const verifyAssertion = async (jwt: string | null, aud: string | undefined) => {
  if (!jwt) return { present: false };
  const [h, p, s] = jwt.split(".");
  if (!h || !p || !s) return { present: true, malformed: true };
  const header = decodePart(h);
  const claims = decodePart(p);
  jwks ??= (await (await fetch(`${TEAM_DOMAIN}/cdn-cgi/access/certs`)).json()) as typeof jwks;
  const jwk = jwks!.keys.find((k) => k.kid === header.kid);
  let signature = false;
  if (jwk) {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    signature = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64url(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
  }
  const now = Date.now() / 1000;
  const audList = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  return {
    present: true,
    header,
    claims,
    checks: {
      signature,
      iss: claims.iss === TEAM_DOMAIN,
      aud: aud !== undefined && audList.includes(aud),
      exp: typeof claims.exp === "number" && claims.exp > now,
      nbf: claims.nbf === undefined || (typeof claims.nbf === "number" && claims.nbf <= now + 60),
    },
  };
};

/** D12's classification: owner by email, service token by empty sub + common_name. */
const classify = (claims: Record<string, unknown> | undefined, serviceTokenClientId: string) => {
  if (!claims) return "none";
  if (claims.email === OWNER_EMAIL) return "owner";
  if (!claims.email && !claims.sub && claims.common_name === serviceTokenClientId)
    return "service_token";
  return "other";
};

const describeCaller = async (request: Request, env: Env, ctx: ExecutionContext) => {
  const access = (ctx as ExecutionContext & { access?: AccessCtx }).access;
  let identity: unknown;
  try {
    identity = access ? await access.getIdentity() : "no ctx.access";
  } catch (e) {
    identity = `getIdentity threw: ${String(e)}`;
  }
  const assertion = await verifyAssertion(
    request.headers.get("cf-access-jwt-assertion"),
    access?.aud,
  );
  const claims = "claims" in assertion ? (assertion.claims as Record<string, unknown>) : undefined;
  return {
    role: env.ROLE,
    access: access ? { aud: access.aud } : null,
    identity,
    assertion,
    classifiedAs: classify(claims, env.SERVICE_TOKEN_CLIENT_ID),
    cookies: (request.headers.get("cookie") ?? "")
      .split(";")
      .map((c) => c.split("=")[0]?.trim())
      .filter(Boolean),
    accessHeaders: [...request.headers.keys()].filter((k) => k.startsWith("cf-access")),
  };
};

const makeServer = (record: (e: Record<string, unknown>) => void, caller: unknown) => {
  const server = new McpServer({ name: "cloudpid-probe-419", version: "0.0.1" });
  server.registerTool(
    "whoami",
    { description: "What Access forwarded for this request.", inputSchema: z.object({}) },
    async (_args, extra) => {
      const result = {
        caller,
        meta: extra.mcpReq._meta ?? null,
        envelope: extra.mcpReq.envelope ?? null,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    },
  );
  server.registerTool(
    "wait",
    {
      description: "Wait the given number of seconds (max 300), sending progress every 10 s.",
      inputSchema: z.object({ seconds: z.number().min(0).max(300) }),
    },
    async ({ seconds }, extra) => {
      const token = extra.mcpReq._meta?.progressToken;
      const started = Date.now();
      const id = crypto.randomUUID().slice(0, 8);
      record({ kind: "wait.start", id, seconds, progressToken: token ?? null });
      const sendProgress = async (elapsed: number) => {
        if (token === undefined) return;
        await extra.mcpReq.notify({
          method: "notifications/progress",
          params: {
            progressToken: token,
            progress: elapsed,
            total: seconds,
            message: `waited ${elapsed}s`,
          },
        });
      };
      let progressSent = 0;
      let aborted = false;
      try {
        await sendProgress(0);
        progressSent++;
        while ((Date.now() - started) / 1000 < seconds) {
          if (extra.mcpReq.signal.aborted) {
            aborted = true;
            break;
          }
          const left = seconds * 1000 - (Date.now() - started);
          await new Promise((r) => setTimeout(r, Math.min(10_000, left)));
          if ((Date.now() - started) / 1000 < seconds) {
            await sendProgress(Math.round((Date.now() - started) / 1000));
            progressSent++;
          }
        }
      } catch (e) {
        record({
          kind: "wait.error",
          id,
          error: String(e),
          elapsed: (Date.now() - started) / 1000,
        });
        throw e;
      }
      const elapsed = (Date.now() - started) / 1000;
      record({ kind: "wait.end", id, elapsed, progressSent, aborted });
      return {
        content: [
          {
            type: "text" as const,
            text: `waited ${elapsed}s (id ${id}, ${progressSent} progress)`,
          },
        ],
      };
    },
  );
  return server;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const store = env.STORE.get(env.STORE.idFromName("log"));
    const record = (e: Record<string, unknown>) => {
      const event = { t: new Date().toISOString(), ...e };
      console.log(JSON.stringify(event));
      ctx.waitUntil(store.add(event));
    };

    if (url.pathname === "/mcp/log") {
      if (request.method === "DELETE") {
        await store.clear();
        return new Response("cleared");
      }
      return Response.json(await store.list(Number(url.searchParams.get("since") ?? 0)));
    }

    const caller = await describeCaller(request, env, ctx);
    const base = {
      path: url.pathname,
      host: url.hostname,
      method: request.method,
      ua: request.headers.get("user-agent"),
      authorization: request.headers.get("authorization")?.split(" ")[0] ?? null,
      accept: request.headers.get("accept"),
      mcpProtocolVersion: request.headers.get("mcp-protocol-version"),
      mcpSessionId: request.headers.get("mcp-session-id"),
      colo: (request as Request & { cf?: { colo?: string } }).cf?.colo,
    };

    if (url.pathname === "/mcp") {
      let rpc: unknown;
      let parsedBody: unknown;
      if (request.method === "POST") {
        try {
          parsedBody = await request.clone().json();
          const msgs = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
          rpc = msgs.map((m: Record<string, any>) => ({
            method: m.method,
            id: m.id,
            protocolVersion: m.params?.protocolVersion,
            clientInfo: m.params?.clientInfo,
            capabilities: m.method === "initialize" ? m.params?.capabilities : undefined,
            tool: m.params?.name,
            args: m.params?.arguments,
            meta: m.params?._meta,
          }));
        } catch {
          rpc = "unparsable";
        }
      }
      record({
        kind: "mcp.request",
        ...base,
        rpc,
        classifiedAs: caller.classifiedAs,
        aud: caller.access?.aud ?? null,
        identity: caller.identity,
        claims: "claims" in caller.assertion ? caller.assertion.claims : null,
        checks: "checks" in caller.assertion ? caller.assertion.checks : null,
        accessHeaders: caller.accessHeaders,
        cookies: caller.cookies,
      });
      const handler = createMcpHandler(() => makeServer(record, caller), {
        route: "/mcp",
        legacy: "stateless",
        responseMode: "sse",
        keepAliveMs: 15_000,
        allowedHostnames: [url.hostname],
        onerror: (e) => record({ kind: "mcp.error", error: String(e) }),
      });
      const started = Date.now();
      const response = await handler(request, env, ctx);
      record({
        kind: "mcp.response",
        status: response.status,
        contentType: response.headers.get("content-type"),
        ms: Date.now() - started,
        rpc: Array.isArray(rpc) ? rpc.map((r: any) => r.method) : rpc,
      });
      return response;
    }

    record({ kind: "http.request", ...base, classifiedAs: caller.classifiedAs });
    return Response.json(caller, { headers: { "x-probe-path": url.pathname } });
  },
};
