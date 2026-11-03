// Refreshing an MCP sign-in over real Durable Object SQLite and a fake authorization server (`docs/architecture/mcp-sign-in.md`
// → Tokens reach the host object, Refresh and step-up, Telemetry and redaction): the rotation race, what each answer of the
// authorization server comes to (per kind of client), the retry and the backoff, the step-up count, and that no token reaches a
// span or a log. A sign-in is made by the real start and callback, so the row is what a refresh finds in production.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferSchemaOverJson:off schemaSync:off preferEffectRecord:off
import { type KeptVault, openKeptVault } from "@cloudpid/extensions/secrets/core";
import type { OAuthFetch } from "@cloudpid/mcp/oauth";
import type {
  McpAccessTokenAnswer,
  McpAuthChallenge,
  McpSignInCompleteAnswer,
} from "@cloudpid/mcp/types";
import { DEFAULT_ENVIRONMENT } from "@cloudpid/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { describe, expect, it } from "vitest";
import { completeMcpSignIn, type FlowDeps, startMcpSignIn } from "./mcp-sign-in-flow.ts";
import { mcpTokenRefresh, MAX_REFRESH_BACKOFF_MS } from "./mcp-sign-in-refresh.ts";
import { mcpAccessToken, reportMcpAuth, signInTarget } from "./mcp-sign-in-registry.ts";
import { MCP_OAUTH_PURPOSE, openTokens } from "./mcp-sign-in-seal.ts";
import { type McpSignIns, openMcpSignIns } from "./mcp-sign-ins.ts";
import { writeSettings } from "./settings.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { openRegistryStore } from "./store.ts";

const MASTER = "test-master-key-0123456789abcdef0123456789";
const NOW = 1_000_000;
const SIGNED_IN_AT = NOW + 1000;

const AS = "https://auth.example.com";
const SERVER_URL = "https://mcp.sentry.dev/mcp";
const ORIGIN = "https://cloudpid-server-pr-9.ian-g-pascoe.workers.dev";
const ACCESS = "access-token-77ab";
const REFRESH = "refresh-token-9f2c";
const NEW_ACCESS = "access-token-new-31de";
const NEW_REFRESH = "refresh-token-new-8a40";
const SECRET = "client-secret-d41e";

const STAGE = { origin: ORIGIN, label: "pr-9", local: false, documentEnabled: true };

/** When the access token of a sign-in made at `SIGNED_IN_AT` is at its last minute. */
const EXPIRING = SIGNED_IN_AT + 3_600_000 - 60_000;

type Call = {
  readonly method: string;
  readonly url: string;
  readonly form: URLSearchParams;
};

type Handler = (call: Call) => Response | Schema.Json | Promise<Response | Schema.Json>;

const metadata = (over: Record<string, Schema.Json> = {}) => ({
  issuer: AS,
  authorization_endpoint: `${AS}/authorize`,
  token_endpoint: `${AS}/token`,
  registration_endpoint: `${AS}/register`,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
  scopes_supported: ["read", "write", "offline_access"],
  ...over,
});

const oauthError = (error: string, status = 400, description?: string): Response =>
  new Response(
    JSON.stringify(
      description === undefined ? { error } : { error, error_description: description },
    ),
    { status, headers: { "content-type": "application/json" } },
  );

const tokenAnswer = (over: Record<string, Schema.Json> = {}) => ({
  access_token: NEW_ACCESS,
  token_type: "Bearer",
  expires_in: 1800,
  ...over,
});

/** A fake authorization server: discovery, registration, the code exchange, and `tokens`, which answers each refresh. */
const network = (tokens: Handler, asMetadata: Record<string, Schema.Json> = {}) => {
  const calls: Array<Call> = [];

  const fetch: OAuthFetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = await new Response(init?.body ?? null).text();

    const call: Call = {
      method,
      url: `${url.origin}${url.pathname}`,
      form: new URLSearchParams(body),
    };

    const route = `${method} ${call.url}`;

    calls.push(call);

    if (route === "GET https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp") {
      return Response.json({ resource: SERVER_URL, authorization_servers: [AS] });
    }

    if (route === `GET ${AS}/.well-known/oauth-authorization-server`) {
      return Response.json(metadata(asMetadata));
    }

    if (route === `POST ${AS}/register`) {
      return Response.json({ client_id: "registered-client-1" }, { status: 201 });
    }

    if (route === `POST ${AS}/token`) {
      // The first request is the callback's code exchange; the rest are the refreshes under test.
      if (call.form.get("grant_type") === "authorization_code") {
        return Response.json({
          access_token: ACCESS,
          token_type: "Bearer",
          refresh_token: REFRESH,
          expires_in: 3600,
          scope: "read",
        });
      }

      const answer = await tokens(call);

      return answer instanceof Response ? answer : Response.json(answer);
    }

    return new Response("not found", { status: 404 });
  };

  return {
    fetch,
    calls,
    refreshes: () => calls.filter((call) => call.form.get("grant_type") === "refresh_token"),
  };
};

type Harness = {
  readonly signIns: McpSignIns;
  readonly vault: KeptVault;
  readonly net: ReturnType<typeof network>;
  readonly spans: Array<Tracer.NativeSpan>;
  readonly logged: Array<string>;
  readonly setGlobal: (value: Schema.Json) => void;
  readonly keyHash: (name: string) => string;
  /** Sign in as the entry's client: the real start, then the real callback. */
  readonly signIn: (stepUp?: boolean) => Promise<McpSignInCompleteAnswer>;
  readonly ask: (input?: { stale?: string }, now?: number) => Promise<McpAccessTokenAnswer>;
  readonly report: (
    event: "step_up" | "rejected" | "working",
    challenge?: McpAuthChallenge,
    now?: number,
  ) => void;
  readonly tokensOf: (name: string) => Promise<{ access_token: string; refresh_token?: string }>;
};

const run = <A>(
  tokens: Handler,
  body: (harness: Harness) => Promise<A>,
  options: {
    readonly asMetadata?: Record<string, Schema.Json>;
    readonly secrets?: Record<string, string>;
  } = {},
) =>
  runInDurableObject(
    env.REGISTRIES.get(env.REGISTRIES.newUniqueId()),
    async (_: TestRegistry, state) => {
      const store = openRegistryStore(state.storage);
      const signIns = openMcpSignIns(state.storage, store);
      const vault = await Effect.runPromise(openKeptVault(MASTER, MCP_OAUTH_PURPOSE));
      const net = network(tokens, options.asMetadata);
      const spans: Array<Tracer.NativeSpan> = [];
      const logged: Array<string> = [];

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
        sources: () => Effect.succeed({ secrets: options.secrets ?? {}, variables: {} }),
      };

      const refresh = mcpTokenRefresh({ ...deps, retryMs: 0 });

      const keyHash = (name: string): string => {
        const target = signInTarget(store, DEFAULT_ENVIRONMENT, name);

        if (target.status !== "target") throw new Error(`No sign-in for ${name}`);

        return target.key.hash;
      };

      const signIn: Harness["signIn"] = async (stepUp = false) => {
        const started = await observed(
          startMcpSignIn(
            deps,
            { environment: DEFAULT_ENVIRONMENT, server: "sentry", stage: STAGE, stepUp },
            NOW,
          ),
        );

        const url =
          "confirmation" in started && started.status === "confirm"
            ? undefined
            : "url" in started
              ? new URL(started.url)
              : undefined;

        if (url === undefined) throw new Error(`Not started: ${started.status}`);

        return observed(
          completeMcpSignIn(
            deps,
            {
              state: url.searchParams.get("state") ?? "",
              path: "/oauth/mcp/callback",
              code: "authorization-code-7c2e",
              iss: AS,
            },
            SIGNED_IN_AT,
          ),
        );
      };

      return body({
        signIns,
        vault,
        net,
        spans,
        logged,
        setGlobal: (value) => {
          writeSettings(store, { mcp: { servers: value } }, 5);
        },
        keyHash,
        signIn,
        ask: (input = {}, now = SIGNED_IN_AT) =>
          observed(
            mcpAccessToken(
              { store, signIns, vault: Effect.succeed(vault), refresh },
              { environment: DEFAULT_ENVIRONMENT, server: "sentry", ...input },
              now,
            ),
          ),
        report: (event, challenge, now = SIGNED_IN_AT) => {
          reportMcpAuth(
            { store, signIns },
            challenge === undefined
              ? { environment: DEFAULT_ENVIRONMENT, server: "sentry", event }
              : { environment: DEFAULT_ENVIRONMENT, server: "sentry", event, challenge },
            now,
          );
        },
        tokensOf: async (name) => {
          const row = signIns.get(keyHash(name));

          if (row?.sealed === null || row === null) throw new Error("No tokens");

          return Effect.runPromise(openTokens(vault, keyHash(name), row.sealed));
        },
      });
    },
  );

/** Expects `time` to be `expected`, or within a second after it (a refresh takes the milliseconds it takes). */
const expectNear = (time: number | null | undefined, expected: number) => {
  expect(time).toBeGreaterThanOrEqual(expected);
  expect(time).toBeLessThan(expected + 1000);
};

const asJson = <T>(value: T): string => JSON.stringify(value);

/** Every kind of entry the tests sign in as. */
const DOCUMENT = { sentry: { url: SERVER_URL } };
const DCR = { sentry: { url: SERVER_URL, oauth: { clientRegistration: "dcr" } } };

const CONFIGURED = {
  sentry: {
    url: SERVER_URL,
    oauth: { clientId: "owner-app", clientSecret: "${APP_SECRET}", issuer: AS },
  },
};

const signedIn = (answer: McpSignInCompleteAnswer) => {
  expect(answer.status).toBe("signed_in");
};

describe("a refresh", () => {
  it("is asked for at a minute before the token expires and sends the refresh token as the client, bound to the resource", () =>
    run(
      () => tokenAnswer(),
      async ({ setGlobal, signIn, ask, net, signIns, keyHash }) => {
        setGlobal(DOCUMENT);
        signedIn(await signIn());

        const before = signIns.get(keyHash("sentry"));
        const revision = signIns.revision();

        // A minute and a second before: the token stands. At the minute: refreshed.
        expect(await ask({}, EXPIRING - 1)).toMatchObject({ status: "ok", token: ACCESS });
        expect(net.refreshes()).toHaveLength(0);

        const answer = await ask({}, EXPIRING);

        expect(answer).toMatchObject({
          status: "ok",
          token: NEW_ACCESS,
          resource: SERVER_URL,
          signIn: before?.grantId,
        });
        expectNear("expiresAt" in answer ? answer.expiresAt : undefined, EXPIRING + 1_800_000);

        const [sent] = net.refreshes();

        expect(sent?.form.get("refresh_token")).toBe(REFRESH);
        expect(sent?.form.get("client_id")).toBe(`${ORIGIN}/oauth/mcp/client.json`);
        expect(sent?.form.get("resource")).toBe(SERVER_URL);
        expect(signIns.get(keyHash("sentry"))).toMatchObject({
          status: "ok",
          grantId: before?.grantId,
        });
        expectNear(signIns.get(keyHash("sentry"))?.expiresAt, EXPIRING + 1_800_000);
        expectNear(signIns.get(keyHash("sentry"))?.refreshedAt, EXPIRING);
        // The revision stays: a refresh changes no sign-in (→ Reports and pushes).
        expect(signIns.revision()).toBe(revision);
      },
    ));

  it("keeps the old refresh token and the scope when the response has none, and takes new ones when it has", () =>
    run(
      () => tokenAnswer(),
      async ({ setGlobal, signIn, ask, tokensOf, signIns, keyHash, spans, net }) => {
        setGlobal(DOCUMENT);
        signedIn(await signIn());

        await ask({}, EXPIRING);

        expect(await tokensOf("sentry")).toEqual({
          access_token: NEW_ACCESS,
          refresh_token: REFRESH,
        });
        expect(signIns.get(keyHash("sentry"))?.scope).toBe("read");

        const rotated = (index: number) =>
          spans
            .filter(({ name }) => name === "mcp.oauth.refresh")
            [index]?.attributes.get("mcp.rotated");

        expect(rotated(0)).toBe(false);
        expect(net.refreshes()).toHaveLength(1);
      },
    ));

  it("rotates the refresh token and the scope when the response carries them", () =>
    run(
      () => tokenAnswer({ refresh_token: NEW_REFRESH, scope: "read write" }),
      async ({ setGlobal, signIn, ask, tokensOf, signIns, keyHash, spans }) => {
        setGlobal(DOCUMENT);
        signedIn(await signIn());

        await ask({}, EXPIRING);

        expect(await tokensOf("sentry")).toEqual({
          access_token: NEW_ACCESS,
          refresh_token: NEW_REFRESH,
        });
        expect(signIns.get(keyHash("sentry"))?.scope).toBe("read write");
        expect(
          spans.find(({ name }) => name === "mcp.oauth.refresh")?.attributes.get("mcp.rotated"),
        ).toBe(true);
      },
    ));

  it("trusts the lifetime of each response, and records none when a response gives none", () =>
    run(
      () => tokenAnswer({ expires_in: 2_592_000 }),
      async ({ setGlobal, signIn, ask, signIns, keyHash }) => {
        setGlobal(DOCUMENT);
        signedIn(await signIn());

        await ask({}, EXPIRING);

        expectNear(signIns.get(keyHash("sentry"))?.expiresAt, EXPIRING + 2_592_000_000);
      },
    ));

  it("is one request when hosts race with a rotating refresh token, and a late host with the replaced token is not refused", () =>
    run(
      async (call) => {
        // The server rotates: a refresh token is good once, so a second request would be `invalid_grant`.
        await Effect.runPromise(Effect.sleep("30 millis"));

        return call.form.get("refresh_token") === REFRESH
          ? tokenAnswer({ refresh_token: NEW_REFRESH })
          : oauthError("invalid_grant");
      },
      async ({ setGlobal, signIn, ask, net, signIns, keyHash }) => {
        setGlobal(DOCUMENT);
        signedIn(await signIn());

        const answers = await Promise.all([
          ask({}, EXPIRING),
          ask({ stale: ACCESS }, EXPIRING),
          ask({}, EXPIRING + 1),
        ]);

        expect(net.refreshes()).toHaveLength(1);

        for (const answer of answers) {
          expect(answer).toMatchObject({ status: "ok", token: NEW_ACCESS });
        }

        // After it, a host that carried the old token and was refused: the Registry hands it the current one, no request.
        expect(await ask({ stale: ACCESS }, EXPIRING + 2)).toMatchObject({
          status: "ok",
          token: NEW_ACCESS,
        });
        expect(net.refreshes()).toHaveLength(1);
        expect(signIns.get(keyHash("sentry"))?.status).toBe("ok");
      },
    ));

  it("is asked for again when a request was refused with the current token, and not for the one that was replaced", () =>
    run(
      () => tokenAnswer({ refresh_token: NEW_REFRESH }),
      async ({ setGlobal, signIn, ask, net }) => {
        setGlobal(DOCUMENT);
        signedIn(await signIn());

        expect(await ask({ stale: ACCESS }, SIGNED_IN_AT + 10)).toMatchObject({
          status: "ok",
          token: NEW_ACCESS,
        });
        expect(net.refreshes()).toHaveLength(1);
        expect(net.refreshes()[0]?.form.get("refresh_token")).toBe(REFRESH);
      },
    ));
});

describe("what the authorization server answers", () => {
  it.each(["invalid_grant", "invalid_scope"])(
    "drops the tokens on %s: required, the reason kept, the revision raised",
    (code) =>
      run(
        () => oauthError(code, 400, "the grant is revoked"),
        async ({ setGlobal, signIn, ask, signIns, keyHash, spans, logged }) => {
          setGlobal(DOCUMENT);
          signedIn(await signIn());

          const revision = signIns.revision();
          const answer = await ask({}, EXPIRING);

          expect(answer).toMatchObject({ status: "required" });
          expect(signIns.get(keyHash("sentry"))).toMatchObject({
            status: "required",
            hasTokens: false,
            sealed: null,
          });
          expect(signIns.get(keyHash("sentry"))?.lastError).toContain(code);
          expect(signIns.revision()).toBe(revision + 1);
          expect(
            spans
              .find(({ name }) => name === "mcp.oauth.refresh")
              ?.attributes.get("mcp.oauth_error"),
          ).toBe(code);
          expect(asJson([answer, logged])).not.toContain(REFRESH);
        },
      ),
  );

  it("drops a registered client's registration with its tokens on invalid_client, so the next start registers again", () =>
    run(
      () => oauthError("invalid_client", 401),
      async ({ setGlobal, signIn, ask, signIns, keyHash, net }) => {
        setGlobal(DCR);
        signedIn(await signIn());

        const row = signIns.get(keyHash("sentry"));

        expect(row?.client).toMatchObject({ kind: "registered" });

        const registration = row?.client?.registration ?? "";

        expect(signIns.getRegistration(registration)).not.toBeNull();
        expect(await ask({}, EXPIRING)).toMatchObject({ status: "required" });
        expect(signIns.getRegistration(registration)).toBeNull();
        expect(signIns.get(keyHash("sentry"))).toMatchObject({ hasTokens: false });
        // One request: the answer is final for this kind of client.
        expect(net.refreshes()).toHaveLength(1);
      },
    ));

  it("drops a configured client's tokens on unauthorized_client, with a problem that names the entry's settings and no secret", () =>
    run(
      () => oauthError("unauthorized_client", 400),
      async ({ setGlobal, signIn, ask, signIns, keyHash, net }) => {
        setGlobal(CONFIGURED);
        signedIn(await signIn());

        const answer = await ask({}, EXPIRING);

        expect(answer).toMatchObject({ status: "required" });
        expect(asJson(answer)).toContain("client id or secret");
        expect(asJson(answer)).not.toContain(SECRET);
        expect(signIns.get(keyHash("sentry"))).toMatchObject({ hasTokens: false });
        // The refresh was sent as the configured client, with its secret from the Secrets.
        expect(net.refreshes()[0]?.form.get("client_id")).toBe("owner-app");
        expect(net.refreshes()).toHaveLength(1);
      },
      {
        secrets: { APP_SECRET: SECRET },
        asMetadata: { token_endpoint_auth_methods_supported: ["client_secret_post"] },
      },
    ));

  it("treats a document client's invalid_client as transient: the tokens are kept and the status is refresh_failing", () =>
    run(
      () => oauthError("invalid_client", 401),
      async ({ setGlobal, signIn, ask, signIns, keyHash, net }) => {
        setGlobal(DOCUMENT);
        signedIn(await signIn());

        const answer = await ask({}, EXPIRING);

        // The token still stands for its last minute: served, with the note.
        expect(answer).toMatchObject({
          status: "ok",
          token: ACCESS,
          note: { status: "refresh_failing" },
        });
        expect(signIns.get(keyHash("sentry"))).toMatchObject({
          status: "refresh_failing",
          hasTokens: true,
        });
        // One try and the retry.
        expect(net.refreshes()).toHaveLength(2);
      },
    ));
});

describe("transient failures", () => {
  it.each<[string, Handler]>([
    ["a 503", () => new Response("down", { status: 503 })],
    ["a 429", () => new Response("slow down", { status: 429 })],
    ["a 408", () => new Response("", { status: 408 })],
    ["server_error", () => oauthError("server_error", 500)],
    ["temporarily_unavailable", () => oauthError("temporarily_unavailable", 503)],
    ["an error code nobody described", () => oauthError("invalid_request", 400)],
    ["an answer that is no token", () => ({ access_token: 7 })],
    [
      "a network error",
      () => {
        throw new Error("The request timed out");
      },
    ],
  ])("keeps the tokens on %s, retries once, and says refresh_failing", (_, handler) =>
    run(handler, async ({ setGlobal, signIn, ask, signIns, keyHash, net }) => {
      setGlobal(DOCUMENT);
      signedIn(await signIn());

      // Past the token's time: there is no token to serve.
      const answer = await ask({}, SIGNED_IN_AT + 3_600_000 + 1);

      expect(answer).toMatchObject({ status: "refresh_failing" });
      expect(net.refreshes()).toHaveLength(2);
      expect(signIns.get(keyHash("sentry"))).toMatchObject({
        status: "refresh_failing",
        hasTokens: true,
      });
      expect(signIns.get(keyHash("sentry"))?.lastError).not.toBeNull();
    }),
  );

  it("succeeds when the retry does, leaving no failing status", () =>
    run(
      (() => {
        let tried = 0;

        return () => {
          tried += 1;

          return tried === 1 ? new Response("down", { status: 502 }) : tokenAnswer();
        };
      })(),
      async ({ setGlobal, signIn, ask, signIns, keyHash, net }) => {
        setGlobal(DOCUMENT);
        signedIn(await signIn());

        expect(await ask({}, EXPIRING)).toMatchObject({ status: "ok", token: NEW_ACCESS });
        expect(net.refreshes()).toHaveLength(2);
        expect(signIns.get(keyHash("sentry"))?.status).toBe("ok");
      },
    ));

  it("backs off 10 s, 20 s and so on up to 5 min, makes no request meanwhile, and starts again after a success", () => {
    let down = true;

    return run(
      () => (down ? new Response("down", { status: 503 }) : tokenAnswer({ expires_in: 60 })),
      async ({ setGlobal, signIn, ask, net }) => {
        setGlobal(DOCUMENT);
        signedIn(await signIn());

        let at = SIGNED_IN_AT + 3_600_000 + 1;
        const attempts = () => net.refreshes().length;

        // Each failure is two requests (the try and its retry), and holds the next attempt back twice as long, up to 5 min.
        for (const wait of [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]) {
          const before = attempts();

          expect(await ask({}, at)).toMatchObject({ status: "refresh_failing" });
          expect(attempts()).toBe(before + 2);

          // Nothing is sent until the backoff is over.
          expect(await ask({}, at + wait - 1)).toMatchObject({ status: "refresh_failing" });
          expect(attempts()).toBe(before + 2);

          // The refresh's own time counts, which is a few milliseconds: the attempt after the backoff is just past it.
          at += wait + 500;
        }

        expect(MAX_REFRESH_BACKOFF_MS).toBe(300_000);

        // A success resets it: the next failure waits 10 s again.
        down = false;
        expect(await ask({}, at)).toMatchObject({ status: "ok", token: NEW_ACCESS });

        down = true;
        at += 60_000;

        const before = attempts();

        expect(await ask({}, at)).toMatchObject({ status: "refresh_failing" });
        expect(await ask({}, at + 9_999)).toMatchObject({ status: "refresh_failing" });
        expect(attempts()).toBe(before + 2);

        await ask({}, at + 10_500);
        expect(attempts()).toBe(before + 4);
      },
    );
  });

  it("serves the token while it still stands, with the note, and not one the server refused", () =>
    run(
      () => new Response("down", { status: 503 }),
      async ({ setGlobal, signIn, ask }) => {
        setGlobal(DOCUMENT);
        signedIn(await signIn());

        expect(await ask({}, EXPIRING + 1000)).toMatchObject({
          status: "ok",
          token: ACCESS,
          note: { status: "refresh_failing" },
        });

        // A refused token does not stand, whatever its expiry.
        expect(await ask({ stale: ACCESS }, SIGNED_IN_AT + 10)).toMatchObject({
          status: "refresh_failing",
        });
      },
    ));

  it("leaves a pending step-up's status and its error where they are", () =>
    run(
      () => new Response("down", { status: 503 }),
      async ({ setGlobal, signIn, ask, report, signIns, keyHash }) => {
        setGlobal(DOCUMENT);
        signedIn(await signIn());
        report("step_up", { scope: "write" });

        await ask({}, EXPIRING);

        expect(signIns.get(keyHash("sentry"))).toMatchObject({
          status: "step_up",
          hasTokens: true,
        });
      },
    ));
});

describe("a step-up that is challenged again", () => {
  it("counts three completed step-ups challenged for the same scope set, and a Settings sign-in resets the count", () =>
    run(
      () => tokenAnswer(),
      async ({ setGlobal, signIn, report, signIns, keyHash }) => {
        setGlobal(DOCUMENT);
        signedIn(await signIn());

        const hash = keyHash("sentry");

        // The first challenge wants the granted scope and the challenged one.
        report("step_up", { scope: "write" });
        expect(signIns.get(hash)).toMatchObject({
          status: "step_up",
          wantedScope: "read write",
          stepUpCount: 0,
        });

        for (const count of [1, 2, 3]) {
          // The owner completes the step-up, which keeps the wanted scope and the count; the server then challenges for the
          // very scope set that was wanted.
          signedIn(await signIn(true));
          expect(signIns.get(hash)).toMatchObject({
            status: "ok",
            wantedScope: "read write",
            stepUpCount: count - 1,
          });

          report("step_up", { scope: "write" });
          expect(signIns.get(hash)).toMatchObject({ status: "step_up", stepUpCount: count });
        }

        // Three: `mcp_sign_in_ask` answers `step_up_failed` from here. A sign-in from Settings starts the count again.
        signedIn(await signIn());
        expect(signIns.get(hash)).toMatchObject({ wantedScope: null, stepUpCount: 0 });
      },
    ));
});

describe("what never leaves the Registry", () => {
  it("puts no token on a span or in a log, for a refresh that works and for one that fails", () =>
    run(
      (() => {
        let tried = 0;

        return () => {
          tried += 1;

          return tried === 1
            ? tokenAnswer({ refresh_token: NEW_REFRESH })
            : oauthError("invalid_grant", 400, `the token ${NEW_REFRESH} is revoked`);
        };
      })(),
      async ({ setGlobal, signIn, ask, spans, logged }) => {
        setGlobal(DOCUMENT);
        signedIn(await signIn());

        await ask({}, EXPIRING);
        await ask({}, EXPIRING + 1_800_000);

        const recorded = asJson(
          spans.map(({ name, attributes, events }) => ({
            name,
            attributes: [...attributes],
            events,
          })),
        );

        for (const secret of [ACCESS, REFRESH, NEW_ACCESS, NEW_REFRESH]) {
          expect(recorded).not.toContain(secret);
          expect(logged.join("\n")).not.toContain(secret);
        }

        const refreshes = spans.filter(({ name }) => name === "mcp.oauth.refresh");

        expect(refreshes).toHaveLength(2);
        expect(refreshes[0]?.attributes.get("mcp.outcome")).toBe("refreshed");
        expect(refreshes[0]?.attributes.get("mcp.client_kind")).toBe("document");
        expect(refreshes[0]?.attributes.get("mcp.issuer_host")).toBe("auth.example.com");
        expect(refreshes[0]?.attributes.get("mcp.trigger")).toBe("expiry");
        expect(refreshes[1]?.attributes.get("mcp.outcome")).toBe("dropped");
        expect(refreshes[1]?.attributes.get("mcp.oauth_error")).toBe("invalid_grant");
      },
    ));
});
