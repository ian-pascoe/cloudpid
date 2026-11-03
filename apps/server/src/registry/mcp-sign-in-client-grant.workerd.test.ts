// A server that signs in on its own, over real Durable Object SQLite and a fake authorization server
// (`docs/architecture/mcp-sign-in.md` → Client Credentials, Telemetry and redaction): the token fetched on first use and
// again at `exp − 60 s` or after a 401, with a client secret (post or basic) or a `private_key_jwt` assertion; every
// failure `failed`, never a status an owner could answer with a sign-in; and that no secret, key, assertion or token
// reaches a span, a log, a row or an answer. workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so
// this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferSchemaOverJson:off schemaSync:off preferEffectRecord:off newPromise:off globalTimers:off globalDate:off
import type { McpSignInKey } from "@cloudpid/config";
import { type KeptVault, openKeptVault } from "@cloudpid/extensions/secrets/core";
import { type OAuthFetch } from "@cloudpid/mcp/oauth";
import { McpAccessTokenAnswer } from "@cloudpid/mcp/types";
import { DEFAULT_ENVIRONMENT } from "@cloudpid/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { describe, expect, it } from "vitest";
import { mcpClientGrant } from "./mcp-sign-in-client-grant.ts";
import { startMcpSignIn, type FlowDeps } from "./mcp-sign-in-flow.ts";
import {
  mcpAccessToken,
  reportMcpAuth,
  signInAskNotApplicable,
  signInTarget,
} from "./mcp-sign-in-registry.ts";
import { environmentsUsing } from "./mcp-sign-in-flow.ts";
import { MCP_OAUTH_PURPOSE, openTokens, sealTokens } from "./mcp-sign-in-seal.ts";
import { openMcpSignIns } from "./mcp-sign-ins.ts";
import { writeSettings } from "./settings.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { openRegistryStore } from "./store.ts";

const MASTER = "test-master-key-0123456789abcdef0123456789";
const NOW = 1_000_000;

const AS = "https://auth.example.com";
const SERVER_URL = "https://mcp.example.com/mcp";
const CLIENT_ID = "cloudpid-prod";
const SECRET = "client-secret-d41e8a";
const FIRST = "access-token-first-77ab";
const SECOND = "access-token-second-5b19";
const THIRD = "access-token-third-9c3d";

const STAGE = {
  origin: "https://cloudpid-server-pr-9.ian-g-pascoe.workers.dev",
  label: "pr-9",
  local: false,
  documentEnabled: true,
};

/** What a test does inside the token endpoint's answer, while a fetch is out. */
let hook: () => void = () => undefined;

/** A token fetched at `NOW` with a one-hour lifetime is in its last minute from here (a second for what the fetch took). */
const EXPIRING = NOW + 3_600_000 - 60_000 + 1000;

type Call = {
  readonly method: string;
  readonly url: string;
  readonly form: URLSearchParams;
  readonly headers: Headers;
};

type Handler = (call: Call, index: number) => Response | object | Promise<Response | object>;

const GRANT = {
  url: SERVER_URL,
  oauth: {
    grantType: "client_credentials",
    clientId: CLIENT_ID,
    clientSecret: "${CLIENT_SECRET}",
    issuer: AS,
  },
} as const;

const withOauth = (extra: Record<string, string>) => ({
  ...GRANT,
  oauth: { ...GRANT.oauth, ...extra },
});

const oauthError = (error: string, status = 400, description?: string): Response =>
  Response.json(description === undefined ? { error } : { error, error_description: description }, {
    status,
  });

const issued = (access: string, over: Record<string, string | number> = {}) => ({
  access_token: access,
  token_type: "Bearer",
  expires_in: 3600,
  ...over,
});

const metadata = (over: Record<string, string | ReadonlyArray<string>> = {}) => ({
  issuer: AS,
  authorization_endpoint: `${AS}/authorize`,
  token_endpoint: `${AS}/token`,
  response_types_supported: ["code"],
  token_endpoint_auth_methods_supported: ["client_secret_post", "private_key_jwt"],
  ...over,
});

/** A fake protected resource and authorization server: discovery, and `tokens` for each request to the token endpoint. */
const network = (
  tokens: Handler,
  asMetadata: Record<string, string | ReadonlyArray<string>> = {},
  revokeStatus = 200,
) => {
  const calls: Array<Call> = [];

  const fetch: OAuthFetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = await new Response(init?.body ?? null).text();

    const call: Call = {
      method,
      url: `${url.origin}${url.pathname}`,
      form: new URLSearchParams(body),
      headers: new Headers(init?.headers),
    };

    calls.push(call);

    const route = `${method} ${call.url}`;

    if (route === "GET https://mcp.example.com/.well-known/oauth-protected-resource/mcp") {
      return Response.json({
        resource: SERVER_URL,
        authorization_servers: [AS],
        scopes_supported: ["read", "write"],
      });
    }

    if (route === `GET ${AS}/.well-known/oauth-authorization-server`) {
      return Response.json(metadata(asMetadata));
    }

    if (route === `POST ${AS}/revoke`) {
      return revokeStatus === 200
        ? new Response(null, { status: 200 })
        : oauthError("unsupported_token_type", revokeStatus);
    }

    if (route === `POST ${AS}/token`) {
      const answer = await tokens(call, tokenCalls().length - 1);

      return answer instanceof Response ? answer : Response.json(answer);
    }

    return new Response("not found", { status: 404 });
  };

  const tokenCalls = () => calls.filter((call) => call.url === `${AS}/token`);

  return { fetch, calls, tokenCalls };
};

const run = <A>(
  tokens: Handler,
  body: (harness: Harness) => Promise<A>,
  options: {
    readonly asMetadata?: Record<string, string | ReadonlyArray<string>>;
    readonly secrets?: Record<string, string>;
    /** The status the revocation endpoint answers. */
    readonly revokeStatus?: number;
  } = {},
) =>
  runInDurableObject(
    env.REGISTRIES.get(env.REGISTRIES.newUniqueId()),
    async (_: TestRegistry, state) => {
      const store = openRegistryStore(state.storage);
      const signIns = openMcpSignIns(state.storage, store);
      const vault = await Effect.runPromise(openKeptVault(MASTER, MCP_OAUTH_PURPOSE));
      const net = network(tokens, options.asMetadata, options.revokeStatus);
      const spans: Array<Tracer.NativeSpan> = [];
      const logged: Array<string> = [];
      const secrets = { CLIENT_SECRET: SECRET, ...options.secrets };

      const tracer = Tracer.make({
        span(spanOptions) {
          const span = new Tracer.NativeSpan(spanOptions);

          spans.push(span);

          return span;
        },
      });

      const collector = Logger.make((entry) => {
        logged.push(`${JSON.stringify(entry.message)} ${Cause.pretty(entry.cause)}`);
      });

      const observed = <T>(effect: Effect.Effect<T>): Promise<T> =>
        Effect.runPromise(
          effect.pipe(
            Effect.provideService(Tracer.Tracer, tracer),
            Effect.provideService(Logger.CurrentLoggers, new Set([collector])),
          ),
        );

      const deps: FlowDeps = {
        store,
        signIns,
        vault: Effect.succeed(vault),
        fetch: net.fetch,
        sources: () => Effect.succeed({ secrets, variables: {} }),
      };

      const clientGrant = mcpClientGrant({ ...deps, retryMs: 0 });

      const keyOf = () => {
        const target = signInTarget(store, DEFAULT_ENVIRONMENT, "docs");

        if (target.status !== "client_grant")
          throw new Error(`Not a client grant: ${target.status}`);

        return target.key;
      };

      return body({
        store,
        signIns,
        vault,
        net,
        spans,
        logged,
        deps,
        setGlobal: (value) => {
          writeSettings(store, { mcp: { servers: { docs: value } } }, 5);
        },
        keyOf,
        ask: (input = {}, now = NOW) =>
          observed(
            mcpAccessToken(
              {
                store,
                signIns,
                vault: Effect.succeed(vault),
                clientGrant,
                environmentsUsing: (hash, kind) => environmentsUsing(store, hash, kind),
              },
              { environment: DEFAULT_ENVIRONMENT, server: "docs", ...input },
              now,
            ),
          ),
        observed,
        tokensOf: async () => {
          const row = signIns.get(keyOf().hash);

          if (row?.sealed === null || row === null) throw new Error("No tokens");

          return Effect.runPromise(openTokens(vault, keyOf().hash, row.sealed));
        },
        dump: () => JSON.stringify(state.storage.sql.exec("SELECT * FROM mcp_sign_ins").toArray()),
      });
    },
  );

type Harness = {
  readonly store: ReturnType<typeof openRegistryStore>;
  readonly signIns: ReturnType<typeof openMcpSignIns>;
  readonly vault: KeptVault;
  readonly net: ReturnType<typeof network>;
  readonly spans: Array<Tracer.NativeSpan>;
  readonly logged: Array<string>;
  readonly deps: FlowDeps;
  readonly setGlobal: (value: Schema.Json) => void;
  readonly keyOf: () => McpSignInKey;
  readonly ask: (
    input?: { stale?: string; environment?: string },
    now?: number,
  ) => Promise<McpAccessTokenAnswer>;
  readonly observed: <T>(effect: Effect.Effect<T>) => Promise<T>;
  readonly tokensOf: () => Promise<{ access_token: string; refresh_token?: string }>;
  readonly dump: () => string;
};

const isToken = Schema.is(McpAccessTokenAnswer.members[0]);

const okOf = (answer: McpAccessTokenAnswer) => {
  if (!isToken(answer)) throw new Error(`Not a token: ${JSON.stringify(answer)}`);

  return answer;
};

const failedWith = (answer: McpAccessTokenAnswer): string => {
  if (answer.status !== "failed" || !("reason" in answer)) {
    throw new Error(`Not failed: ${JSON.stringify(answer)}`);
  }

  return answer.reason;
};

describe("the first use", () => {
  it("gets a token with the secret in the body, seals it in a client_grant row with no refresh token, and asks for the resource and the scope", () =>
    run(
      () => issued(FIRST, { refresh_token: "refresh-nobody-wants-1", scope: "read" }),
      async ({ setGlobal, ask, signIns, keyOf, net, tokensOf, dump }) => {
        setGlobal(GRANT);

        const answer = okOf(await ask());

        expect(answer).toMatchObject({
          status: "ok",
          token: FIRST,
          resource: SERVER_URL,
          expiresAt: expect.any(Number),
        });
        expect(answer.expiresAt).toBeGreaterThanOrEqual(NOW + 3_600_000);

        const [call] = net.tokenCalls();

        expect(Object.fromEntries(call?.form ?? [])).toEqual({
          grant_type: "client_credentials",
          client_id: CLIENT_ID,
          client_secret: SECRET,
          resource: SERVER_URL,
          scope: "read write",
        });
        expect(call?.headers.has("authorization")).toBe(false);

        expect(signIns.get(keyOf().hash)).toMatchObject({
          status: "ok",
          issuer: AS,
          resource: SERVER_URL,
          scope: "read",
          hasTokens: true,
          client: {
            id: CLIENT_ID,
            kind: "client_grant",
            secretRef: { scope: "secret", name: "CLIENT_SECRET" },
          },
        });
        expect(await tokensOf()).toEqual({ access_token: FIRST });

        const rows = dump();

        for (const value of [FIRST, SECRET, "refresh-nobody-wants-1"]) {
          expect(rows).not.toContain(value);
        }
      },
    ));

  it("sends the secret as HTTP Basic when only client_secret_basic is listed", () =>
    run(
      () => issued(FIRST),
      async ({ setGlobal, ask, net }) => {
        setGlobal(GRANT);
        okOf(await ask());

        const [call] = net.tokenCalls();

        expect(call?.headers.get("authorization")).toBe(`Basic ${btoa(`${CLIENT_ID}:${SECRET}`)}`);
        expect(call?.form.has("client_id")).toBe(false);
        expect(call?.form.has("client_secret")).toBe(false);
      },
      { asMetadata: { token_endpoint_auth_methods_supported: ["client_secret_basic"] } },
    ));

  it("takes the configured scope over the protected resource's, and uses authServerMetadataUrl's issuer as the pin", () =>
    run(
      () => issued(FIRST),
      async ({ setGlobal, ask, net }) => {
        setGlobal({
          url: SERVER_URL,
          oauth: {
            grantType: "client_credentials",
            clientId: CLIENT_ID,
            clientSecret: "${CLIENT_SECRET}",
            authServerMetadataUrl: `${AS}/.well-known/oauth-authorization-server`,
            scope: "admin",
          },
        });

        okOf(await ask());
        expect(net.tokenCalls()[0]?.form.get("scope")).toBe("admin");
      },
    ));

  it("serves the sealed token while it stands, without a request", () =>
    run(
      () => issued(FIRST),
      async ({ setGlobal, ask, net }) => {
        setGlobal(GRANT);
        okOf(await ask());
        net.calls.length = 0;

        expect(okOf(await ask({}, NOW + 60_000)).token).toBe(FIRST);
        expect(okOf(await ask({}, NOW + 3_500_000)).token).toBe(FIRST);
        expect(net.calls).toHaveLength(0);
      },
    ));

  it("has one request in flight per sign-in, whoever asks", () =>
    run(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));

        return issued(FIRST);
      },
      async ({ setGlobal, ask, net }) => {
        setGlobal(GRANT);

        const answers = await Promise.all([ask(), ask(), ask()]);

        expect(answers.map((answer) => okOf(answer).token)).toEqual([FIRST, FIRST, FIRST]);
        expect(net.tokenCalls()).toHaveLength(1);
      },
    ));
});

describe("renewal", () => {
  it("fetches a new token in the last minute, keeping the grant id, and a later one the same way", () =>
    run(
      (_call, index) => issued([FIRST, SECOND, THIRD][index] ?? THIRD),
      async ({ setGlobal, ask, signIns, keyOf, spans }) => {
        setGlobal(GRANT);
        okOf(await ask());

        const grant = signIns.get(keyOf().hash)?.grantId;

        const renewed = okOf(await ask({}, EXPIRING));

        expect(renewed.token).toBe(SECOND);
        expect(renewed.signIn).toBe(grant);
        expect(signIns.get(keyOf().hash)?.grantId).toBe(grant);
        expect(okOf(await ask({}, EXPIRING + 3_600_000)).token).toBe(THIRD);

        const triggers = spans
          .filter(({ name }) => name === "mcp.oauth.client_credentials")
          .map(({ attributes }) => [attributes.get("mcp.trigger"), attributes.get("mcp.outcome")]);

        expect(triggers).toEqual([
          ["first", "fetched"],
          ["expiry", "fetched"],
          ["expiry", "fetched"],
        ]);
      },
    ));

  it("serves the old token while it stands when the renewal fails, and says failed once it does not", () =>
    run(
      (_call, index) => (index === 0 ? issued(FIRST) : oauthError("temporarily_unavailable", 503)),
      async ({ setGlobal, ask, net, signIns, keyOf }) => {
        setGlobal(GRANT);
        okOf(await ask());

        // In its last minute, and failing: the token that stands is used (after the one retry, a second later).
        expect(okOf(await ask({}, NOW + 3_598_000)).token).toBe(FIRST);
        expect(net.tokenCalls()).toHaveLength(3);
        expect(signIns.get(keyOf().hash)).toMatchObject({
          status: "ok",
          hasTokens: true,
          lastError: expect.stringContaining("temporarily_unavailable"),
        });

        // Past its time, within the 10 s the failure left: nothing is sent, and it is `failed`.
        expect(failedWith(await ask({}, NOW + 3_602_000))).toContain("temporarily_unavailable");
        expect(net.tokenCalls()).toHaveLength(3);
      },
    ));

  it("backs off 10 s, then doubles up to 5 min, and a success clears it", () =>
    run(
      (_call, index) => (index < 6 ? new Response("down", { status: 500 }) : issued(FIRST)),
      async ({ setGlobal, ask, net }) => {
        setGlobal(GRANT);

        const at = (offset: number) => NOW + offset;

        // Each failed fetch is two requests (the retry). The first fails at NOW: the next try is 10 s on.
        expect(failedWith(await ask({}, at(0)))).toContain("HTTP 500");
        expect(net.tokenCalls()).toHaveLength(2);

        await ask({}, at(9_000));
        expect(net.tokenCalls()).toHaveLength(2);

        // That one fails too, and doubles the wait: 20 s.
        await ask({}, at(10_500));
        expect(net.tokenCalls()).toHaveLength(4);

        await ask({}, at(29_000));
        expect(net.tokenCalls()).toHaveLength(4);

        // And 40 s, which then works.
        await ask({}, at(31_000));
        expect(net.tokenCalls()).toHaveLength(6);

        await ask({}, at(70_000));
        expect(net.tokenCalls()).toHaveLength(6);
        expect(okOf(await ask({}, at(72_000))).token).toBe(FIRST);
        expect(net.tokenCalls()).toHaveLength(7);
      },
    ));
});

describe("a token the server refused", () => {
  it("is replaced once, and handed over as it is when it is refused again", () =>
    run(
      (_call, index) => issued([FIRST, SECOND, THIRD][index] ?? THIRD),
      async ({ setGlobal, ask, net }) => {
        setGlobal(GRANT);
        expect(okOf(await ask()).token).toBe(FIRST);

        // A 401 at its first use: a new one.
        expect(okOf(await ask({ stale: FIRST }, NOW + 1000)).token).toBe(SECOND);
        expect(net.tokenCalls()).toHaveLength(2);

        // That one refused too: the same again, so the host's second 401 is the end; no third request.
        expect(okOf(await ask({ stale: SECOND }, NOW + 2000)).token).toBe(SECOND);
        expect(net.tokenCalls()).toHaveLength(2);
      },
    ));

  it("hands the current token to a host that asks with an older one", () =>
    run(
      (_call, index) => issued([FIRST, SECOND][index] ?? SECOND),
      async ({ setGlobal, ask, net }) => {
        setGlobal(GRANT);
        await ask();
        await ask({ stale: FIRST }, NOW + 1000);

        expect(okOf(await ask({ stale: FIRST }, NOW + 2000)).token).toBe(SECOND);
        expect(net.tokenCalls()).toHaveLength(2);
      },
    ));

  it("is asked for anew when it expires, whatever happened after a refusal", () =>
    run(
      (_call, index) => issued([FIRST, SECOND, THIRD][index] ?? THIRD),
      async ({ setGlobal, ask }) => {
        setGlobal(GRANT);
        await ask();
        await ask({ stale: FIRST }, NOW + 1000);

        expect(okOf(await ask({}, NOW + 1000 + 3_600_000)).token).toBe(THIRD);
      },
    ));
});

describe("failures are `failed`", () => {
  const notAnOwnersStatus = (answer: McpAccessTokenAnswer) =>
    expect(["required", "step_up", "rejected", "refresh_failing"]).not.toContain(answer.status);

  it("says the secret is not set, by its name, and sends nothing", () =>
    run(
      () => issued(FIRST),
      async ({ setGlobal, ask, net }) => {
        setGlobal(withOauth({ clientSecret: "${MISSING_SECRET}" }));

        const answer = await ask();

        notAnOwnersStatus(answer);
        expect(failedWith(answer)).toBe(
          "The client secret ${MISSING_SECRET} is not set as a Secret or a Variable",
        );
        expect(net.calls).toHaveLength(0);
      },
    ));

  it("refuses an authorization server that is not the issuer the entry pins", () =>
    run(
      () => issued(FIRST),
      async ({ setGlobal, ask }) => {
        setGlobal(withOauth({ issuer: "https://other.example.com" }));

        const answer = await ask();

        notAnOwnersStatus(answer);
        expect(failedWith(answer)).toMatch(/pins https:\/\/other\.example\.com/);
      },
    ));

  it("says what the authorization server refused: invalid_client with a pointer to the entry, never a sign-in", () =>
    run(
      () => oauthError("invalid_client", 401, "client authentication failed"),
      async ({ setGlobal, ask, net, signIns, keyOf, spans }) => {
        setGlobal(GRANT);

        const answer = await ask();

        notAnOwnersStatus(answer);
        expect(answer.status).toBe("failed");
        expect(failedWith(answer)).toContain("invalid_client");
        expect(failedWith(answer)).toContain("oauth settings");
        // A refusal is the server's answer, not a lost connection: no second request.
        expect(net.tokenCalls()).toHaveLength(1);
        expect(signIns.get(keyOf().hash)).toBeNull();

        const span = spans.find(({ name }) => name === "mcp.oauth.client_credentials");

        expect(span?.attributes.get("mcp.oauth_error")).toBe("invalid_client");
        expect(span?.attributes.get("http.status_code")).toBe(401);
        expect(span?.attributes.get("mcp.outcome")).toBe("failed");
      },
    ));

  it("retries a 5xx once, then fails", () =>
    run(
      () => new Response("down", { status: 502 }),
      async ({ setGlobal, ask, net }) => {
        setGlobal(GRANT);

        expect(failedWith(await ask())).toBe("The authorization server answered HTTP 502");
        expect(net.tokenCalls()).toHaveLength(2);
      },
    ));

  it("scrubs a secret the server echoes from the reason, and keeps it out of spans, logs and rows", () =>
    run(
      (_call, index) =>
        index === 0 ? issued(FIRST) : oauthError("invalid_request", 400, `bad ${SECRET} in it`),
      async ({ setGlobal, ask, spans, logged, dump }) => {
        setGlobal(GRANT);
        okOf(await ask());

        // Its last minute, and the server turns the token request away with the secret in its description.
        const answer = await ask({}, EXPIRING);

        // The old token still stands, so it is served; and the row's last error is the scrubbed text.
        okOf(answer);

        const row = dump();

        const recorded = JSON.stringify(
          spans.map(({ name, attributes, events }) => [name, [...attributes], events]),
        );

        expect(row).toContain("[REDACTED]");

        for (const value of [SECRET, FIRST]) {
          expect(row).not.toContain(value);
          expect(recorded).not.toContain(value);
          expect(logged.join("\n")).not.toContain(value);
        }
      },
    ));
});

describe("private_key_jwt", () => {
  const generate = async (algorithm: "RS256" | "ES256") => {
    const params =
      algorithm === "RS256"
        ? {
            name: "RSASSA-PKCS1-v1_5",
            modulusLength: 2048,
            publicExponent: new Uint8Array([1, 0, 1]),
            hash: "SHA-256",
          }
        : { name: "ECDSA", namedCurve: "P-256" };

    // SAFETY: an RSA or EC `generateKey` returns a key pair.
    const pair = (await crypto.subtle.generateKey(params, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;

    const der = await crypto.subtle.exportKey("pkcs8", pair.privateKey);

    if (!(der instanceof ArrayBuffer)) throw new Error("pkcs8 exports bytes");

    const lines = btoa(String.fromCharCode(...new Uint8Array(der))).match(/.{1,64}/g) ?? [];

    return {
      pem: `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`,
      publicKey: pair.publicKey,
      params,
    };
  };

  const decoder = new TextDecoder();

  const partsOf = (jws: string) => {
    const [header = "", payload = "", signature = ""] = jws.split(".");

    const bytes = (text: string) =>
      Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

    return {
      header: decoder.decode(bytes(header)),
      payload: decoder.decode(bytes(payload)),
      signature: bytes(signature),
      signingInput: `${header}.${payload}`,
    };
  };

  it.each(["RS256", "ES256"] as const)(
    "signs the assertion %s with the claims of the spec, sends it without client_id, and a new one each time",
    async (algorithm) => {
      const key = await generate(algorithm);

      await run(
        (_call, index) => issued([FIRST, SECOND][index] ?? SECOND),
        async ({ setGlobal, ask, net, spans, logged, dump }) => {
          setGlobal({
            url: SERVER_URL,
            oauth: {
              grantType: "client_credentials",
              clientId: CLIENT_ID,
              privateKey: "${CLIENT_KEY}",
              keyId: "key-2026",
              issuer: AS,
            },
          });

          const before = Math.floor(Date.now() / 1000);

          okOf(await ask());
          okOf(await ask({}, EXPIRING));

          const [first, second] = net.tokenCalls();
          const form = first?.form ?? new URLSearchParams();

          expect([...form.keys()].sort()).toEqual([
            "client_assertion",
            "client_assertion_type",
            "grant_type",
            "resource",
            "scope",
          ]);
          expect(form.get("client_assertion_type")).toBe(
            "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
          );
          expect(form.get("grant_type")).toBe("client_credentials");
          expect(first?.headers.has("authorization")).toBe(false);

          const parts = partsOf(form.get("client_assertion") ?? "");
          const header = JSON.parse(parts.header);
          const claims = JSON.parse(parts.payload);

          expect(header).toEqual({ alg: algorithm, typ: "JWT", kid: "key-2026" });
          expect(Object.keys(claims)).toEqual(["iss", "sub", "aud", "iat", "exp", "jti"]);
          expect(claims).toMatchObject({ iss: CLIENT_ID, sub: CLIENT_ID, aud: `${AS}/token` });
          expect(claims.iat).toBeGreaterThanOrEqual(before);
          expect(claims.exp - claims.iat).toBe(60);
          expect(claims.jti).toMatch(/^[0-9a-f]{32}$/);

          expect(
            await crypto.subtle.verify(
              algorithm === "RS256" ? "RSASSA-PKCS1-v1_5" : { name: "ECDSA", hash: "SHA-256" },
              key.publicKey,
              parts.signature,
              new TextEncoder().encode(parts.signingInput),
            ),
          ).toBe(true);

          const another = JSON.parse(partsOf(second?.form.get("client_assertion") ?? "").payload);

          expect(another.jti).not.toBe(claims.jti);

          const recorded = JSON.stringify(
            spans.map(({ name, attributes, events }) => [name, [...attributes], events]),
          );

          for (const value of [
            form.get("client_assertion") ?? "",
            key.pem,
            key.pem.split("\n")[1] ?? "",
            FIRST,
          ]) {
            expect(recorded).not.toContain(value);
            expect(logged.join("\n")).not.toContain(value);
            expect(dump()).not.toContain(value);
          }

          expect(
            spans
              .find(({ name }) => name === "mcp.oauth.client_credentials")
              ?.attributes.get("mcp.auth_method"),
          ).toBe("private_key_jwt");
        },
        { secrets: { CLIENT_KEY: key.pem } },
      );
    },
  );

  it("fails, with a problem that never quotes the key, for a key that cannot sign", () =>
    run(
      () => issued(FIRST),
      async ({ setGlobal, ask, net, spans, logged }) => {
        setGlobal({
          url: SERVER_URL,
          oauth: {
            grantType: "client_credentials",
            clientId: CLIENT_ID,
            privateKey: "${CLIENT_KEY}",
            issuer: AS,
          },
        });

        const answer = await ask();

        expect(answer.status).toBe("failed");
        expect(failedWith(answer)).toMatch(/PKCS#8/);
        expect(failedWith(answer)).not.toContain("TOPSECRETKEYBODY");
        expect(net.tokenCalls()).toHaveLength(0);

        const recorded = JSON.stringify(
          spans.map(({ name, attributes }) => [name, [...attributes]]),
        );

        expect(recorded).not.toContain("TOPSECRETKEYBODY");
        expect(logged.join("\n")).not.toContain("TOPSECRETKEYBODY");
      },
      {
        secrets: {
          CLIENT_KEY:
            "-----BEGIN RSA PRIVATE KEY-----\nTOPSECRETKEYBODY\n-----END RSA PRIVATE KEY-----",
        },
      },
    ));
});

describe("when the entry changes", () => {
  it("asks anew, as a new sign-in, for a changed client id or scope, and not for a changed secret", () =>
    run(
      (_call, index) => issued([FIRST, SECOND, THIRD, "access-token-fourth-1"][index] ?? THIRD),
      async ({ setGlobal, ask, net, signIns, keyOf }) => {
        setGlobal(GRANT);
        okOf(await ask());

        const grant = signIns.get(keyOf().hash)?.grantId;

        // A changed secret reference keeps the token: it was issued to the same client.
        setGlobal(withOauth({ clientSecret: "${OTHER_SECRET}" }));
        expect(okOf(await ask({}, NOW + 1000)).token).toBe(FIRST);

        setGlobal(withOauth({ clientId: "another-client" }));

        const other = okOf(await ask({}, NOW + 2000));

        expect(other.token).toBe(SECOND);
        expect(other.signIn).not.toBe(grant);
        expect(net.tokenCalls()[1]?.form.get("client_id")).toBe("another-client");

        setGlobal(withOauth({ clientId: "another-client", scope: "admin" }));
        expect(okOf(await ask({}, NOW + 3000)).token).toBe(THIRD);
        expect(net.tokenCalls()[2]?.form.get("scope")).toBe("admin");
      },
      { secrets: { OTHER_SECRET: "other-secret-value-1" } },
    ));

  it("is `required` for an entry that signs in with a code now, whatever token the old grant left", () =>
    run(
      () => issued(FIRST),
      async ({ setGlobal, ask, net }) => {
        setGlobal(GRANT);
        okOf(await ask());

        setGlobal({ url: SERVER_URL });
        net.calls.length = 0;

        expect(await ask({}, NOW + 1000)).toEqual({ status: "required", reason: "Not signed in" });
        expect(net.calls).toHaveLength(0);
      },
    ));

  it("deletes the client grant's row when the entry signs in with a code now, and raises the revision", () =>
    run(
      () => issued(FIRST),
      async ({ setGlobal, ask, signIns, keyOf }) => {
        setGlobal(GRANT);
        okOf(await ask());

        const before = signIns.revision();
        const { hash } = keyOf();

        setGlobal({ url: SERVER_URL });
        await ask({}, NOW + 1000);

        expect(signIns.get(hash)).toBeNull();
        expect(signIns.revision()).toBeGreaterThan(before);
      },
    ));

  it("makes the row's secret reference follow the entry at the next fetch, and keeps the token until then", () =>
    run(
      (_call, index) => issued(index === 0 ? FIRST : SECOND),
      async ({ setGlobal, ask, signIns, keyOf }) => {
        setGlobal(GRANT);
        okOf(await ask());

        setGlobal(withOauth({ clientSecret: "${OTHER_SECRET}" }));
        expect(okOf(await ask({}, NOW + 1000)).token).toBe(FIRST);
        expect(signIns.get(keyOf().hash)?.client?.secretRef).toEqual({
          scope: "secret",
          name: "CLIENT_SECRET",
        });

        expect(okOf(await ask({}, EXPIRING)).token).toBe(SECOND);
        expect(signIns.get(keyOf().hash)?.client?.secretRef).toEqual({
          scope: "secret",
          name: "OTHER_SECRET",
        });
      },
      { secrets: { OTHER_SECRET: "other-secret-value-1" } },
    ));

  it("holds a setup problem for the first backoff, so the authorization server is not discovered on every ask", () =>
    run(
      () => issued(FIRST),
      async ({ setGlobal, ask, net }) => {
        setGlobal({
          url: SERVER_URL,
          oauth: {
            grantType: "client_credentials",
            clientId: CLIENT_ID,
            privateKey: "${CLIENT_KEY}",
            issuer: AS,
          },
        });

        const discoveries = () => net.calls.filter((call) => call.method === "GET").length;

        expect(failedWith(await ask({}, NOW))).toMatch(/PKCS#8/);

        const first = discoveries();

        expect(first).toBeGreaterThan(0);

        // Within the hold, the same answer and no request; after it, the setup is looked at again.
        expect(failedWith(await ask({}, NOW + 5_000))).toMatch(/PKCS#8/);
        expect(discoveries()).toBe(first);
        expect(failedWith(await ask({}, NOW + 11_000))).toMatch(/PKCS#8/);
        expect(discoveries()).toBeGreaterThan(first);
      },
      {
        secrets: {
          CLIENT_KEY: "-----BEGIN RSA PRIVATE KEY-----\nBODY\n-----END RSA PRIVATE KEY-----",
        },
      },
    ));
});

/** An owner's sign-in of `docs`' key, as an authorization-code flow left it: configured client, with a refresh token. */
const ownerSignIn = async (
  h: Harness,
  options: {
    readonly key?: McpSignInKey;
    readonly clientId?: string;
    readonly revocation?: boolean;
  } = {},
) => {
  const key = options.key ?? h.keyOf();

  const sealed = await Effect.runPromise(
    sealTokens(h.vault, key.hash, {
      access_token: "owner-access-token-1",
      refresh_token: "owner-refresh-token-1",
    }),
  );

  if (sealed.status !== "sealed") throw new Error("too large");

  h.signIns.put(
    {
      key,
      status: "ok",
      issuer: AS,
      metadata: JSON.stringify(
        options.revocation === false
          ? metadata()
          : metadata({ revocation_endpoint: `${AS}/revoke` }),
      ),
      discovery: "{}",
      resource: SERVER_URL,
      client: {
        id: options.clientId ?? CLIENT_ID,
        kind: "configured",
        secretRef: { scope: "secret", name: "CLIENT_SECRET" },
        registration: null,
      },
      scope: "read",
      expiresAt: NOW + 3_600_000,
      wantedScope: null,
      stepUpCount: 0,
      sealed: sealed.sealed,
    },
    NOW,
  );
};

describe("switching from a code sign-in to a client grant", () => {
  it("revokes the owner's refresh token, then their access token, drops the row, and fetches the first token", () =>
    run(
      () => issued(FIRST),
      async (h) => {
        // The key does not depend on the grant type: the owner's row stands under the client grant's key.
        h.setGlobal(GRANT);
        await ownerSignIn(h);

        const owner = h.signIns.get(h.keyOf().hash)?.grantId;

        expect(okOf(await h.ask()).token).toBe(FIRST);

        const revocations = h.net.calls.filter((call) => call.url === `${AS}/revoke`);

        expect(revocations.map((call) => call.form.get("token"))).toEqual([
          "owner-refresh-token-1",
          "owner-access-token-1",
        ]);
        expect(revocations.map((call) => call.form.get("token_type_hint"))).toEqual([
          "refresh_token",
          "access_token",
        ]);

        const row = h.signIns.get(h.keyOf().hash);

        expect(row?.grantId).not.toBe(owner);
        expect(row?.client?.kind).toBe("client_grant");
        expect(await h.tokensOf()).toEqual({ access_token: FIRST });
        expect(h.dump()).not.toContain("owner-refresh-token-1");
      },
      { asMetadata: { revocation_endpoint: `${AS}/revoke` } },
    ));

  const revokeOutcome = (spans: ReadonlyArray<Tracer.NativeSpan>) =>
    spans.find((span) => span.name === "mcp.oauth.revoke")?.attributes.get("mcp.outcome");

  it("drops the row and goes on when the server refuses the revocation, and says so in the log and on the new row", () =>
    run(
      () => issued(FIRST),
      async (h) => {
        h.setGlobal(GRANT);
        await ownerSignIn(h);

        expect(okOf(await h.ask()).token).toBe(FIRST);
        expect(h.signIns.get(h.keyOf().hash)).toMatchObject({
          status: "ok",
          client: { kind: "client_grant" },
          lastError: expect.stringMatching(/did not revoke its refresh token.*access token/),
        });
        expect(revokeOutcome(h.spans)).toBe("revocation_failed");
        expect(h.logged.join("\n")).toMatch(/did not revoke/);

        // Neither the token nor the reason's detail leaks: only the kinds of token and the code.
        for (const value of ["owner-refresh-token-1", "owner-access-token-1"]) {
          expect(h.logged.join("\n")).not.toContain(value);
          expect(h.dump()).not.toContain(value);
        }

        // The first renewal clears the note.
        expect(okOf(await h.ask({}, EXPIRING)).token).toBe(FIRST);
        expect(h.signIns.get(h.keyOf().hash)?.lastError).toBeNull();
      },
      { revokeStatus: 400 },
    ));

  it("revokes as a public client when the old client's secret no longer resolves, with only its id", () =>
    run(
      () => issued(FIRST),
      async (h) => {
        h.setGlobal(GRANT);
        // The entry's client is another one now: the old client's secret cannot be found from it.
        await ownerSignIn(h, { clientId: "old-client" });

        expect(okOf(await h.ask()).token).toBe(FIRST);

        const revocations = h.net.calls.filter((call) => call.url === `${AS}/revoke`);

        expect(revocations).toHaveLength(2);

        for (const call of revocations) {
          expect(call.form.get("client_id")).toBe("old-client");
          expect(call.form.has("client_secret")).toBe(false);
          expect(call.headers.has("authorization")).toBe(false);
        }

        expect(revokeOutcome(h.spans)).toBe("revoked");
      },
    ));

  it("says nothing of revocation when the server advertises no endpoint, and still switches", () =>
    run(
      () => issued(FIRST),
      async (h) => {
        h.setGlobal(GRANT);
        await ownerSignIn(h, { revocation: false });

        expect(okOf(await h.ask()).token).toBe(FIRST);
        expect(h.net.calls.some((call) => call.url === `${AS}/revoke`)).toBe(false);
        expect(revokeOutcome(h.spans)).toBe("no_revocation_endpoint");
        expect(h.signIns.get(h.keyOf().hash)).toMatchObject({
          client: { kind: "client_grant" },
          lastError: null,
        });
      },
    ));
});

describe("two Environments whose entries of one name sign in differently", () => {
  /** Global's `docs` is a code entry, and Environment `env-a` overrides it with a client grant. */
  const split = (h: Harness) => {
    h.setGlobal({ url: SERVER_URL });
    h.store.createEnvironment("env-a", "Env A", 1);
    h.store.putSettingsOverrides("env-a", { mcp: { servers: { docs: GRANT } } });

    const target = signInTarget(h.store, "env-a", "docs");
    const shared = signInTarget(h.store, DEFAULT_ENVIRONMENT, "docs");

    if (target.status !== "client_grant" || shared.status !== "target") {
      throw new Error(`Not split: ${target.status} ${shared.status}`);
    }

    return target.key;
  };

  it("leaves the owner's live sign-in alone, and tells the client grant's Environment of the clash", () =>
    run(
      () => issued(FIRST),
      async (h) => {
        const key = split(h);

        await ownerSignIn(h, { key });

        const owner = h.signIns.get(key.hash);
        const revision = h.signIns.revision();

        const answer = await h.ask({ environment: "env-a" });

        expect(failedWith(answer)).toMatch(/uses this server's sign-in as the owner's own/);
        expect(failedWith(answer)).toMatch(/rename one of the entries/);
        expect(h.net.calls).toHaveLength(0);
        expect(h.signIns.get(key.hash)?.grantId).toBe(owner?.grantId);
        expect(h.signIns.revision()).toBe(revision);

        // And the owner's Environment still gets its own token, as many times as the other asks.
        const mine = await h.ask({ environment: DEFAULT_ENVIRONMENT }, NOW + 1000);

        expect(okOf(mine).token).toBe("owner-access-token-1");
        expect(failedWith(await h.ask({ environment: "env-a" }, NOW + 2000))).toMatch(/rename/);
        expect(h.signIns.revision()).toBe(revision);
      },
    ));

  it("leaves the client grant's row alone, and tells the code entry's Environment of the clash", () =>
    run(
      () => issued(FIRST),
      async (h) => {
        const key = split(h);

        expect(okOf(await h.ask({ environment: "env-a" })).token).toBe(FIRST);

        const grant = h.signIns.get(key.hash);
        const revision = h.signIns.revision();

        const answer = await h.ask({ environment: DEFAULT_ENVIRONMENT }, NOW + 1000);

        expect(failedWith(answer)).toMatch(/with client credentials/);
        expect(h.signIns.get(key.hash)?.grantId).toBe(grant?.grantId);
        expect(h.signIns.revision()).toBe(revision);

        // The client grant's Environment keeps its token.
        expect(okOf(await h.ask({ environment: "env-a" }, NOW + 2000)).token).toBe(FIRST);
      },
    ));

  it("switches as before once no other Environment uses the row's kind", () =>
    run(
      () => issued(FIRST),
      async (h) => {
        const key = split(h);

        await ownerSignIn(h, { key });

        // Every Environment now has the client grant.
        h.setGlobal(GRANT);
        h.store.putSettingsOverrides("env-a", {});

        expect(okOf(await h.ask({ environment: "env-a" })).token).toBe(FIRST);
        expect(h.signIns.get(key.hash)?.client?.kind).toBe("client_grant");
      },
    ));
});

describe("a fetch the entry or another sign-in overtook", () => {
  it("writes nothing and says failed when the entry stopped signing in on its own while the token was out", () =>
    run(
      () => {
        hook();

        return issued(FIRST);
      },
      async ({ setGlobal, ask, signIns, keyOf }) => {
        hook = () => undefined;
        setGlobal(GRANT);

        const { hash } = keyOf();

        hook = () => setGlobal({ url: SERVER_URL });

        expect(failedWith(await ask())).toMatch(/entry changed/);
        expect(signIns.get(hash)).toBeNull();
      },
    ));

  it("writes nothing and hands over the row's own token when another fetch stored one meanwhile", () =>
    run(
      () => {
        hook();

        return issued(FIRST);
      },
      async ({ setGlobal, ask, signIns, keyOf, vault }) => {
        hook = () => undefined;
        setGlobal(GRANT);

        const other = await Effect.runPromise(
          sealTokens(vault, keyOf().hash, { access_token: "other-flight-token-1" }),
        );

        if (other.status !== "sealed") throw new Error("too large");

        hook = () => {
          signIns.put(
            {
              key: keyOf(),
              status: "ok",
              issuer: AS,
              metadata: JSON.stringify(metadata()),
              discovery: JSON.stringify({
                authorizationServerUrl: AS,
                grant: { issuer: AS },
              }),
              resource: SERVER_URL,
              client: { id: CLIENT_ID, kind: "client_grant", secretRef: null, registration: null },
              scope: null,
              expiresAt: NOW + 3_600_000,
              wantedScope: null,
              stepUpCount: 0,
              sealed: other.sealed,
            },
            NOW,
          );
        };

        const answer = okOf(await ask());

        expect(answer.token).toBe("other-flight-token-1");
        expect(signIns.get(keyOf().hash)?.sealed).toEqual(other.sealed);
      },
    ));

  it("does not write a token over a row that was removed while a renewal was out", () =>
    run(
      () => {
        hook();

        return issued(SECOND);
      },
      async ({ setGlobal, ask, signIns, keyOf }) => {
        hook = () => undefined;
        setGlobal(GRANT);
        okOf(await ask());
        hook = () => {
          signIns.delete(keyOf().hash, NOW + 10);
        };

        expect(failedWith(await ask({}, EXPIRING))).toMatch(/sign-in changed/);
        expect(signIns.get(keyOf().hash)).toBeNull();
      },
    ));
});

describe("which Environments use a sign-in", () => {
  it("counts a client grant's entries for a client grant's row, and an owner's for an owner's", () =>
    run(
      () => issued(FIRST),
      async ({ setGlobal, store, keyOf }) => {
        setGlobal(GRANT);

        const { hash } = keyOf();

        expect(environmentsUsing(store, hash, "client_grant").length).toBeGreaterThan(0);
        expect(environmentsUsing(store, hash, "owner")).toEqual([]);

        setGlobal({ url: SERVER_URL });
        expect(environmentsUsing(store, hash, "client_grant")).toEqual([]);
        expect(environmentsUsing(store, hash, "owner").length).toBeGreaterThan(0);
      },
    ));
});

describe("no owner sign-in", () => {
  it("answers not_applicable to mcp_sign_in_ask, refuses a start, and ignores every report", () =>
    run(
      () => issued(FIRST),
      async ({ setGlobal, store, signIns, deps, observed }) => {
        setGlobal(GRANT);

        const target = signInTarget(store, DEFAULT_ENVIRONMENT, "docs");

        expect(target.status).toBe("client_grant");
        expect(signInAskNotApplicable(target)).toMatch(/signs in on its own/);

        // The other kinds of server that have no owner sign-in answer the same; one that has answers nothing.
        setGlobal({ command: "node" });
        expect(signInAskNotApplicable(signInTarget(store, DEFAULT_ENVIRONMENT, "docs"))).toMatch(
          /Only an HTTP server/,
        );
        setGlobal({ url: SERVER_URL });
        expect(
          signInAskNotApplicable(signInTarget(store, DEFAULT_ENVIRONMENT, "docs")),
        ).toBeUndefined();

        setGlobal(GRANT);

        const started = await observed(
          startMcpSignIn(
            deps,
            { environment: DEFAULT_ENVIRONMENT, server: "docs", stage: STAGE },
            NOW,
          ),
        );

        expect(started).toMatchObject({
          status: "problem",
          message: expect.stringMatching(/on its own/),
        });

        for (const event of ["needs_sign_in", "step_up", "rejected", "working"]) {
          expect(
            reportMcpAuth(
              { store, signIns },
              { environment: DEFAULT_ENVIRONMENT, server: "docs", event },
              NOW,
            ),
          ).toMatchObject({ status: "ignored", reason: expect.stringMatching(/on its own/) });
        }
      },
    ));
});
