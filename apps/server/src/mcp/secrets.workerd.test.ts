// workerd's Durable Object APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalJsonInEffect:off strictEffectProvide:off
// No resolved Secret reaches the host (`docs/architecture/mcp-configuration.md` → From the Registry to the host): a set
// built from a server whose header is `${TOKEN}`, while the Secret `TOKEN` is kept, holds the name only. Through the
// Registry's own storage and the main Worker's push, the set and its hash are the same with the Secret and without it,
// no log line of a push that really fails holds the value, and the host's tables hold `${TOKEN}` as written.
import { openKeptVault } from "@cloudpid/extensions/secrets/core";
import { refusingStorage } from "@cloudpid/effect-durable/sqlite/testing";
import type { McpApply, McpApplyResult, McpPush } from "@cloudpid/mcp/types";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Record from "effect/Record";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { keepSecret, usedSecrets } from "../registry/environment-secrets.ts";
import {
  environmentMcpSet,
  mcpServerValuesAnswer,
  pendingMcpPushes,
  readsSecrets,
} from "../registry/mcp-registry.ts";
import { writeSettings } from "../registry/settings.ts";
import type { TestRegistry } from "../registry/store.fixture.ts";
import { openRegistryStore } from "../registry/store.ts";
import { apply } from "./host.ts";
import { hostServicesOver, type TestMcpHost } from "./host.fixture.ts";
import { mcpPushes } from "./push.ts";
import { type McpHostStoreService, openMcpHostStore } from "./store.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly MCP_HOSTS: DurableObjectNamespace<TestMcpHost>;
    }
  }
}

const SECRET = "s3cret-value-9f2c";
const MASTER = "test-master-key-0123456789abcdef0123456789";
const ENVIRONMENT = "5a5a5a5a";

const global: Schema.Json = {
  mcp: {
    servers: {
      linear: {
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer ${TOKEN}" },
      },
    },
  },
};

/** What the Registry hands the main Worker to push, with the revision it gave left out (each look takes a new one). */
const pushedSet = (push: McpPush | undefined) => ({ ...push, set: { ...push?.set, revision: 0 } });

describe("a Secret an MCP server names", () => {
  it("is in no set, hash, log line or host table: only its name is", async () => {
    // The Registry's own storage, a kept Secret, and the set it hands the main Worker before and after.
    const { before, after, resolved } = await runInDurableObject(
      env.REGISTRIES.get(env.REGISTRIES.newUniqueId()),
      async (_: TestRegistry, state) => {
        const store = openRegistryStore(state.storage);

        store.createEnvironment(ENVIRONMENT, "Staging", 10);
        writeSettings(store, global, 5);

        const before = pendingMcpPushes(store, ENVIRONMENT, 6).pushes[0];
        const vault = await Effect.runPromise(openKeptVault(MASTER, "registry"));

        const kept = await Effect.runPromise(
          keepSecret(store, vault, { environment: ENVIRONMENT, name: "TOKEN", value: SECRET }, 7),
        );

        expect(kept.status).toBe("saved");

        const after = pendingMcpPushes(store, ENVIRONMENT, 8).pushes[0];

        // The Secret does resolve, where the Registry answers `mcpServerValues`, and only into that answer.
        const secrets = await Effect.runPromise(
          usedSecrets(store, Effect.succeed(vault), ENVIRONMENT),
        );

        const conn = environmentMcpSet(store, ENVIRONMENT)?.entries[0]?.conn ?? "";

        expect(readsSecrets(store, ENVIRONMENT, "linear")).toBe(true);

        return {
          before,
          after,
          resolved: mcpServerValuesAnswer(
            store,
            { environment: ENVIRONMENT, server: "linear", conn },
            Record.fromEntries(secrets.map(({ name, value }) => [name, value])),
          ),
        };
      },
    );

    expect(JSON.stringify(resolved)).toContain(SECRET);
    expect(before).toBeDefined();
    expect(pushedSet(after)).toEqual(pushedSet(before));
    expect(after?.set.hash).toBe(before?.set.hash);
    expect(JSON.stringify(after)).not.toContain(SECRET);
    expect(JSON.stringify(after)).toContain("Bearer ${TOKEN}");

    const set = after?.set;

    if (set === undefined) throw new Error("No set was pushed");

    // The push, to three hosts: one takes the set, one whose storage refuses answers a failure, and for one a call
    // throws. What the main Worker logs of the last two is what a real failure logs.
    const ok = env.MCP_HOSTS.getByName("mcp:secrets-ok");
    const refusing = env.MCP_HOSTS.getByName("mcp:secrets-refusing");
    const throwing = env.MCP_HOSTS.getByName("mcp:secrets-throwing");
    const logged: Array<string> = [];

    const collector = Logger.make((options) => {
      logged.push(`${JSON.stringify(options.message)} ${Cause.pretty(options.cause)}`);
    });

    const failing = <A>(
      stub: typeof refusing,
      run: (store: McpHostStoreService) => A | Promise<A>,
    ): Promise<A> =>
      runInDurableObject(stub, async (_: TestMcpHost, state) => {
        const gate = refusingStorage(state.storage);
        const store = openMcpHostStore(gate.storage);

        gate.trip();

        return await run(store);
      });

    const callHost = async (name: string, input: McpApply): Promise<McpApplyResult> => {
      if (name === "mcp:secrets-ok") return JSON.parse(JSON.stringify(await ok.apply(input)));

      if (name === "mcp:secrets-refusing") {
        return await failing(refusing, (store) =>
          Effect.runPromise(apply(input).pipe(Effect.provide(hostServicesOver(store)))),
        );
      }

      // The storage throws from `sql.exec` while the set is kept, and the call fails with it.
      await failing(throwing, (store) => {
        if (input.kind === "set") store.replaceSet(input);
      });

      throw new Error("The host did not answer");
    };

    const world = mcpPushes({
      registry: () => ({
        mcpPending: () =>
          Effect.succeed({
            pushes: ["ok", "refusing", "throwing"].map((name) => ({
              environment: `secrets-${name}`,
              set,
            })),
            wipes: [],
          }),
        mcpPushed: () => Effect.void,
        mcpDestroyed: () => Effect.void,
      }),
      host: (name) => ({ apply: (input) => Effect.promise(() => callHost(name, input)) }),
    });

    await Effect.runPromise(
      world
        .sync(undefined)
        .pipe(Effect.provideService(Logger.CurrentLoggers, new Set([collector]))),
    );

    const lines = logged.join("\n");

    // Both failures were logged, and neither line holds the value.
    expect(lines).toContain("secrets-refusing's MCP host did not take its server set");
    expect(lines).toContain("secrets-throwing's MCP server set was not sent");
    expect(lines).not.toContain(SECRET);

    const tables = await ok.dump();

    expect(tables).toContain("Bearer ${TOKEN}");
    expect(tables).not.toContain(SECRET);
  });
});
