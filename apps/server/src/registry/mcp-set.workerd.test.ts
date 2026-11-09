// The MCP server set over the Registry's real storage (`docs/architecture/mcp-configuration.md` → From the Registry to the
// host): how many servers a Session's Settings say its Environment has. The set, its pushes and the host's pull are tested
// over an in-memory store in `mcp-registry.test.ts`.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
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
    });
  });

describe("the MCP server set over the Registry's storage", () => {
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
