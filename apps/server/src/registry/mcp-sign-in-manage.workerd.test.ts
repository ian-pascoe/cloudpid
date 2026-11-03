// The owner's sign-in list and Sign out over real Durable Object SQLite and a fake authorization server
// (`docs/architecture/mcp-sign-in.md` → Sign-out, Settings): who uses each sign-in, the unused marks, a document start that
// lapsed, RFC 7009 revocation (the refresh token, then the access token; best effort), and what a sign-out deletes and keeps.
// No token or secret reaches an answer, a span or a log line. workerd's Durable Object and `cloudflare:test` APIs are
// Promise-based, so this file is too.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction -- expected answers are matched by their tag */
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferSchemaOverJson:off schemaSync:off preferEffectRecord:off globalDate:off
import { type KeptVault, openKeptVault, SecretVaultError } from "@cloudpid/extensions/secrets/core";
import type { OAuthFetch } from "@cloudpid/mcp/oauth";
import { DEFAULT_ENVIRONMENT, type McpSignInView } from "@cloudpid/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import type * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { describe, expect, it } from "vitest";
import {
  completeMcpSignIn,
  confirmMcpSignIn,
  type FlowDeps,
  startMcpSignIn,
} from "./mcp-sign-in-flow.ts";
import { listMcpSignIns, signOutMcpSignIn } from "./mcp-sign-in-manage.ts";
import { signInTarget } from "./mcp-sign-in-registry.ts";
import { MCP_OAUTH_PURPOSE, sealTokens } from "./mcp-sign-in-seal.ts";
import { type McpSignIns, openMcpSignIns, PENDING_SIGN_IN_TTL_MS } from "./mcp-sign-ins.ts";
import { writeSettings } from "./settings.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { openRegistryStore } from "./store.ts";

const MASTER = "test-master-key-0123456789abcdef0123456789";
const NOW = 1_000_000;

const AS = "https://auth.example.com";
const SERVER_URL = "https://mcp.sentry.dev/mcp?key=url-credential-4d1f";
const ORIGIN = "https://cloudpid-server-pr-9.ian-g-pascoe.workers.dev";
const CODE = "authorization-code-7c2e";
const ACCESS = "access-token-77ab";
const REFRESH = "refresh-token-9f2c";
const SECRET = "client-secret-d41e";

const STAGE = { origin: ORIGIN, label: "pr-9", local: false, documentEnabled: true };

type Call = {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly form: URLSearchParams;
};

/** What a test does inside the revocation endpoint's answer, while a revocation is out. */
let onRevoke: () => void = () => undefined;

const metadata = (over: Record<string, Schema.Json> = {}) => ({
  issuer: AS,
  authorization_endpoint: `${AS}/authorize`,
  token_endpoint: `${AS}/token`,
  registration_endpoint: `${AS}/register`,
  revocation_endpoint: `${AS}/revoke`,
  response_types_supported: ["code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  client_id_metadata_document_supported: true,
  authorization_response_iss_parameter_supported: true,
  scopes_supported: ["read", "offline_access"],
  ...over,
});

const run = <A>(
  body: (harness: Harness) => Promise<A>,
  options: {
    readonly asMetadata?: Record<string, Schema.Json>;
    readonly revokeStatus?: number;
    readonly secrets?: Record<string, string>;
  } = {},
) =>
  runInDurableObject(
    env.REGISTRIES.get(env.REGISTRIES.newUniqueId()),
    async (_: TestRegistry, state) => {
      const store = openRegistryStore(state.storage);
      const signIns = openMcpSignIns(state.storage, store);
      const vault = await Effect.runPromise(openKeptVault(MASTER, MCP_OAUTH_PURPOSE));
      const calls: Array<Call> = [];
      const spans: Array<Tracer.NativeSpan> = [];
      const logged: Array<string> = [];

      const fetch: OAuthFetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        const body = await new Response(init?.body ?? null).text();

        const call: Call = {
          method,
          url: `${url.origin}${url.pathname}`,
          headers: new Headers(init?.headers),
          form: new URLSearchParams(body),
        };

        calls.push(call);

        const route = `${method} ${call.url}`;

        if (route === "GET https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp") {
          return Response.json({ resource: SERVER_URL, authorization_servers: [AS] });
        }

        if (route === `GET ${AS}/.well-known/oauth-authorization-server`) {
          return Response.json(metadata(options.asMetadata));
        }

        if (route === `POST ${AS}/register`) {
          return Response.json(
            { client_id: "registered-client-1", redirect_uris: [`${ORIGIN}/oauth/mcp/callback`] },
            { status: 201 },
          );
        }

        if (route === `POST ${AS}/token`) {
          return Response.json({
            access_token: ACCESS,
            token_type: "Bearer",
            refresh_token: REFRESH,
            expires_in: 3600,
          });
        }

        if (route === `POST ${AS}/revoke`) {
          onRevoke();

          return (options.revokeStatus ?? 200) === 200
            ? new Response(null, { status: 200 })
            : Response.json(
                { error: "unsupported_token_type" },
                { status: options.revokeStatus ?? 400 },
              );
        }

        return new Response("not found", { status: 404 });
      };

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
        fetch,
        sources: () => Effect.succeed({ secrets: options.secrets ?? {}, variables: {} }),
      };

      const keyHash = (name: string): string => {
        const target = signInTarget(store, DEFAULT_ENVIRONMENT, name);

        if (target.status === "unknown" || target.status === "not_applicable") {
          throw new Error(`No sign-in for ${name}`);
        }

        return target.key.hash;
      };

      const signIn = async (over: { readonly environment?: string } = {}): Promise<void> => {
        const started = await observed(
          startMcpSignIn(
            deps,
            { environment: DEFAULT_ENVIRONMENT, server: "sentry", stage: STAGE, ...over },
            NOW,
          ),
        );

        let url: string | undefined;

        if (started.status === "confirm" && "confirmation" in started) {
          const confirmed = await observed(
            confirmMcpSignIn(
              deps,
              { state: started.confirmation.state, decision: "continue" },
              NOW,
            ),
          );

          url = "url" in confirmed ? String(confirmed.url) : undefined;
        } else if ("url" in started) {
          url = String(started.url);
        }

        const token = new URL(url ?? "https://none.invalid").searchParams.get("state") ?? "";

        const done = await observed(
          completeMcpSignIn(
            deps,
            { state: token, path: "/oauth/mcp/callback", code: CODE, iss: AS },
            NOW + 1000,
          ),
        );

        if (done.status !== "signed_in") throw new Error(`Not signed in: ${done.status}`);
      };

      return body({
        deps,
        signIns,
        vault,
        calls,
        spans,
        logged,
        keyHash,
        signIn,
        observed,
        list: (now = NOW + 2000) => observed(listMcpSignIns(deps, now)),
        signOut: (hash, now = NOW + 3000) => observed(signOutMcpSignIn(deps, hash, now)),
        setGlobal: (value) => {
          writeSettings(store, { mcp: { servers: value } }, 5);
        },
        startOnly: async (server = "sentry", at = NOW) =>
          observed(
            startMcpSignIn(deps, { environment: DEFAULT_ENVIRONMENT, server, stage: STAGE }, at),
          ),
        dump: () =>
          JSON.stringify(state.storage.sql.exec("SELECT * FROM mcp_pending_sign_ins").toArray()),
      });
    },
  );

type Harness = {
  readonly deps: FlowDeps;
  readonly signIns: McpSignIns;
  readonly vault: KeptVault;
  readonly calls: Array<Call>;
  readonly spans: Array<Tracer.NativeSpan>;
  readonly logged: Array<string>;
  readonly keyHash: (name: string) => string;
  readonly signIn: (over?: { readonly environment?: string }) => Promise<void>;
  readonly observed: <T>(effect: Effect.Effect<T>) => Promise<T>;
  readonly list: (
    now?: number,
  ) => ReturnType<typeof listMcpSignIns> extends Effect.Effect<infer A> ? Promise<A> : never;
  readonly signOut: (
    hash: string,
    now?: number,
  ) => ReturnType<typeof signOutMcpSignIn> extends Effect.Effect<infer A> ? Promise<A> : never;
  readonly setGlobal: (value: Schema.Json) => void;
  readonly startOnly: (server?: string, at?: number) => Promise<{ readonly status: string }>;
  readonly dump: () => string;
};

const SENTRY = { sentry: { url: SERVER_URL } };

const revocations = (calls: ReadonlyArray<Call>) =>
  calls.filter(({ url }) => url === `${AS}/revoke`);

const only = (list: Awaited<ReturnType<Harness["list"]>>): McpSignInView => {
  const [first] = list.signIns;

  if (first === undefined) throw new Error("No sign-in listed");

  return first;
};

describe("the sign-in list", () => {
  it("shows what a sign-in is and who uses it, never a token, a secret or a URL beyond its host", () =>
    run(async ({ setGlobal, signIn, list, keyHash, logged }) => {
      setGlobal(SENTRY);
      await signIn();

      const listing = await list();
      const row = only(listing);

      expect(row).toMatchObject({
        hash: keyHash("sentry"),
        server: "sentry",
        source: "owner",
        urlHost: "mcp.sentry.dev",
        issuerHost: "auth.example.com",
        kind: "document",
        status: "ok",
        hasTokens: true,
        unused: false,
        environments: [{ id: DEFAULT_ENVIRONMENT }],
      });
      expect(listing.revision).toBeGreaterThan(0);
      expect(listing.lapsedStarts).toEqual([]);

      const text = JSON.stringify(listing);

      for (const secret of [ACCESS, REFRESH, "url-credential-4d1f"]) {
        expect(text).not.toContain(secret);
        expect(logged.join("\n")).not.toContain(secret);
      }
    }));

  it("marks a sign-in unused once no entry uses it, and keeps it listed", () =>
    run(async ({ setGlobal, signIn, list }) => {
      setGlobal(SENTRY);
      await signIn();
      setGlobal({});

      expect(only(await list())).toMatchObject({ unused: true, environments: [] });
    }));

  it("reports a malformed sealing key as the reason the rows cannot be opened", () =>
    run(async ({ deps, observed }) => {
      const broken: FlowDeps = {
        ...deps,
        vault: Effect.fail(
          SecretVaultError.make({ message: "SECRETS_ENCRYPTION_KEY is malformed" }),
        ),
      };

      const listing = await observed(listMcpSignIns(broken, NOW));

      expect(listing).toMatchObject({
        _tag: "SignIns",
        sealing: "SECRETS_ENCRYPTION_KEY is malformed",
      });
    }));

  it("lists a document start that expired without a callback, but not one waiting at the interstitial or one still open", () =>
    run(async ({ setGlobal, startOnly, list, keyHash }) => {
      setGlobal(SENTRY);

      expect(await startOnly()).toMatchObject({ status: "redirect" });

      expect((await list(NOW + 1000)).lapsedStarts).toEqual([]);

      const lapsed = (await list(NOW + PENDING_SIGN_IN_TTL_MS + 1)).lapsedStarts;

      expect(lapsed).toEqual([
        { hash: keyHash("sentry"), issuerHost: "auth.example.com", at: NOW },
      ]);
    }));

  it("does not call a lapsed start of a registered client a refused document", () =>
    run(async ({ setGlobal, startOnly, list }) => {
      setGlobal({ sentry: { url: SERVER_URL, oauth: { clientRegistration: "dcr" } } });

      expect(await startOnly()).toMatchObject({ status: "redirect" });
      expect((await list(NOW + PENDING_SIGN_IN_TTL_MS + 1)).lapsedStarts).toEqual([]);
    }));
});

describe("Sign out", () => {
  it("revokes the refresh token, then the access token, deletes the row and its pending start, and keeps the binding", () =>
    run(async ({ setGlobal, signIn, signOut, signIns, keyHash, calls, spans, list, startOnly }) => {
      setGlobal({ sentry: { url: SERVER_URL, oauth: { clientId: "owner-app", issuer: AS } } });
      await signIn();

      const hash = keyHash("sentry");
      const revision = signIns.revision();

      expect(signIns.getBinding(hash, "owner-app")?.issuer).toBe(AS);

      // A start waiting for its callback goes with the sign-in.
      await startOnly("sentry", NOW + 2500);
      expect(signIns.getPending(hash, NOW + 2600)).not.toBeNull();

      const answer = await signOut(hash);

      expect(answer).toMatchObject({
        _tag: "SignedOut",
        server: "sentry",
        issuerHost: "auth.example.com",
        revocation: { status: "revoked" },
        environments: [{ id: DEFAULT_ENVIRONMENT }],
      });
      expect(answer).toHaveProperty("revision", revision + 1);
      expect(JSON.stringify(answer)).not.toContain(ACCESS);

      expect(revocations(calls).map(({ form }) => form.get("token_type_hint"))).toEqual([
        "refresh_token",
        "access_token",
      ]);
      expect(revocations(calls).map(({ form }) => form.get("token"))).toEqual([REFRESH, ACCESS]);
      expect(revocations(calls)[0]?.form.get("client_id")).toBe("owner-app");

      expect(signIns.get(hash)).toBeNull();
      expect(signIns.getPending(hash, NOW + 2600)).toBeNull();
      expect(signIns.getBinding(hash, "owner-app")?.issuer).toBe(AS);
      expect((await list()).signIns).toEqual([]);

      const span = spans.find(({ name }) => name === "mcp.oauth.revoke");

      expect(span?.attributes.get("mcp.trigger")).toBe("sign_out");
      expect(span?.attributes.get("mcp.outcome")).toBe("revoked");
      expect(span?.attributes.get("mcp.issuer_host")).toBe("auth.example.com");
    }));

  it("keeps the registration of a registered client", () =>
    run(async ({ setGlobal, signIn, signOut, signIns, keyHash }) => {
      setGlobal({ sentry: { url: SERVER_URL, oauth: { clientRegistration: "dcr" } } });
      await signIn();

      const hash = keyHash("sentry");
      const registration = signIns.get(hash)?.client?.registration ?? "";

      expect(signIns.getRegistration(registration)).not.toBeNull();

      await signOut(hash);

      expect(signIns.get(hash)).toBeNull();
      expect(signIns.getRegistration(registration)).not.toBeNull();
    }));

  it("sends a configured client's secret as the entry holds it now, and never records it", () =>
    run(
      async ({ setGlobal, signIn, signOut, keyHash, calls, logged, spans }) => {
        setGlobal({
          sentry: {
            url: SERVER_URL,
            oauth: { clientId: "owner-app", clientSecret: "${SENTRY_SECRET}", issuer: AS },
          },
        });
        await signIn();
        await signOut(keyHash("sentry"));

        const [first] = revocations(calls);

        // The server lists client_secret_basic only: the secret goes in the header.
        expect(first?.headers.get("authorization")).toMatch(/^Basic /);
        expect(first?.form.get("client_secret")).toBeNull();
        expect(logged.join("\n")).not.toContain(SECRET);
        expect(JSON.stringify(spans.map(({ attributes }) => [...attributes]))).not.toContain(
          SECRET,
        );
      },
      {
        secrets: { SENTRY_SECRET: SECRET },
        asMetadata: { token_endpoint_auth_methods_supported: ["client_secret_basic"] },
      },
    ));

  it("reports a refused revocation, with the kind of token and a status and never a token, and still signs out", () =>
    run(
      async ({ setGlobal, signIn, signOut, signIns, keyHash, spans, logged }) => {
        setGlobal(SENTRY);
        await signIn();

        const answer = await signOut(keyHash("sentry"));

        expect(answer).toMatchObject({ _tag: "SignedOut", revocation: { status: "failed" } });

        const note = JSON.stringify(answer);

        expect(note).toContain("refresh token (unsupported_token_type)");
        expect(note).toContain("access token (unsupported_token_type)");

        for (const secret of [ACCESS, REFRESH]) {
          expect(note).not.toContain(secret);
          expect(logged.join("\n")).not.toContain(secret);
        }

        expect(signIns.get(keyHash("sentry"))).toBeNull();
        expect(
          spans.find(({ name }) => name === "mcp.oauth.revoke")?.attributes.get("mcp.outcome"),
        ).toBe("revocation_failed");
      },
      { revokeStatus: 400 },
    ));

  it("signs out of a server that advertises no revocation endpoint, saying so", () =>
    run(
      async ({ setGlobal, signIn, signOut, signIns, keyHash, calls, spans }) => {
        setGlobal(SENTRY);
        await signIn();

        const answer = await signOut(keyHash("sentry"));

        expect(answer).toMatchObject({ _tag: "SignedOut", revocation: { status: "no_endpoint" } });
        expect(revocations(calls)).toEqual([]);
        expect(signIns.get(keyHash("sentry"))).toBeNull();
        expect(
          spans.find(({ name }) => name === "mcp.oauth.revoke")?.attributes.get("mcp.outcome"),
        ).toBe("no_revocation_endpoint");
      },
      { asMetadata: { revocation_endpoint: null } },
    ));

  it("keeps a sign-in that was made while the old one was being revoked", () =>
    run(async ({ setGlobal, signIn, signOut, signIns, keyHash }) => {
      setGlobal(SENTRY);
      await signIn();

      const hash = keyHash("sentry");
      const before = signIns.get(hash);

      onRevoke = () => {
        // A new sign-in lands: the row is replaced, with a new grant.
        signIns.put(
          {
            key: before?.key ?? { source: "owner", name: "sentry", url: SERVER_URL, hash },
            status: "ok",
            issuer: AS,
            metadata: before?.metadata ?? null,
            discovery: before?.discovery ?? null,
            resource: before?.resource ?? null,
            client: before?.client ?? null,
            scope: null,
            expiresAt: null,
            wantedScope: null,
            stepUpCount: 0,
            sealed: before?.sealed ?? null,
          },
          NOW + 2900,
        );
        onRevoke = () => undefined;
      };

      const answer = await signOut(hash);

      expect(answer._tag).toBe("Changed");
      expect(signIns.get(hash)).not.toBeNull();
    }));

  it("answers NoSignIn for a sign-in that is gone", () =>
    run(async ({ signOut }) => {
      expect(await signOut("0".repeat(64))).toEqual({ _tag: "NoSignIn" });
    }));

  it("deletes a row that holds no tokens without revoking anything", () =>
    run(async ({ setGlobal, signIns, signOut, keyHash, calls, observed }) => {
      setGlobal(SENTRY);

      const hash = keyHash("sentry");
      const key = { source: "owner", name: "sentry", url: SERVER_URL, hash };

      signIns.noteChallenge(key, { scope: "read" }, NOW);
      void observed;

      expect(signIns.get(hash)?.hasTokens).toBe(false);

      const answer = await signOut(hash);

      expect(answer).toMatchObject({ _tag: "SignedOut", revocation: { status: "not_attempted" } });
      expect(revocations(calls)).toEqual([]);
      expect(signIns.get(hash)).toBeNull();
    }));
});

describe("a client grant", () => {
  const GRANT = {
    sentry: {
      url: SERVER_URL,
      oauth: {
        grantType: "client_credentials",
        clientId: "service",
        clientSecret: "${SENTRY_SECRET}",
        issuer: AS,
      },
    },
  };

  const putGrant = async (harness: Harness, hash: string) => {
    const sealed = await Effect.runPromise(
      sealTokens(harness.vault, hash, { access_token: ACCESS }),
    );

    if (sealed.status !== "sealed") throw new Error("not sealed");

    harness.signIns.put(
      {
        key: { source: "owner", name: "sentry", url: SERVER_URL, hash },
        status: "ok",
        issuer: AS,
        metadata: JSON.stringify(metadata()),
        discovery: null,
        resource: SERVER_URL,
        client: { id: "service", kind: "client_grant", secretRef: null, registration: null },
        scope: null,
        expiresAt: NOW + 3_600_000,
        wantedScope: null,
        stepUpCount: 0,
        sealed: sealed.sealed,
      },
      NOW,
    );
  };

  it("is listed as used only by an entry that signs in on its own, and has nothing to sign out of", () =>
    run(async (harness) => {
      harness.setGlobal(GRANT);

      const hash = harness.keyHash("sentry");

      await putGrant(harness, hash);

      expect(only(await harness.list())).toMatchObject({
        kind: "client_grant",
        unused: false,
        environments: [{ id: DEFAULT_ENVIRONMENT }],
      });

      const answer = await harness.signOut(hash);

      expect(answer._tag).toBe("NotApplicable");
      expect(harness.signIns.get(hash)).not.toBeNull();
      expect(revocations(harness.calls)).toEqual([]);
    }));

  it("is unused once the entry stops signing in on its own, and is then only deleted, its short-lived token not revoked", () =>
    run(async (harness) => {
      harness.setGlobal(GRANT);

      const hash = harness.keyHash("sentry");

      await putGrant(harness, hash);
      // The entry goes back to an authorization-code sign-in: no entry uses the grant's row as a grant any more.
      harness.setGlobal(SENTRY);

      expect(only(await harness.list())).toMatchObject({
        kind: "client_grant",
        unused: true,
        environments: [],
      });

      const answer = await harness.signOut(hash);

      expect(answer).toMatchObject({ _tag: "SignedOut", environments: [] });
      expect(harness.signIns.get(hash)).toBeNull();
      expect(revocations(harness.calls)).toEqual([]);
    }));
});
