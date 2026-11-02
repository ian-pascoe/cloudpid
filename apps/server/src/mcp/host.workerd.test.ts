// `McpHost`'s storage, `apply({ kind: "set" })` and the pull at `windowOpened` over real Durable Object SQLite and a
// scripted Registry (`docs/architecture/mcp-connections.md` → The host object, Storage, RPC; `mcp-configuration.md` →
// From the Registry to the host).
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { refusingStorage } from "@cloudpid/effect-durable/sqlite/testing";
import {
  HostUnsupported,
  MCP_HOST_FEATURES,
  McpApplied,
  type McpApplyResult,
  type McpApplySet,
  type McpSetEntry,
} from "@cloudpid/mcp/types";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { apply } from "./host.ts";
import type { TestMcpHost } from "./host.fixture.ts";
import { McpHostStore, openMcpHostStore } from "./store.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly MCP_HOSTS: DurableObjectNamespace<TestMcpHost>;
    }
  }
}

let counter = 0;

/** A host named as the main Worker names one, `mcp:<environment id>`, that no earlier test has touched. */
const hostOf = (environment: string) => env.MCP_HOSTS.getByName(`mcp:${environment}${counter++}`);

const entry = (name: string, extra: Partial<McpSetEntry> = {}): McpSetEntry => ({
  name,
  source: { kind: "global" },
  server: { type: "http", url: `https://${name}.example/mcp`, headers: {} },
  hash: `hash-${name}`,
  conn: `conn-${name}`,
  identity: `identity-${name}`,
  ...extra,
});

const setOf = (hash: string, ...names: ReadonlyArray<string>): McpApplySet => ({
  kind: "set",
  hash,
  entries: names.map((name) => entry(name)),
});

/** Whether an `apply` answer is the generic failure. */
const failed = (result: McpApplyResult): boolean => Predicate.isTagged(result, "HostFailed");

const EMPTY: McpApplySet = { kind: "set", hash: "empty", entries: [] };

const CALLER = { session: "s-1", conversation: "1", workspace: "w-1" };

describe("apply({ kind: 'set' })", () => {
  it("keeps the set as received, in order, and answers that it changed", async () => {
    const host = hostOf("a");

    expect(await host.apply(setOf("h1", "linear", "docs", "alpha"))).toEqual(
      McpApplied.make({ hash: "h1", changed: true }),
    );

    expect(await host.readSet()).toMatchObject({
      hash: "h1",
      servers: [
        {
          name: "linear",
          entryHash: "hash-linear",
          conn: "conn-linear",
          identity: "identity-linear",
          source: { kind: "global" },
          server: { type: "http", url: "https://linear.example/mcp" },
        },
        { name: "docs" },
        { name: "alpha" },
      ],
    });
  });

  it("changes nothing for the set it holds", async () => {
    const host = hostOf("a");

    await host.apply(setOf("h1", "linear"));

    expect(await host.apply(setOf("h1", "linear"))).toEqual(
      McpApplied.make({ hash: "h1", changed: false }),
    );
  });

  it("replaces the whole set: a server that left is gone, and the order follows the new set", async () => {
    const host = hostOf("a");

    await host.apply(setOf("h1", "linear", "docs"));
    await host.apply(setOf("h2", "docs", "alpha"));

    const stored = await host.readSet();

    expect(stored?.hash).toBe("h2");
    expect(stored?.servers.map(({ name }) => name)).toEqual(["docs", "alpha"]);
  });

  it("keeps the set across an eviction, so a new instance reads what the old one kept", async () => {
    const host = hostOf("a");

    await host.apply(setOf("h1", "linear"));
    await evictDurableObject(host);

    expect((await host.readSet())?.servers.map(({ name }) => name)).toEqual(["linear"]);
    expect(await host.apply(setOf("h1", "linear"))).toEqual(
      McpApplied.make({ hash: "h1", changed: false }),
    );
  });

  it("keeps an empty set only after a non-empty one: it is never written for a host that holds none", async () => {
    const never = hostOf("a");

    expect(await never.apply(EMPTY)).toEqual(McpApplied.make({ hash: "empty", changed: false }));
    expect(await never.readSet()).toBeNull();

    const had = hostOf("b");

    await had.apply(setOf("h1", "linear"));

    expect(await had.apply(EMPTY)).toEqual(McpApplied.make({ hash: "empty", changed: true }));
    expect(await had.readSet()).toMatchObject({ hash: "empty", servers: [] });
  });

  it("holds ${NAME} as written and nothing resolved: no value is in the tables", async () => {
    const host = hostOf("a");

    await host.apply({
      kind: "set",
      hash: "h1",
      entries: [
        entry("linear", {
          server: {
            type: "http",
            url: "https://mcp.linear.app/mcp",
            headers: { Authorization: "Bearer ${TOKEN}" },
          },
        }),
      ],
    });

    const tables = await host.dump();

    expect(tables).toContain("Bearer ${TOKEN}");
    expect(tables).not.toContain("s3cret");
  });

  it("fails an operation it does not know as HostUnsupported, never as a decode error, and keeps nothing", async () => {
    const host = hostOf("a");

    // A newer caller's operation, which this build's `McpApply` does not list.
    const unknown = JSON.parse('{"kind":"sign_ins","revision":3}');

    expect(await host.apply(unknown)).toEqual(
      HostUnsupported.make({ message: "This host does not know apply sign_ins", op: "sign_ins" }),
    );
    expect(await host.readSet()).toBeNull();
  });

  it("fails a set that is malformed as a failure that keeps nothing, and takes keys it does not know", async () => {
    const host = hostOf("a");

    expect(failed(await host.apply(JSON.parse('{"kind":"set","hash":"h"}')))).toBe(true);
    expect(failed(await host.apply(JSON.parse("[]")))).toBe(true);
    expect(await host.readSet()).toBeNull();

    // A newer Registry's extra keys are dropped, not refused.
    const newer = JSON.parse(
      '{"kind":"set","hash":"h","later":1,"entries":[{"name":"a","source":{"kind":"workspace"},"server":{},"hash":"x","conn":"y","identity":"z","later":true}]}',
    );

    expect(await host.apply(newer)).toEqual(McpApplied.make({ hash: "h", changed: true }));
    expect((await host.readSet())?.servers[0]).toMatchObject({
      name: "a",
      source: { kind: "workspace" },
    });
  });

  it("answers with a failure, never a throw, while its storage refuses (a replaced instance), and a new instance reads what it kept", async () => {
    const host = hostOf("a");

    await host.apply(setOf("h1", "linear"));

    await runInDurableObject(host, async (_instance: TestMcpHost, state) => {
      const gate = refusingStorage(state.storage);
      const store = openMcpHostStore(gate.storage);

      gate.trip();

      const result = await Effect.runPromise(
        apply(setOf("h2", "other")).pipe(Effect.provideService(McpHostStore, store)),
      );

      expect(failed(result)).toBe(true);
    });

    await evictDurableObject(host);

    expect((await host.readSet())?.hash).toBe("h1");
  });
});

describe("requestStart", () => {
  it("lists the features the host supports and holds the set's hash as its version", async () => {
    const host = hostOf("a");

    expect(await host.requestStart({ caller: CALLER })).toEqual({
      version: "",
      promptsVersion: "",
      features: MCP_HOST_FEATURES,
      servers: {},
      watches: { changed: [], ended: [] },
    });

    await host.apply(setOf("h1", "linear"));

    expect((await host.requestStart({ caller: CALLER })).version).toBe("h1");
  });

  it("does not ask the Registry for the set unless a Context Window opened", async () => {
    const host = hostOf("a");

    await host.requestStart({ caller: CALLER });
    await host.requestStart({ caller: CALLER, windowOpened: false });

    expect(await host.asked()).toEqual([]);
  });

  it("pulls the set at windowOpened, asking for what it does not hold, and keeps it", async () => {
    const host = hostOf("staging");

    await host.script({
      hash: "h1",
      signInsRevision: 0,
      set: [entry("linear"), entry("docs")],
    });

    const started = await host.requestStart({ caller: CALLER, windowOpened: true });

    expect(started.version).toBe("h1");
    expect((await host.readSet())?.servers.map(({ name }) => name)).toEqual(["linear", "docs"]);

    const [asked] = await host.asked();

    expect(asked?.environment).toMatch(/^staging/);
    expect(asked?.heldHash).toBeUndefined();
  });

  it("carries the hash it holds, and keeps its set when the Registry says it holds the current one", async () => {
    const host = hostOf("staging");

    await host.apply(setOf("h1", "linear"));
    await host.script({ hash: "h1", signInsRevision: 0 });
    await host.requestStart({ caller: CALLER, windowOpened: true });

    expect((await host.asked())[0]?.heldHash).toBe("h1");
    expect((await host.readSet())?.servers.map(({ name }) => name)).toEqual(["linear"]);
  });

  it("heals a push that was lost: the Registry's newer set replaces the one held", async () => {
    const host = hostOf("staging");

    await host.apply(setOf("h1", "linear"));
    await host.script({ hash: "h2", signInsRevision: 0, set: [entry("docs")] });

    expect((await host.requestStart({ caller: CALLER, windowOpened: true })).version).toBe("h2");
    expect((await host.readSet())?.servers.map(({ name }) => name)).toEqual(["docs"]);
  });

  it("takes an empty answer for a host that holds none as nothing to keep", async () => {
    const host = hostOf("staging");

    await host.script({ hash: "empty", signInsRevision: 0, set: [] });
    await host.requestStart({ caller: CALLER, windowOpened: true });

    expect(await host.readSet()).toBeNull();
  });

  it("answers, holding what it has, when the Registry cannot be asked, and heals at the next window", async () => {
    const host = hostOf("staging");

    await host.apply(setOf("h1", "linear"));
    await host.script(null);

    expect((await host.requestStart({ caller: CALLER, windowOpened: true })).version).toBe("h1");
    expect((await host.readSet())?.hash).toBe("h1");

    await host.script({ hash: "h2", signInsRevision: 0, set: [entry("docs")] });

    expect((await host.requestStart({ caller: CALLER, windowOpened: true })).version).toBe("h2");
  });

  it("pulls nothing for a host that no Environment names, and refuses a set", async () => {
    // A host not addressed as `mcp:<environment>` has none to ask the Registry about.
    const stray = env.MCP_HOSTS.getByName("stray");

    expect((await stray.requestStart({ caller: CALLER, windowOpened: true })).version).toBe("");
    expect(await stray.asked()).toEqual([]);
    expect(failed(await stray.apply(setOf("h1", "linear")))).toBe(true);
    expect(await stray.readSet()).toBeNull();
  });
});
