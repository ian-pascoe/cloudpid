// A Session's Sign-in request as the Registry answers it, over real Durable Object SQLite (`docs/architecture/mcp-sign-in.md`
// → Sign-in requests; ADR-0034): `mcpSignInAsk` keeps one waiter row per (Session, request), says which is the first of its
// key (the one that sends the Notification), answers at once when there is nothing to ask for, and a sign-in completed from
// Settings (`completeMcpSignIn`) resolves every open waiter of its key and deletes their rows.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferSchemaOverJson:off schemaSync:off preferEffectRecord:off
import { type KeptVault, openKeptVault } from "@cloudpid/extensions/secrets/core";
import type { OAuthFetch } from "@cloudpid/mcp/oauth";
import type {
  McpSignInAskAnswer,
  McpSignInCompleteAnswer,
  McpSignInCompleteInput,
} from "@cloudpid/mcp/types";
import { DEFAULT_ENVIRONMENT } from "@cloudpid/protocol";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { askMcpSignIn, STEP_UP_LIMIT, withdrawMcpSignIn } from "./mcp-sign-in-ask.ts";
import { completeMcpSignIn, type FlowDeps, startMcpSignIn } from "./mcp-sign-in-flow.ts";
import { signInTarget } from "./mcp-sign-in-registry.ts";
import { MCP_OAUTH_PURPOSE } from "./mcp-sign-in-seal.ts";
import { type McpSignIns, openMcpSignIns } from "./mcp-sign-ins.ts";
import { writeSettings } from "./settings.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { openRegistryStore } from "./store.ts";

const MASTER = "test-master-key-0123456789abcdef0123456789";
const NOW = 1_000_000;
const AS = "https://auth.example.com";
const SERVER_URL = "https://mcp.sentry.dev/mcp";
const ORIGIN = "https://cloudpid-server-pr-9.ian-g-pascoe.workers.dev";
const STAGE = { origin: ORIGIN, label: "pr-9", local: false, documentEnabled: true };

/** The authorization server and the MCP server, as a sign-in's start and callback reach them. */
const fetch: OAuthFetch = async (input, init) => {
  const url = new URL(String(input));
  const route = `${init?.method ?? "GET"} ${url.origin}${url.pathname}`;

  const answers = {
    "GET https://mcp.sentry.dev/.well-known/oauth-protected-resource/mcp": {
      resource: SERVER_URL,
      authorization_servers: [AS],
      scopes_supported: ["read"],
    },
    [`GET ${AS}/.well-known/oauth-authorization-server`]: {
      issuer: AS,
      authorization_endpoint: `${AS}/authorize`,
      token_endpoint: `${AS}/token`,
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    },
    [`POST ${AS}/token`]: {
      access_token: "access-token-77ab",
      token_type: "Bearer",
      refresh_token: "refresh-token-9f2c",
      expires_in: 3600,
    },
  };

  const answer = Option.getOrUndefined(Record.get<string, Schema.Json>(answers, route));

  return answer === undefined ? new Response("not found", { status: 404 }) : Response.json(answer);
};

type Ask = {
  readonly ask: (
    session: string,
    request: string,
    over?: { readonly server?: string; readonly now?: number },
  ) => Promise<McpSignInAskAnswer>;
  readonly signIns: McpSignIns;
  readonly keyHash: (name: string) => string;
  readonly setGlobal: (value: Schema.Json) => void;
  /** The owner signs in from Settings: start, and the authorization server's callback. */
  readonly completeFromSettings: (
    over?: Partial<McpSignInCompleteInput>,
  ) => Promise<McpSignInCompleteAnswer>;
  readonly withdraw: (session: string, request: string) => { readonly removed: boolean };
};

const run = <A>(body: (ask: Ask) => Promise<A>) =>
  runInDurableObject(
    env.REGISTRIES.get(env.REGISTRIES.newUniqueId()),
    async (_: TestRegistry, state) => {
      const store = openRegistryStore(state.storage);
      const signIns = openMcpSignIns(state.storage, store);
      const vault: KeptVault = await Effect.runPromise(openKeptVault(MASTER, MCP_OAUTH_PURPOSE));

      const deps: FlowDeps = {
        store,
        signIns,
        vault: Effect.succeed(vault),
        fetch,
        sources: () => Effect.succeed({ secrets: {}, variables: {} }),
      };

      const keyHash = (name: string): string => {
        const target = signInTarget(store, DEFAULT_ENVIRONMENT, name);

        if (target.status !== "target") throw new Error(`No sign-in for ${name}`);

        return target.key.hash;
      };

      const completeFromSettings: Ask["completeFromSettings"] = async (over = {}) => {
        const started = await Effect.runPromise(
          startMcpSignIn(
            deps,
            { environment: DEFAULT_ENVIRONMENT, server: "sentry", stage: STAGE },
            NOW,
          ),
        );

        if (started.status !== "redirect" || !("url" in started)) {
          throw new Error(`Not started: ${JSON.stringify(started)}`);
        }

        const code = new URL(started.url).searchParams.get("state") ?? "";

        return Effect.runPromise(
          completeMcpSignIn(
            deps,
            { state: code, path: "/oauth/mcp/callback", code: "code-1", iss: AS, ...over },
            NOW + 1000,
          ),
        );
      };

      return body({
        signIns,
        keyHash,
        setGlobal: (value) => {
          writeSettings(store, { mcp: { servers: value } }, 5);
        },
        ask: (session, request, over = {}) =>
          Effect.runPromise(
            askMcpSignIn(
              deps,
              {
                environment: DEFAULT_ENVIRONMENT,
                server: over.server ?? "sentry",
                session,
                request,
              },
              over.now ?? NOW,
            ),
          ),
        completeFromSettings,
        withdraw: (session, request) => withdrawMcpSignIn(deps, { session, request }),
      });
    },
  );

describe("mcpSignInAsk", () => {
  it("keeps a waiter for a server that needs the owner, and says what the card shows", () =>
    run(async ({ ask, setGlobal, signIns, keyHash }) => {
      setGlobal({ sentry: { url: SERVER_URL, oauth: { issuer: AS } } });

      expect(await ask("s1", "signin-1")).toEqual({
        status: "open",
        first: true,
        key: keyHash("sentry"),
        why: "required",
        scopes: [],
        source: { kind: "global" },
        urlHost: "mcp.sentry.dev",
        issuerHost: "auth.example.com",
      });
      expect(signIns.waiters(keyHash("sentry"), NOW)).toMatchObject([
        { session: "s1", request: "signin-1" },
      ]);
    }));

  it("sends the Notification once per key: only the first open waiter is `first`, and asking again joins it", () =>
    run(async ({ ask, setGlobal, signIns, keyHash }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      expect(await ask("s1", "signin-1")).toMatchObject({ status: "open", first: true });
      // Another Session, and another request of the first: both join the key's open waiters.
      expect(await ask("s2", "signin-1")).toMatchObject({ status: "open", first: false });
      expect(await ask("s1", "signin-2")).toMatchObject({ status: "open", first: false });
      // A resume asks again with the same pair: the same waiter, still not a new first, and no second row.
      expect(await ask("s1", "signin-1")).toMatchObject({ status: "open", first: false });
      expect(signIns.waiters(keyHash("sentry"), NOW)).toHaveLength(3);
    }));

  it("is not applicable to an entry with its own Authorization header, client credentials or a stdio command, and keeps no waiter", () =>
    run(async ({ ask, setGlobal, signIns }) => {
      setGlobal({
        header: { url: SERVER_URL, headers: { Authorization: "Bearer ${TOKEN}" } },
        machine: {
          url: "https://mcp.machine.dev/mcp",
          oauth: {
            grantType: "client_credentials",
            clientId: "a",
            clientSecret: "${CLIENT_SECRET}",
            issuer: AS,
          },
        },
        local: { command: "node", args: ["server.js"] },
      });

      for (const server of ["header", "machine", "local"]) {
        expect(await ask("s1", "signin-1", { server }), server).toMatchObject({
          status: "not_applicable",
          reason: expect.any(String),
        });
      }

      expect(signIns.waiters("any", NOW)).toEqual([]);
    }));

  it("is unavailable for a server that is not in the set", () =>
    run(async ({ ask, setGlobal }) => {
      setGlobal({ sentry: { url: SERVER_URL } });

      expect(await ask("s1", "signin-1", { server: "nope" })).toMatchObject({
        status: "unavailable",
      });
    }));

  it("is signed_in once the owner has signed in, and drops the waiter the Session had", () =>
    run(async ({ ask, setGlobal, signIns, keyHash, completeFromSettings }) => {
      setGlobal({ sentry: { url: SERVER_URL } });
      await ask("s1", "signin-1");
      await completeFromSettings();

      expect(await ask("s1", "signin-1")).toEqual({ status: "signed_in" });
      expect(signIns.waiters(keyHash("sentry"), NOW + 2000)).toEqual([]);
    }));

  it("ends a step-up asked for too often with step_up_failed, and asks the owner for fewer", () =>
    run(async ({ ask, setGlobal, signIns, keyHash, completeFromSettings }) => {
      setGlobal({ sentry: { url: SERVER_URL } });
      await completeFromSettings();

      const hash = keyHash("sentry");

      signIns.update(
        hash,
        { status: "step_up", wantedScope: "read write", stepUpCount: STEP_UP_LIMIT - 1 },
        NOW + 2000,
      );
      expect(await ask("s1", "signin-1", { now: NOW + 3000 })).toMatchObject({
        status: "open",
        why: "step_up",
        scopes: ["read", "write"],
      });

      signIns.update(hash, { stepUpCount: STEP_UP_LIMIT }, NOW + 3000);
      expect(await ask("s1", "signin-2", { now: NOW + 4000 })).toMatchObject({
        status: "step_up_failed",
        scopes: ["read", "write"],
      });
      expect(signIns.waiters(hash, NOW + 4000)).toMatchObject([{ request: "signin-1" }]);
    }));

  it("says rejected for a sign-in the server refused", () =>
    run(async ({ ask, setGlobal, signIns, keyHash, completeFromSettings }) => {
      setGlobal({ sentry: { url: SERVER_URL } });
      await completeFromSettings();
      signIns.update(keyHash("sentry"), { status: "rejected" }, NOW + 2000);

      expect(await ask("s1", "signin-1", { now: NOW + 3000 })).toMatchObject({
        status: "open",
        why: "rejected",
      });
    }));
});

describe("a sign-in completed from Settings", () => {
  it("resolves every open Sign-in request of its key, across Sessions, and deletes their waiters", () =>
    run(async ({ ask, setGlobal, signIns, keyHash, completeFromSettings }) => {
      setGlobal({ sentry: { url: SERVER_URL } });
      await ask("s1", "signin-1");
      await ask("s1", "signin-2");
      await ask("s2", "signin-1");

      const answer = await completeFromSettings();

      expect(answer).toMatchObject({ status: "signed_in", server: "sentry" });
      expect("resolved" in answer ? answer.resolved : []).toEqual([
        { session: "s1", request: "signin-1" },
        { session: "s1", request: "signin-2" },
        { session: "s2", request: "signin-1" },
      ]);
      expect(signIns.waiters(keyHash("sentry"), NOW + 2000)).toEqual([]);
    }));

  it("resolves nothing for a waiter of another server's key", () =>
    run(async ({ ask, setGlobal, completeFromSettings }) => {
      setGlobal({
        sentry: { url: SERVER_URL },
        linear: { url: "https://mcp.linear.dev/mcp" },
      });
      await ask("s1", "signin-1", { server: "linear" });

      const answer = await completeFromSettings();

      expect("resolved" in answer ? answer.resolved : undefined).toEqual([]);
    }));
});

describe("a sign-in attempt that failed", () => {
  it("leaves every open Sign-in request in place, names them for the carrier, and shows the failure on the next ask", () =>
    run(async ({ ask, setGlobal, signIns, keyHash, completeFromSettings }) => {
      setGlobal({ sentry: { url: SERVER_URL } });
      await ask("s1", "signin-1");
      await ask("s2", "signin-1");

      const answer = await completeFromSettings({
        code: undefined,
        error: "server_error",
        errorDescription: "The server could not issue a code",
      });

      expect(answer).toMatchObject({
        status: "provider_error",
        message: "The server could not issue a code",
        waiting: [
          { session: "s1", request: "signin-1" },
          { session: "s2", request: "signin-1" },
        ],
      });
      expect(signIns.waiters(keyHash("sentry"), NOW + 2000)).toHaveLength(2);
      expect(await ask("s1", "signin-1", { now: NOW + 3000 })).toMatchObject({
        status: "open",
        first: false,
        problem: "The server could not issue a code",
      });
    }));
});

describe("mcpSignInWithdraw", () => {
  it("drops the waiter of a request that ended, and only that one", () =>
    run(async ({ ask, setGlobal, withdraw, signIns, keyHash }) => {
      setGlobal({ sentry: { url: SERVER_URL } });
      await ask("s1", "signin-1");
      await ask("s2", "signin-1");

      expect(withdraw("s1", "signin-1")).toEqual({ removed: true });
      expect(withdraw("s1", "signin-1")).toEqual({ removed: false });
      expect(signIns.waiters(keyHash("sentry"), NOW)).toMatchObject([{ session: "s2" }]);
    }));
});
