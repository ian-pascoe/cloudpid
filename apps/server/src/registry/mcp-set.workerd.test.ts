// The MCP server set over the Registry's real storage (`docs/architecture/mcp-configuration.md` → From the Registry to the
// host): Settings saved at either Scope reach the set, the Environments a save pushes to, the host's pull, and how many
// servers a Session's Settings say its Environment has.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { runInDurableObject } from "cloudflare:test";
import { DEFAULT_ENVIRONMENT } from "@cloudpid/protocol";
import { env } from "cloudflare:workers";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { mcpServerSetAnswer, pendingMcpPushes, recordMcpPushed } from "./mcp-registry.ts";
import { EMPTY_MCP_SET_HASH } from "./mcp-set.ts";
import { sessionSettingsSource, updateSettingsOverrides, writeSettings } from "./settings.ts";
import type { TestRegistry } from "./store.fixture.ts";
import { openRegistryStore } from "./store.ts";

const STAGING = "5a5a5a5a";

const LINEAR = { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${TOKEN}" } };
const LOCAL = { command: "node", args: ["server.js"] };

const servers = (value: Schema.Json): Schema.Json => ({ mcp: { servers: value } });

/** Run `body` over a fresh Registry's store, with Environment `STAGING` beside Default. */
const inRegistry = <A>(
  body: (registry: {
    readonly store: ReturnType<typeof openRegistryStore>;
    readonly setGlobal: (overrides: Schema.Json) => void;
    readonly setOverrides: (environment: string, overrides: Schema.Json) => void;
    /** Hand every pending set to its host, as the main Worker does. */
    readonly push: (environment?: string) => ReadonlyArray<string>;
  }) => A,
) =>
  runInDurableObject(env.REGISTRIES.get(env.REGISTRIES.newUniqueId()), (_: TestRegistry, state) => {
    const store = openRegistryStore(state.storage);

    store.createEnvironment(STAGING, "Staging", 10);

    return body({
      store,
      setGlobal: (overrides) => {
        if (Result.isFailure(writeSettings(store, overrides, 5))) throw new Error("bad Global");
      },
      setOverrides: (environment, overrides) => {
        const saved = updateSettingsOverrides(state.storage, store, environment, {
          set: overrides,
        });

        if (saved === null || Result.isFailure(saved)) throw new Error("bad Overrides");
      },
      push: (environment) => {
        const pending = pendingMcpPushes(store, environment);

        for (const { environment: id, set } of pending) recordMcpPushed(store, id, set.hash, 6);

        return Arr.map(pending, ({ environment: id }) => id).sort();
      },
    });
  });

describe("the MCP server set over the Registry's storage", () => {
  it("reaches every Environment from a save at Global, and only those that changed from the next", () =>
    inRegistry(({ setGlobal, setOverrides, push, store }) => {
      // No server anywhere: nothing to push, so no host is woken.
      expect(push()).toEqual([]);

      setGlobal(servers({ linear: LINEAR }));

      expect(push()).toEqual([DEFAULT_ENVIRONMENT, STAGING].sort());
      expect(push()).toEqual([]);

      // Staging's own entry replaces Global's: only Staging's set changes.
      setOverrides(STAGING, servers({ linear: { url: "https://staging.example/mcp" } }));

      expect(push()).toEqual([STAGING]);

      // A Global edit that Staging's own entry hides reaches only Default.
      setGlobal(servers({ linear: { ...LINEAR, description: "issues" } }));

      expect(push()).toEqual([DEFAULT_ENVIRONMENT]);

      // An adjustment applies over Global's entry in force.
      setOverrides(DEFAULT_ENVIRONMENT, servers({ linear: { enabled: false } }));

      expect(push(DEFAULT_ENVIRONMENT)).toEqual([DEFAULT_ENVIRONMENT]);
      expect(
        mcpServerSetAnswer(store, { environment: DEFAULT_ENVIRONMENT, heldHash: "old" }).set?.[0]
          ?.server,
      ).toMatchObject({ enabled: false });
    }));

  it("pushes the empty set once, after the last server was removed", () =>
    inRegistry(({ setGlobal, push, store }) => {
      setGlobal(servers({ linear: LINEAR }));
      push();
      setGlobal({});

      expect(push()).toEqual([DEFAULT_ENVIRONMENT, STAGING].sort());
      expect(push()).toEqual([]);
      expect(mcpServerSetAnswer(store, { environment: STAGING })).toEqual({
        hash: EMPTY_MCP_SET_HASH,
        signInsRevision: 0,
      });
    }));

  it("answers the host's pull with the set it does not hold", () =>
    inRegistry(({ setGlobal, store }) => {
      setGlobal(servers({ linear: LINEAR, local: LOCAL }));

      const answer = mcpServerSetAnswer(store, { environment: STAGING });

      expect(Arr.map(answer.set ?? [], ({ name }) => name)).toEqual(["linear", "local"]);
      expect(mcpServerSetAnswer(store, { environment: STAGING, heldHash: answer.hash }).set).toBe(
        undefined,
      );
    }));

  it("tells a Session's Settings how many servers its Environment's set has", () =>
    inRegistry(({ setGlobal, setOverrides, store }) => {
      store.createSession(
        {
          id: "s-staging",
          title: null,
          workspace: {
            kind: "new",
            id: "0a1b2c3d",
            environment: STAGING,
            branch: "cloudpid/0a1b2c3d",
            base: null,
          },
          origin: null,
          marks: null,
          requestId: undefined,
        },
        20,
      );

      expect(sessionSettingsSource(store, "s-staging").mcp).toEqual({ servers: 0 });

      setGlobal(servers({ linear: LINEAR }));
      setOverrides(STAGING, servers({ local: LOCAL }));

      expect(sessionSettingsSource(store, "s-staging").mcp).toEqual({ servers: 2 });
      // A Session the Registry does not list has Global's.
      expect(sessionSettingsSource(store, "s-unlisted").mcp).toEqual({ servers: 1 });
    }));
});
