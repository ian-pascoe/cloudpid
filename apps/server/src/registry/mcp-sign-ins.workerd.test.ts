// The MCP sign-in store and what the Registry answers a host about it, over real Durable Object SQLite
// (`docs/architecture/mcp-sign-in.md` → MCP sign-ins, Tokens reach the host object; ADR-0034): the key a server's sign-in is
// found by, tokens sealed under the `mcp-oauth` purpose and bound to their row, `mcpAccessToken`, `reportMcpAuth`, the bounds
// with their eviction and refusals, and statuses that carry no token.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferSchemaOverJson:off
import { type McpSignInKey, sha256Hex } from "@cloudpid/config";
import {
  type KeptVault,
  openKeptVault,
  type SealedValue,
  type SecretVaultError,
} from "@cloudpid/extensions/secrets/core";
import type {
  McpAccessTokenAnswer,
  McpAuthChallenge,
  McpAuthEvent,
  McpAuthReportAnswer,
} from "@cloudpid/mcp/types";
import { DEFAULT_ENVIRONMENT } from "@cloudpid/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { mcpServerSetAnswer } from "./mcp-registry.ts";
import {
  mcpAccessToken,
  type Refresh,
  reportMcpAuth,
  signInAskNotApplicable,
  signInTarget,
} from "./mcp-sign-in-registry.ts";
import {
  MCP_OAUTH_PURPOSE,
  openTokens,
  openValue,
  PENDING_TABLE,
  REGISTRATIONS_TABLE,
  SIGN_INS_TABLE,
  sealedBinding,
  sealTokens,
  sealValue,
  type McpTokens,
} from "./mcp-sign-in-seal.ts";
import {
  MAX_MCP_BINDINGS,
  LAPSED_START_RETENTION_MS,
  MAX_MCP_PENDING,
  MAX_MCP_REGISTRATIONS,
  MAX_MCP_SIGN_INS,
  MAX_MCP_WAITERS,
  type McpPendingSignIn,
  type McpRegistration,
  type McpSignInPut,
  type McpSignIns,
  openMcpSignIns,
  PENDING_SIGN_IN_TTL_MS,
  registrationKey,
  SIGN_IN_WAITER_TTL_MS,
  type SignInWrite,
  stateHash,
} from "./mcp-sign-ins.ts";
import { writeSettings } from "./settings.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { openRegistryStore } from "./store.ts";

/** The vault of MCP sign-ins under `masterKey`; fails while the key is malformed. */
const mcpVault = (masterKey: string): Effect.Effect<KeptVault, SecretVaultError> =>
  openKeptVault(masterKey, MCP_OAUTH_PURPOSE);

const MASTER = "test-master-key-0123456789abcdef0123456789";
const NOW = 1_000_000;

const ACCESS = "access-token-77ab";
const REFRESH = "refresh-token-9f2c";
const CLIENT_SECRET = "client-secret-d41e";
const VERIFIER = "pkce-verifier-0c3a";
const STATE = "state-value-5e51";

const SENTRY = { url: "https://mcp.sentry.dev/mcp" };

const TOKENS: McpTokens = { access_token: ACCESS, refresh_token: REFRESH };

/** A sealed value that opens as nothing: for rows whose tokens the test does not read. */
const OPAQUE: SealedValue = { version: 1, iv: "AAAAAAAAAAAAAAAA", ciphertext: "AAAA" };

const servers = (value: Schema.Json): Schema.Json => ({ mcp: { servers: value } });

/** The sign-in of a server that is not in any set: for the bounds, which do not look at the set. */
const fakeKey = (index: number): McpSignInKey => ({
  hash: sha256Hex(`key-${String(index)}`),
  source: "owner",
  name: `server_${String(index)}`,
  url: `https://s${String(index)}.example/mcp`,
});

const write = (key: McpSignInKey, over: Partial<SignInWrite> = {}): SignInWrite => ({
  key,
  status: "ok",
  issuer: "https://auth.example.com",
  metadata: "{}",
  discovery: "{}",
  resource: key.url,
  client: {
    id: "https://pi.example/oauth/mcp/client.json",
    kind: "document",
    secretRef: null,
    registration: null,
  },
  scope: "read",
  expiresAt: null,
  wantedScope: null,
  stepUpCount: 0,
  sealed: OPAQUE,
  ...over,
});

const registration = (index: number, over: Partial<McpRegistration> = {}): McpRegistration => ({
  key: registrationKey({
    issuer: `https://as${String(index)}.example`,
    redirectUri: "https://pi.example/oauth/mcp/callback",
    clientName: "cloudpid",
  }),
  issuer: `https://as${String(index)}.example`,
  redirectUri: "https://pi.example/oauth/mcp/callback",
  clientName: "cloudpid",
  clientId: `client-${String(index)}`,
  clientInfo: "{}",
  sealedSecret: null,
  clientSecretExpiresAt: null,
  registeredAt: index,
  usedAt: index,
  ...over,
});

const pending = (index: number, over: Partial<McpPendingSignIn> = {}): McpPendingSignIn => ({
  keyHash: fakeKey(index).hash,
  stateHash: stateHash(`state-${String(index)}`),
  environment: DEFAULT_ENVIRONMENT,
  redirectUri: "https://pi.example/oauth/mcp/callback",
  issuer: "https://auth.example.com",
  metadata: "{}",
  client: "{}",
  sealedVerifier: OPAQUE,
  scope: null,
  resource: null,
  stepUp: false,
  requester: null,
  returnPath: null,
  awaitingConfirmation: false,
  lastError: null,
  createdAt: NOW + index,
  expiresAt: NOW + index + PENDING_SIGN_IN_TTL_MS,
  ...over,
});

type Fixture = {
  readonly store: ReturnType<typeof openRegistryStore>;
  readonly signIns: McpSignIns;
  /** The `mcp-oauth` vault under `MASTER`. */
  readonly vault: KeptVault;
  readonly sql: SqlStorage;
  readonly setGlobal: (value: Schema.Json) => void;
  readonly keyOf: (name: string) => McpSignInKey;
  readonly ask: (
    input: { readonly server: string; readonly stale?: string },
    options?: {
      readonly now?: number;
      readonly refresh?: Refresh;
      readonly vault?: Effect.Effect<KeptVault, SecretVaultError>;
    },
  ) => Promise<McpAccessTokenAnswer>;
  readonly report: (
    event: McpAuthEvent,
    server: string,
    challenge?: McpAuthChallenge,
    now?: number,
  ) => McpAuthReportAnswer;
  /** Keep a sign-in for `name`, its tokens sealed as the Registry does. */
  readonly signInWith: (
    name: string,
    over?: Partial<SignInWrite>,
    tokens?: McpTokens,
  ) => Promise<McpSignInPut>;
};

/** Run `body` over a fresh Registry's store and sign-ins, with Global's servers set by the test. */
const fresh = <A>(body: (registry: Fixture) => Promise<A>) =>
  runInDurableObject(
    env.REGISTRIES.get(env.REGISTRIES.newUniqueId()),
    async (_: TestRegistry, state) => {
      const store = openRegistryStore(state.storage);
      const signIns = openMcpSignIns(state.storage, store);
      const vault = await Effect.runPromise(mcpVault(MASTER));

      const keyOf = (name: string): McpSignInKey => {
        const target = signInTarget(store, DEFAULT_ENVIRONMENT, name);

        if (target.status !== "target") throw new Error(`No sign-in for ${name}`);

        return target.key;
      };

      return body({
        store,
        signIns,
        vault,
        sql: state.storage.sql,
        setGlobal: (value) => {
          writeSettings(store, servers(value), 5);
        },
        keyOf,
        ask: (input, options = {}) =>
          Effect.runPromise(
            mcpAccessToken(
              {
                store,
                signIns,
                vault: options.vault ?? Effect.succeed(vault),
                refresh: options.refresh,
              },
              { environment: DEFAULT_ENVIRONMENT, ...input },
              options.now ?? NOW,
            ),
          ),
        report: (event, server, challenge, now = NOW) =>
          reportMcpAuth(
            { store, signIns },
            challenge === undefined
              ? { environment: DEFAULT_ENVIRONMENT, server, event }
              : { environment: DEFAULT_ENVIRONMENT, server, event, challenge },
            now,
          ),
        signInWith: async (name, over = {}, tokens = TOKENS) => {
          const key = keyOf(name);
          const sealed = await Effect.runPromise(sealTokens(vault, key.hash, tokens));

          if (sealed.status !== "sealed") throw new Error("The tokens are too large");

          return signIns.put(write(key, { sealed: sealed.sealed, ...over }), NOW);
        },
      });
    },
  );

const asJson = <T>(value: T): string => JSON.stringify(value);

/** Whether `effect` fails: a value that does not open is no value. */
const fails = async <A, E>(effect: Effect.Effect<A, E>): Promise<boolean> =>
  Exit.isFailure(await Effect.runPromiseExit(effect));

describe("the key a server's sign-in is found by", () => {
  it("is the source, the normalized name and the URL, so two names on one URL are two sign-ins", () =>
    fresh(async ({ setGlobal, keyOf }) => {
      setGlobal({
        "sentry-work": { url: "https://mcp.sentry.dev/mcp#section" },
        "sentry-personal": SENTRY,
      });

      const work = keyOf("sentry-work");
      const personal = keyOf("sentry-personal");

      expect(work).toMatchObject({
        source: "owner",
        name: "sentry_work",
        url: "https://mcp.sentry.dev/mcp",
      });
      expect(personal.url).toBe(work.url);
      expect(personal.hash).not.toBe(work.hash);
    }));

  it("follows the entry's URL and name, not what the host says", () =>
    fresh(async ({ setGlobal, keyOf }) => {
      setGlobal({ sentry: SENTRY });

      const before = keyOf("sentry");

      setGlobal({ sentry: { url: "https://mcp.sentry.dev/v2" } });

      expect(keyOf("sentry").hash).not.toBe(before.hash);
    }));

  it("is none for a server that does not sign in with OAuth, with the reason", () =>
    fresh(async ({ setGlobal, store }) => {
      setGlobal({
        local: { command: "node", args: ["server.js"] },
        keyed: { url: "https://a.example/mcp", headers: { authorization: "Bearer ${TOKEN}" } },
        grant: {
          url: "https://b.example/mcp",
          oauth: {
            grantType: "client_credentials",
            clientId: "a",
            clientSecret: "${SECRET}",
            issuer: "https://auth.example.com",
          },
        },
      });

      const reasons = ["local", "keyed", "grant"].map((name) =>
        signInTarget(store, DEFAULT_ENVIRONMENT, name),
      );

      // A client grant has a key and a row, but no owner sign-in: the ask answers `not_applicable` for it too.
      expect(reasons.map(({ status }) => status)).toEqual([
        "not_applicable",
        "not_applicable",
        "client_grant",
      ]);
      expect(reasons.map(signInAskNotApplicable).map((reason) => reason !== undefined)).toEqual([
        true,
        true,
        true,
      ]);
      expect(signInTarget(store, DEFAULT_ENVIRONMENT, "missing").status).toBe("unknown");
      expect(signInTarget(store, "no-such-environment", "local").status).toBe("unknown");
    }));
});

describe("sealing", () => {
  it("keeps tokens sealed under the mcp-oauth purpose, bound to the row, and never in the clear", () =>
    fresh(async ({ setGlobal, keyOf, signInWith, signIns, vault, sql }) => {
      setGlobal({ sentry: SENTRY, linear: { url: "https://mcp.linear.app/mcp" } });
      await signInWith("sentry");

      const sentry = keyOf("sentry");
      const linear = keyOf("linear");
      const sealed = signIns.get(sentry.hash)?.sealed;

      if (sealed === null || sealed === undefined) throw new Error("No sealed tokens");

      // It opens for its own row...
      expect(await Effect.runPromise(openTokens(vault, sentry.hash, sealed))).toEqual(TOKENS);

      // ...and for no other row, no other table, and no other purpose.
      expect(await fails(openTokens(vault, linear.hash, sealed))).toBe(true);

      const asRegistrationSecret = await Effect.runPromise(
        sealValue(vault, REGISTRATIONS_TABLE, sentry.hash, ACCESS),
      );

      expect(await fails(openTokens(vault, sentry.hash, asRegistrationSecret))).toBe(true);
      expect(
        await Effect.runPromise(
          openValue(vault, REGISTRATIONS_TABLE, sentry.hash, asRegistrationSecret),
        ),
      ).toBe(ACCESS);
      expect(await fails(openValue(vault, PENDING_TABLE, sentry.hash, asRegistrationSecret))).toBe(
        true,
      );

      const registry = await Effect.runPromise(openKeptVault(MASTER, "registry"));

      expect(await fails(registry.open(sealedBinding(SIGN_INS_TABLE, sentry.hash), sealed))).toBe(
        true,
      );

      // Nothing in any of the five tables holds a token, a client secret or a verifier.
      signIns.putRegistration(
        registration(1, {
          sealedSecret: await Effect.runPromise(
            sealValue(vault, REGISTRATIONS_TABLE, registration(1).key, CLIENT_SECRET),
          ),
        }),
      );
      signIns.putPending(
        pending(1, {
          sealedVerifier: await Effect.runPromise(
            sealValue(vault, PENDING_TABLE, fakeKey(1).hash, VERIFIER),
          ),
          stateHash: stateHash(STATE),
        }),
      );
      signIns.addWaiter({ keyHash: sentry.hash, session: "s1", request: "r1" }, NOW);
      signIns.putBinding(
        { keyHash: sentry.hash, clientId: "c", issuer: "https://auth.example.com", boundAt: NOW },
        () => true,
      );

      const everything = [
        "mcp_sign_ins",
        "mcp_client_registrations",
        "mcp_client_bindings",
        "mcp_pending_sign_ins",
        "mcp_sign_in_waiters",
      ].map((table) => asJson(sql.exec(`SELECT * FROM ${table}`).toArray()));

      for (const secret of [ACCESS, REFRESH, CLIENT_SECRET, VERIFIER, STATE]) {
        expect(everything.join("\n")).not.toContain(secret);
      }
    }));

  it("holds each token to 16 KiB", async () => {
    const vault = await Effect.runPromise(mcpVault(MASTER));
    const sealed = (tokens: McpTokens) => Effect.runPromise(sealTokens(vault, "k", tokens));

    expect((await sealed({ access_token: "a".repeat(16 * 1024) })).status).toBe("sealed");
    expect(await sealed({ access_token: "a".repeat(16 * 1024 + 1) })).toEqual({
      status: "too_large",
      token: "access_token",
    });
    expect(await sealed({ access_token: "a", refresh_token: "r".repeat(16 * 1024 + 1) })).toEqual({
      status: "too_large",
      token: "refresh_token",
    });
  });

  it("counts a row whose tokens do not open under a well-formed key as required", () =>
    fresh(async ({ setGlobal, keyOf, signInWith, signIns, ask, sql }) => {
      setGlobal({ sentry: SENTRY, linear: { url: "https://mcp.linear.app/mcp" } });
      await signInWith("sentry");
      await signInWith("linear", {}, { access_token: "other-token-1b2c" });

      // Another row's ciphertext, moved here: bound to its own row, it does not open.
      const moved = signIns.get(keyOf("linear").hash)?.sealed;

      sql.exec(
        "UPDATE mcp_sign_ins SET sealed = ? WHERE key_hash = ?",
        asJson(moved),
        keyOf("sentry").hash,
      );

      const answer = await ask({ server: "sentry" });

      expect(answer).toMatchObject({ status: "required" });
      expect(asJson(answer)).not.toContain("other-token-1b2c");
      expect(asJson(answer)).not.toContain(ACCESS);
    }));
});

describe("a malformed SECRETS_ENCRYPTION_KEY", () => {
  it("answers unavailable with the reason, and keeps the rows unopened", () =>
    fresh(async ({ setGlobal, keyOf, signInWith, signIns, ask, report }) => {
      setGlobal({ sentry: SENTRY });
      await signInWith("sentry");

      const answer = await ask({ server: "sentry" }, { vault: mcpVault("too-short") });

      expect(answer).toMatchObject({ status: "unavailable" });
      expect(asJson(answer)).toContain("at least 32 characters");
      expect(asJson(answer)).not.toContain(ACCESS);

      // The row is as it was, and opens again once the key is well formed.
      expect(signIns.get(keyOf("sentry").hash)).toMatchObject({ hasTokens: true, status: "ok" });
      expect(await ask({ server: "sentry" })).toMatchObject({ status: "ok", token: ACCESS });

      // Reports need no key.
      expect(report("rejected", "sentry")).toMatchObject({ status: "recorded" });
    }));
});

describe("mcpAccessToken", () => {
  it("hands the token with the resource it is bound to, its expiry and the sign-in's id", () =>
    fresh(async ({ setGlobal, keyOf, signInWith, signIns, ask }) => {
      setGlobal({ sentry: SENTRY });

      const put = await signInWith("sentry", {
        expiresAt: NOW + 3_600_000,
        resource: "https://mcp.sentry.dev/",
      });

      const answer = await ask({ server: "sentry" });

      expect(answer).toEqual({
        status: "ok",
        token: ACCESS,
        expiresAt: NOW + 3_600_000,
        resource: "https://mcp.sentry.dev/",
        signIn: put.status === "put" ? put.grantId : "refused",
      });
      expect(signIns.get(keyOf("sentry").hash)?.usedAt).toBe(NOW);
    }));

  it("binds to the entry's URL when no resource was recorded, and has no expiry when none was given", () =>
    fresh(async ({ setGlobal, signInWith, ask }) => {
      setGlobal({ sentry: SENTRY });
      await signInWith("sentry", { resource: null });

      expect(await ask({ server: "sentry" }, { now: NOW + 10 * 24 * 3_600_000 })).toEqual({
        status: "ok",
        token: ACCESS,
        resource: "https://mcp.sentry.dev/mcp",
        signIn: expect.any(String),
      });
    }));

  it("answers required when there is no sign-in, and its last error when it was dropped", () =>
    fresh(async ({ setGlobal, keyOf, signInWith, signIns, ask }) => {
      setGlobal({ sentry: SENTRY });

      expect(await ask({ server: "sentry" })).toEqual({
        status: "required",
        reason: "Not signed in",
      });

      await signInWith("sentry");

      signIns.dropTokens(keyOf("sentry").hash, "invalid_grant: the refresh token was revoked", NOW);

      expect(await ask({ server: "sentry" })).toEqual({
        status: "required",
        reason: "invalid_grant: the refresh token was revoked",
      });
    }));

  it("answers unavailable for a server that is not in the set or does not sign in", () =>
    fresh(async ({ setGlobal, ask }) => {
      setGlobal({ local: { command: "node" } });

      expect(await ask({ server: "local" })).toMatchObject({ status: "unavailable" });
      expect(await ask({ server: "nowhere" })).toMatchObject({ status: "unavailable" });
    }));

  it("asks for a refresh a minute before the token expires, or when a request was refused with it", () =>
    fresh(async ({ setGlobal, signInWith, ask }) => {
      setGlobal({ sentry: SENTRY });
      await signInWith("sentry", { expiresAt: NOW + 120_000 });

      const refreshes: Array<string> = [];

      const refresh: Refresh = ({ tokens, trigger }) => {
        refreshes.push(`${trigger}:${tokens.refresh_token ?? ""}`);

        return Effect.succeed({ status: "refresh_failing", reason: "try again shortly" });
      };

      // 61 s before: the token stands. At 60 s: it is asked for again.
      expect(await ask({ server: "sentry" }, { now: NOW + 59_000, refresh })).toMatchObject({
        status: "ok",
      });
      expect(await ask({ server: "sentry" }, { now: NOW + 60_000, refresh })).toEqual({
        status: "refresh_failing",
        reason: "try again shortly",
      });

      // A refusal with the current token asks again too; one with a token already replaced does not.
      expect(await ask({ server: "sentry", stale: ACCESS }, { now: NOW, refresh })).toMatchObject({
        status: "refresh_failing",
      });
      expect(
        await ask({ server: "sentry", stale: "older-token" }, { now: NOW, refresh }),
      ).toMatchObject({ status: "ok", token: ACCESS });
      expect(refreshes).toEqual([`expiry:${REFRESH}`, `401:${REFRESH}`]);
    }));

  it("serves no token past its time when nothing refreshes it, and none with no refresh token to ask with", () =>
    fresh(async ({ setGlobal, signInWith, ask }) => {
      setGlobal({ sentry: SENTRY, linear: { url: "https://mcp.linear.app/mcp" } });
      await signInWith("sentry", { expiresAt: NOW + 1000 });
      await signInWith("linear", { expiresAt: NOW + 1000 }, { access_token: "other-token-1b2c" });

      const unrefreshed = await ask({ server: "sentry" }, { now: NOW + 2000 });
      const dead = await ask({ server: "linear" }, { now: NOW + 2000 });

      expect(unrefreshed).toMatchObject({ status: "unavailable" });
      expect(dead).toMatchObject({ status: "required" });
      expect(asJson([unrefreshed, dead])).not.toContain(ACCESS);
      expect(asJson([unrefreshed, dead])).not.toContain("other-token-1b2c");
    }));

  it("says required on the row too once a token with no refresh token is past its time, and drops its tokens", () =>
    fresh(async ({ setGlobal, signInWith, signIns, keyOf, ask }) => {
      setGlobal({ sentry: SENTRY });
      await signInWith("sentry", { expiresAt: NOW + 100_000 }, { access_token: ACCESS });

      const { hash } = keyOf("sentry");
      const before = signIns.revision();

      // In its last minute it is withheld but kept: whether to serve it then is the refresh slice's (#454).
      expect(await ask({ server: "sentry" }, { now: NOW + 50_000 })).toMatchObject({
        status: "required",
      });
      expect(signIns.get(hash)).toMatchObject({ status: "ok", hasTokens: true });
      expect(signIns.revision()).toBe(before);

      // Past its time it is gone, so Settings does not show it as signed in, and the hosts learn of it.
      const answer = await ask({ server: "sentry" }, { now: NOW + 100_000 });

      expect(answer).toMatchObject({ status: "required" });
      expect(signIns.get(hash)).toMatchObject({
        status: "required",
        hasTokens: false,
        expiresAt: null,
        lastError: "The sign-in expired and has no refresh token: sign in again",
      });
      expect(signIns.revision()).toBe(before + 1);
      expect(await ask({ server: "sentry" }, { now: NOW + 100_001 })).toMatchObject({
        status: "required",
        reason: "The sign-in expired and has no refresh token: sign in again",
      });
    }));

  it("keeps serving a token its server refused, since calls still try it, and a token while a step-up waits", () =>
    fresh(async ({ setGlobal, signInWith, ask, report }) => {
      setGlobal({ sentry: { ...SENTRY, oauth: { scope: "admin" } } });
      await signInWith("sentry");

      report("rejected", "sentry", { error: "invalid_token", errorDescription: "revoked" });

      // A `rejected` token drives no further refresh on a 401.
      const refresh: Refresh = () => Effect.die("no refresh for a rejected token");

      expect(await ask({ server: "sentry", stale: ACCESS }, { refresh })).toMatchObject({
        status: "ok",
        token: ACCESS,
        note: { status: "rejected", reason: "revoked" },
      });

      report("working", "sentry");
      report("step_up", "sentry", { scope: "write" });

      expect(await ask({ server: "sentry" })).toMatchObject({
        status: "ok",
        token: ACCESS,
        note: { status: "step_up", scope: "read write admin" },
      });
    }));

  it("carries no token in any answer but ok, and none in a listing", () =>
    fresh(async ({ setGlobal, signInWith, signIns, ask, report }) => {
      setGlobal({ sentry: SENTRY, local: { command: "node" } });
      await signInWith("sentry", { expiresAt: NOW + 1000 });

      const answers = [
        await ask({ server: "sentry" }, { now: NOW + 5000 }),
        await ask({ server: "sentry" }, { vault: mcpVault("short") }),
        await ask({ server: "local" }),
        await ask({ server: "missing" }),
        report("rejected", "sentry", { error: "invalid_token" }),
        report("step_up", "sentry", { scope: "write" }),
        report("working", "local"),
      ];

      expect(asJson(answers)).not.toContain(ACCESS);
      expect(asJson(answers)).not.toContain(REFRESH);
      expect(asJson(signIns.list())).not.toContain(ACCESS);
      expect(asJson(signIns.list())).not.toContain(REFRESH);
      expect(asJson(signIns.list())).not.toContain("ciphertext");
    }));
});

describe("reportMcpAuth", () => {
  it("remembers the challenge of a server that was never signed in on a row with no tokens", () =>
    fresh(async ({ setGlobal, keyOf, signIns, report, ask }) => {
      setGlobal({ sentry: SENTRY });

      const answer = report("needs_sign_in", "sentry", {
        resourceMetadataUrl: "https://mcp.sentry.dev/.well-known/oauth-protected-resource",
        scope: "read",
        errorDescription: "x".repeat(400),
      });

      expect(answer).toEqual({ status: "recorded", resolved: [] });

      const row = signIns.get(keyOf("sentry").hash);

      expect(row).toMatchObject({
        status: "required",
        hasTokens: false,
        challenge: {
          resourceMetadataUrl: "https://mcp.sentry.dev/.well-known/oauth-protected-resource",
          scope: "read",
        },
      });
      expect(row?.challenge?.errorDescription).toHaveLength(300);
      expect(await ask({ server: "sentry" })).toMatchObject({ status: "required" });

      // A report is no sign-in: the hosts have nothing to learn from it.
      expect(signIns.revision()).toBe(0);
    }));

  it("counts a completed step-up challenged again for the same scope set, up to three", () =>
    fresh(async ({ setGlobal, keyOf, signInWith, signIns, report }) => {
      setGlobal({ sentry: { ...SENTRY, oauth: { scope: "admin" } } });
      await signInWith("sentry");

      const row = () => signIns.get(keyOf("sentry").hash);

      // What the sign-in slice (#450) writes when the owner completes a step-up: the tokens and scope are new, and the
      // wanted scope and the count are as they were.
      const complete = async () =>
        signInWith("sentry", {
          scope: row()?.wantedScope ?? null,
          wantedScope: row()?.wantedScope ?? null,
          stepUpCount: row()?.stepUpCount ?? 0,
        });

      const counts: Array<number | undefined> = [];

      for (let round = 0; round < 4; round += 1) {
        report("step_up", "sentry", { scope: "write" });
        counts.push(row()?.stepUpCount);

        expect(row()).toMatchObject({ status: "step_up", wantedScope: "read write admin" });

        await complete();
        expect(row()).toMatchObject({ status: "ok", scope: "read write admin" });
      }

      // The first challenge counts nothing; each one after a completed step-up for the same set counts one.
      expect(counts).toEqual([0, 1, 2, 3]);

      // Another scope set starts again.
      report("step_up", "sentry", { scope: "delete" });

      expect(row()).toMatchObject({ stepUpCount: 0, wantedScope: "read write admin delete" });
    }));

  it("counts nothing for a server that refuses one tool for a wider scope while its other tools work", () =>
    fresh(async ({ setGlobal, keyOf, signInWith, signIns, report }) => {
      setGlobal({ sentry: SENTRY });
      await signInWith("sentry");

      const row = () => signIns.get(keyOf("sentry").hash);

      for (let round = 0; round < 5; round += 1) {
        report("step_up", "sentry", { scope: "write" });
        report("working", "sentry");
      }

      expect(row()).toMatchObject({ status: "step_up", stepUpCount: 0, wantedScope: "read write" });
    }));

  it("leaves a pending step-up as it is on working and on rejected, and its requests open", () =>
    fresh(async ({ setGlobal, keyOf, signInWith, signIns, report }) => {
      setGlobal({ sentry: SENTRY });
      await signInWith("sentry");
      report("step_up", "sentry", { scope: "write" });

      const { hash } = keyOf("sentry");

      signIns.addWaiter({ keyHash: hash, session: "s1", request: "r1" }, NOW);

      // Working is no answer to the step-up: nothing is cleared and nobody is told the sign-in is done.
      expect(report("working", "sentry")).toEqual({ status: "recorded", resolved: [] });
      expect(signIns.get(hash)).toMatchObject({ status: "step_up", wantedScope: "read write" });
      expect(signIns.waiters(hash, NOW)).toHaveLength(1);

      report("rejected", "sentry", { error: "invalid_token", errorDescription: "refused" });
      expect(signIns.get(hash)).toMatchObject({ status: "step_up", lastError: "refused" });

      // The owner's sign-in completes it, and the server then works.
      await signInWith("sentry", { scope: "read write", wantedScope: "read write" });
      expect(report("working", "sentry")).toEqual({
        status: "recorded",
        resolved: [{ session: "s1", request: "r1" }],
      });
    }));

  it("serves a step-up's rejected token without a refresh, as a rejected sign-in's, and refreshes one that was not", () =>
    fresh(async ({ setGlobal, signInWith, report, ask }) => {
      setGlobal({ sentry: SENTRY });
      await signInWith("sentry");
      report("step_up", "sentry", { scope: "write" });

      const refreshes: Array<string> = [];

      const refresh: Refresh = ({ trigger }) => {
        refreshes.push(trigger);

        return Effect.succeed({ status: "refresh_failing", reason: "try again shortly" });
      };

      // The step-up's token was not refused by the server: a refusal asks for a refresh.
      expect(await ask({ server: "sentry", stale: ACCESS }, { refresh })).toMatchObject({
        status: "refresh_failing",
      });
      expect(refreshes).toEqual(["401"]);

      report("rejected", "sentry", { error: "invalid_token", errorDescription: "refused" });

      // It was: the token is still served, with the note, and nothing is refreshed.
      expect(await ask({ server: "sentry", stale: ACCESS }, { refresh })).toMatchObject({
        status: "ok",
        token: ACCESS,
        note: { status: "step_up", reason: "refused", scope: "read write" },
      });
      expect(refreshes).toEqual(["401"]);
    }));

  it("keeps a pending step-up through a refresh of the tokens, so the next challenge for the same set counts nothing", () =>
    fresh(async ({ setGlobal, keyOf, signInWith, signIns, report }) => {
      setGlobal({ sentry: SENTRY });
      await signInWith("sentry");

      const { hash } = keyOf("sentry");

      report("step_up", "sentry", { scope: "write" });
      report("rejected", "sentry", { error: "invalid_token", errorDescription: "refused" });

      expect(
        signIns.replaceTokens(hash, { sealed: OPAQUE, expiresAt: null, scope: "read" }, NOW),
      ).toBe(true);
      expect(signIns.get(hash)).toMatchObject({
        status: "step_up",
        lastError: null,
        wantedScope: "read write",
        stepUpCount: 0,
      });

      report("step_up", "sentry", { scope: "write" });
      expect(signIns.get(hash)).toMatchObject({ status: "step_up", stepUpCount: 0 });

      // Without a pending step-up a refresh still clears the status.
      signIns.update(hash, { status: "refresh_failing" }, NOW);
      signIns.replaceTokens(hash, { sealed: OPAQUE, expiresAt: null, scope: "read" }, NOW);
      expect(signIns.get(hash)).toMatchObject({ status: "ok" });
    }));

  it("starts the count again when a challenge during a pending step-up asks for another scope set", () =>
    fresh(async ({ setGlobal, keyOf, signInWith, signIns, report }) => {
      setGlobal({ sentry: SENTRY });
      await signInWith("sentry");

      const row = () => signIns.get(keyOf("sentry").hash);

      report("step_up", "sentry", { scope: "write" });
      await signInWith("sentry", { scope: "read write", wantedScope: "read write" });
      report("step_up", "sentry", { scope: "write" });
      expect(row()).toMatchObject({ status: "step_up", stepUpCount: 1 });

      // The same set again while pending: still 1. Another set: the count starts again.
      report("step_up", "sentry", { scope: "write" });
      expect(row()).toMatchObject({ stepUpCount: 1 });

      report("step_up", "sentry", { scope: "delete" });
      expect(row()).toMatchObject({ stepUpCount: 0, wantedScope: "read write delete" });
    }));

  it("keeps the tokens of a server that refused them, with the error", () =>
    fresh(async ({ setGlobal, keyOf, signInWith, signIns, report }) => {
      setGlobal({ sentry: SENTRY });
      await signInWith("sentry");

      report("rejected", "sentry", { error: "invalid_token", errorDescription: "revoked" });

      expect(signIns.get(keyOf("sentry").hash)).toMatchObject({
        status: "rejected",
        hasTokens: true,
        lastError: "revoked",
        challenge: { error: "invalid_token" },
      });
    }));

  it("clears the status on working, and resolves the open Sign-in requests of the key, once", () =>
    fresh(async ({ setGlobal, keyOf, signInWith, signIns, report }) => {
      setGlobal({ sentry: SENTRY });
      await signInWith("sentry");
      report("rejected", "sentry", { error: "invalid_token" });

      const { hash } = keyOf("sentry");

      signIns.addWaiter({ keyHash: hash, session: "s1", request: "r1" }, NOW);
      signIns.addWaiter({ keyHash: hash, session: "s2", request: "r2" }, NOW);
      signIns.addWaiter({ keyHash: fakeKey(9).hash, session: "s3", request: "r3" }, NOW);

      expect(report("working", "sentry")).toEqual({
        status: "recorded",
        resolved: [
          { session: "s1", request: "r1" },
          { session: "s2", request: "r2" },
        ],
      });
      expect(signIns.get(hash)).toMatchObject({ status: "ok", lastError: null });
      expect(report("working", "sentry")).toEqual({ status: "recorded", resolved: [] });
      expect(signIns.waiters(fakeKey(9).hash, NOW)).toHaveLength(1);
    }));

  it("ignores a server with no sign-in to change, a server that does not sign in, and an event it does not know", () =>
    fresh(async ({ setGlobal, report }) => {
      setGlobal({ sentry: SENTRY, local: { command: "node" } });

      expect(report("step_up", "sentry")).toMatchObject({ status: "ignored" });
      expect(report("rejected", "sentry")).toMatchObject({ status: "ignored" });
      expect(report("needs_sign_in", "local")).toMatchObject({ status: "ignored" });
      expect(report("needs_sign_in", "missing")).toMatchObject({ status: "ignored" });
      // A newer host's event decodes as a string (`McpAuthEvent`'s fallback), which the Registry ignores with why.
      expect(report("hello", "sentry")).toEqual({
        status: "ignored",
        reason: "The event is not one this build knows",
      });
    }));
});

describe("the bounds", () => {
  it("holds 200 sign-ins and then refuses a new one, naming Global's MCP servers page", () =>
    fresh(async ({ signIns }) => {
      for (let index = 0; index < MAX_MCP_SIGN_INS; index += 1) {
        expect(signIns.put(write(fakeKey(index)), NOW + index)).toMatchObject({ status: "put" });
      }

      const refused = signIns.put(write(fakeKey(MAX_MCP_SIGN_INS)), NOW);

      expect(refused).toMatchObject({ status: "refused", reason: "full" });
      expect(refused.status === "refused" ? refused.message : "").toContain(
        "Global's MCP servers page",
      );
      expect(signIns.list()).toHaveLength(MAX_MCP_SIGN_INS);

      // A sign-in already held is replaced, not counted again.
      expect(signIns.put(write(fakeKey(3)), NOW)).toMatchObject({ status: "put" });
      expect(signIns.list()).toHaveLength(MAX_MCP_SIGN_INS);
    }));

  it("evicts the least recently used row without tokens, never one with tokens", () =>
    fresh(async ({ signIns }) => {
      for (let index = 0; index < MAX_MCP_SIGN_INS; index += 1) {
        signIns.put(write(fakeKey(index)), NOW + index);
      }

      // Two rows lose their tokens; row 7 was used less recently than row 5 was.
      signIns.dropTokens(fakeKey(5).hash, null, NOW);
      signIns.dropTokens(fakeKey(7).hash, null, NOW);
      signIns.touch(fakeKey(5).hash, NOW + 1000);

      expect(signIns.put(write(fakeKey(500)), NOW + 2000)).toMatchObject({ status: "put" });
      expect(signIns.get(fakeKey(7).hash)).toBeNull();
      expect(signIns.get(fakeKey(5).hash)).not.toBeNull();
      expect(signIns.get(fakeKey(0).hash)).not.toBeNull();

      // A challenge for a new server needs room too: the other tokenless row goes.
      expect(signIns.noteChallenge(fakeKey(501), { scope: "read" }, NOW + 3000)).toEqual({
        status: "noted",
      });
      expect(signIns.get(fakeKey(5).hash)).toBeNull();

      // Now every row holds tokens or a challenge: the next challenge evicts that one, but a full store of tokens refuses.
      for (const record of signIns.list()) {
        if (!record.hasTokens) signIns.put(write(record.key), NOW);
      }

      expect(signIns.noteChallenge(fakeKey(502), {}, NOW)).toMatchObject({
        status: "refused",
        reason: "full",
      });
    }));

  it("refuses recorded metadata over 64 KiB", () =>
    fresh(async ({ signIns }) => {
      expect(
        signIns.put(write(fakeKey(1), { metadata: "x".repeat(64 * 1024) }), NOW),
      ).toMatchObject({ status: "put" });
      expect(
        signIns.put(write(fakeKey(2), { metadata: "x".repeat(64 * 1024 + 1) }), NOW),
      ).toMatchObject({ status: "refused", reason: "too_large" });
      expect(
        signIns.put(write(fakeKey(3), { discovery: "x".repeat(64 * 1024 + 1) }), NOW),
      ).toMatchObject({ status: "refused", reason: "too_large" });
      expect(signIns.get(fakeKey(2).hash)).toBeNull();
    }));

  it("holds 100 registrations: an unreferenced one is evicted, and when every one is in use the new one is refused", () =>
    fresh(async ({ signIns }) => {
      for (let index = 0; index < MAX_MCP_REGISTRATIONS; index += 1) {
        signIns.putRegistration(registration(index));
      }

      // Registration 0 is the least recently used.
      expect(signIns.putRegistration(registration(1000))).toEqual({ status: "put" });
      expect(signIns.getRegistration(registration(0).key)).toBeNull();
      expect(signIns.getRegistration(registration(1).key)).not.toBeNull();

      // Every registration is used by a sign-in.
      for (let index = 1; index <= MAX_MCP_REGISTRATIONS; index += 1) {
        const key =
          index === MAX_MCP_REGISTRATIONS ? registration(1000).key : registration(index).key;

        signIns.put(
          write(fakeKey(index), {
            client: { id: "c", kind: "registered", secretRef: null, registration: key },
          }),
          NOW,
        );
      }

      expect(signIns.putRegistration(registration(2000))).toMatchObject({
        status: "refused",
        reason: "full",
      });

      // Replacing one that is held is no new row.
      expect(signIns.putRegistration(registration(1000, { clientId: "again" }))).toEqual({
        status: "put",
      });
      expect(signIns.getRegistration(registration(1000).key)?.clientId).toBe("again");
    }));

  it("holds 200 bindings: one no server names is evicted, and when every one is named the new one is refused", () =>
    fresh(async ({ signIns }) => {
      const bind = (index: number, issuer = "https://auth.example.com") => ({
        keyHash: fakeKey(index).hash,
        clientId: "client",
        issuer,
        boundAt: NOW + index,
      });

      for (let index = 0; index < MAX_MCP_BINDINGS; index += 1)
        signIns.putBinding(bind(index), () => true);

      // Nothing names bindings 0 and 1 any more: the older goes.
      const named = (keyHash: string) => keyHash !== fakeKey(0).hash && keyHash !== fakeKey(1).hash;

      expect(signIns.putBinding(bind(1000), named)).toEqual({ status: "put", rebound: false });
      expect(signIns.getBinding(fakeKey(0).hash, "client")).toBeNull();
      expect(signIns.getBinding(fakeKey(1).hash, "client")).not.toBeNull();

      expect(signIns.putBinding(bind(2000), () => true)).toMatchObject({
        status: "refused",
        reason: "full",
      });

      // Dropped once no set names the pair; the rest stay.
      expect(signIns.dropUnnamedBindings(named)).toBe(1);
      expect(signIns.getBinding(fakeKey(1).hash, "client")).toBeNull();
    }));

  it("holds 20 pending rows, one per key, dropping the oldest, and expires each after 10 minutes", () =>
    fresh(async ({ signIns }) => {
      for (let index = 0; index < MAX_MCP_PENDING + 5; index += 1)
        signIns.putPending(pending(index));

      expect(signIns.getPending(fakeKey(0).hash, NOW)).toBeNull();
      expect(signIns.getPending(fakeKey(4).hash, NOW)).toBeNull();
      expect(signIns.getPending(fakeKey(5).hash, NOW)).not.toBeNull();
      expect(signIns.getPending(fakeKey(24).hash, NOW)).not.toBeNull();

      // A newer start of one key replaces the older, whose state no longer finds it.
      signIns.putPending(pending(24, { stateHash: stateHash("newer"), createdAt: NOW + 100 }));

      expect(signIns.takePending(stateHash("state-24"), NOW + 100)).toEqual({ status: "none" });
      expect(signIns.takePending(stateHash("newer"), NOW + 100)).toMatchObject({ status: "found" });
    }));

  it("takes a pending row once: it is deleted before the callback checks it, and an expired one says so", () =>
    fresh(async ({ signIns }) => {
      signIns.putPending(pending(1));
      signIns.putPending(pending(2));

      const hash = stateHash("state-1");

      expect(signIns.takePending(hash, NOW + 10)).toMatchObject({
        status: "found",
        pending: { keyHash: fakeKey(1).hash },
      });
      expect(signIns.takePending(hash, NOW + 10)).toEqual({ status: "none" });

      expect(signIns.takePending(stateHash("state-2"), NOW + 2 + PENDING_SIGN_IN_TTL_MS)).toEqual({
        status: "expired",
      });
      expect(signIns.getPending(fakeKey(2).hash, NOW)).toBeNull();
      expect(signIns.takePending(stateHash("unknown"), NOW)).toEqual({ status: "none" });
    }));

  it("treats a pending row older than 10 minutes as absent, and keeps it a week for a lapsed start", () =>
    fresh(async ({ signIns, sql }) => {
      signIns.putPending(pending(1));
      signIns.putPending(pending(2, { createdAt: NOW + 5 * 60_000, expiresAt: NOW + 15 * 60_000 }));

      const rowCount = () =>
        sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM mcp_pending_sign_ins").one().n;

      // Row 1 expires 10 minutes after its start (NOW + 1); row 2 five minutes later.
      expect(signIns.getPending(fakeKey(1).hash, NOW + PENDING_SIGN_IN_TTL_MS)).not.toBeNull();
      expect(signIns.getPending(fakeKey(1).hash, NOW + 1 + PENDING_SIGN_IN_TTL_MS)).toBeNull();
      expect(signIns.getPending(fakeKey(2).hash, NOW + 1 + PENDING_SIGN_IN_TTL_MS)).not.toBeNull();

      // It is only treated as absent: the row stays, for Settings to say a document client may have been refused.
      expect(rowCount()).toBe(2);

      signIns.putPending(
        pending(3, { createdAt: NOW + 1 + PENDING_SIGN_IN_TTL_MS, expiresAt: NOW + 20 * 60_000 }),
      );
      expect(rowCount()).toBe(3);

      // A week after it expired, the next put sweeps it.
      signIns.putPending(
        pending(4, {
          createdAt: NOW + 1 + PENDING_SIGN_IN_TTL_MS + LAPSED_START_RETENTION_MS,
          expiresAt: NOW + 2 * LAPSED_START_RETENTION_MS,
        }),
      );
      expect(rowCount()).toBe(3);
      expect(signIns.listPending().map(({ keyHash }) => keyHash)).not.toContain(fakeKey(1).hash);
      expect(signIns.takePending(stateHash("state-1"), NOW)).toEqual({ status: "none" });
    }));

  it("refuses a pending row whose metadata or client is over 64 KiB, keeping the one it would have replaced", () =>
    fresh(async ({ signIns }) => {
      expect(signIns.putPending(pending(1, { metadata: "x".repeat(64 * 1024) }))).toEqual({
        status: "put",
      });
      expect(signIns.putPending(pending(1, { metadata: "x".repeat(64 * 1024 + 1) }))).toMatchObject(
        {
          status: "refused",
          reason: "too_large",
        },
      );
      expect(signIns.putPending(pending(2, { client: "x".repeat(64 * 1024 + 1) }))).toMatchObject({
        status: "refused",
        reason: "too_large",
      });
      expect(signIns.getPending(fakeKey(1).hash, NOW)?.metadata).toHaveLength(64 * 1024);
      expect(signIns.getPending(fakeKey(2).hash, NOW)).toBeNull();
    }));

  it("refuses a registration whose response is over 64 KiB", () =>
    fresh(async ({ signIns }) => {
      expect(
        signIns.putRegistration(registration(1, { clientInfo: "x".repeat(64 * 1024) })),
      ).toEqual({ status: "put" });
      expect(
        signIns.putRegistration(registration(2, { clientInfo: "x".repeat(64 * 1024 + 1) })),
      ).toMatchObject({ status: "refused", reason: "too_large" });
      expect(signIns.getRegistration(registration(2).key)).toBeNull();
    }));

  it("holds 100 waiters, then refuses, and each expires after 30 days", () =>
    fresh(async ({ signIns }) => {
      const key = fakeKey(1).hash;

      expect(signIns.addWaiter({ keyHash: key, session: "s0", request: "r" }, NOW)).toEqual({
        status: "added",
        first: true,
      });
      // The same request joins; another on the same key is not first.
      expect(signIns.addWaiter({ keyHash: key, session: "s0", request: "r" }, NOW)).toEqual({
        status: "joined",
      });
      expect(signIns.addWaiter({ keyHash: key, session: "s1", request: "r" }, NOW)).toEqual({
        status: "added",
        first: false,
      });

      for (let index = 2; index < MAX_MCP_WAITERS; index += 1) {
        signIns.addWaiter({ keyHash: key, session: `s${String(index)}`, request: "r" }, NOW);
      }

      expect(
        signIns.addWaiter({ keyHash: key, session: "extra", request: "r" }, NOW),
      ).toMatchObject({
        status: "full",
      });

      // Each expires after 30 days, and room is made then.
      const later = NOW + SIGN_IN_WAITER_TTL_MS;

      expect(signIns.waiters(key, later - 1)).toHaveLength(MAX_MCP_WAITERS);
      expect(signIns.waiters(key, later)).toHaveLength(0);
      expect(signIns.addWaiter({ keyHash: key, session: "extra", request: "r" }, later)).toEqual({
        status: "added",
        first: true,
      });
    }));

  it("ends one waiter without the others (a decline), and resolves all of a key's at once", () =>
    fresh(async ({ signIns }) => {
      const key = fakeKey(1).hash;

      signIns.addWaiter({ keyHash: key, session: "s1", request: "r1" }, NOW);
      signIns.addWaiter({ keyHash: key, session: "s2", request: "r2" }, NOW);

      expect(signIns.removeWaiter("s1", "r1")).toBe(true);
      expect(signIns.removeWaiter("s1", "r1")).toBe(false);
      expect(signIns.resolveWaiters(key, NOW)).toMatchObject([{ session: "s2", request: "r2" }]);
      expect(signIns.waiters(key, NOW)).toEqual([]);
    }));
});

describe("the revision", () => {
  it("is what the host's pull (mcpServerSet) answers, and follows each change to a sign-in", () =>
    fresh(async ({ setGlobal, signInWith, signIns, store, keyOf }) => {
      const pulled = () =>
        mcpServerSetAnswer(store, { environment: DEFAULT_ENVIRONMENT }, NOW).signInsRevision;

      setGlobal({ sentry: SENTRY });
      expect(pulled()).toBe(0);

      await signInWith("sentry");
      expect(pulled()).toBe(1);
      expect(pulled()).toBe(signIns.revision());

      // A pull itself changes nothing, and neither does a set that carries no new sign-in.
      expect(pulled()).toBe(1);
      setGlobal({ sentry: SENTRY, linear: { url: "https://mcp.linear.app/mcp" } });
      expect(pulled()).toBe(1);

      signIns.dropTokens(keyOf("sentry").hash, "invalid_grant", NOW);
      expect(pulled()).toBe(2);
      expect(pulled()).toBe(signIns.revision());
    }));

  it("rises with a sign-in, a sign-out, a rebind and a drop of tokens, and with nothing else", () =>
    fresh(async ({ signIns }) => {
      const key = fakeKey(1);
      const bind = (issuer: string) => ({ keyHash: key.hash, clientId: "c", issuer, boundAt: NOW });

      expect(signIns.revision()).toBe(0);

      signIns.put(write(key), NOW);
      expect(signIns.revision()).toBe(1);

      // Reports, touches, refreshed tokens, a first binding and a registration change nothing a host holds.
      signIns.noteChallenge(fakeKey(2), {}, NOW);
      signIns.update(key.hash, { status: "rejected" }, NOW);
      signIns.touch(key.hash, NOW);
      signIns.replaceTokens(key.hash, { sealed: OPAQUE, expiresAt: null, scope: "read" }, NOW);
      signIns.putBinding(bind("https://a.example"), () => true);
      signIns.putBinding(bind("https://a.example"), () => true);
      signIns.putRegistration(registration(1));
      expect(signIns.revision()).toBe(1);

      expect(signIns.putBinding(bind("https://b.example"), () => true)).toEqual({
        status: "put",
        rebound: true,
      });
      expect(signIns.revision()).toBe(2);

      signIns.dropTokens(key.hash, "invalid_grant", NOW);
      expect(signIns.revision()).toBe(3);

      signIns.delete(key.hash, NOW);
      expect(signIns.revision()).toBe(4);
      expect(signIns.delete(key.hash, NOW)).toBe(false);
      expect(signIns.revision()).toBe(4);
    }));

  it("is what the Registry's own sign-out leaves behind: the row and its pending row go, the registration and binding stay", () =>
    fresh(async ({ signIns }) => {
      const key = fakeKey(1);
      const reg = registration(1);

      signIns.put(write(key), NOW);
      signIns.putPending(pending(1));
      signIns.putRegistration(reg);
      signIns.putBinding(
        { keyHash: key.hash, clientId: "c", issuer: "https://auth.example.com", boundAt: NOW },
        () => true,
      );

      expect(signIns.delete(key.hash, NOW)).toBe(true);
      expect(signIns.get(key.hash)).toBeNull();
      expect(signIns.getPending(key.hash, NOW)).toBeNull();
      expect(signIns.getRegistration(reg.key)).not.toBeNull();
      expect(signIns.getBinding(key.hash, "c")).not.toBeNull();
    }));
});
