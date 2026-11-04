// `McpHost`'s storage, `apply({ kind: "set" })`, `apply({ kind: "destroy" })` and the pull at `windowOpened` over real
// Durable Object SQLite and a scripted Registry (`docs/architecture/mcp-connections.md` → The host object, Storage,
// RPC; `mcp-configuration.md` → From the Registry to the host).
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off strictEffectProvide:off -- each test runs the host as an entry point.
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { refusingStorage } from "@cloudpid/effect-durable/sqlite/testing";
import {
  HostUnsupported,
  MCP_HOST_FEATURES,
  McpApplied,
  McpDestroyed,
  type McpApplyResult,
  type McpApplySet,
  type McpSetEntry,
  McpStale,
} from "@cloudpid/mcp/types";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import { apply, requestStart, servers } from "./host.ts";
import { hostServicesOver, type TestMcpHost } from "./host.fixture.ts";
import { openMcpHostStore } from "./store.ts";

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

const setOf = (hash: string, revision: number, ...names: ReadonlyArray<string>): McpApplySet => ({
  kind: "set",
  hash,
  revision,
  entries: names.map((name) => entry(name)),
});

/** Whether an `apply` answer is the generic failure. */
const failed = (result: McpApplyResult): boolean => Predicate.isTagged(result, "HostFailed");

const emptyAt = (revision: number): McpApplySet => ({
  kind: "set",
  hash: "empty",
  revision,
  entries: [],
});

const CALLER = { session: "s-1", conversation: "1", workspace: "w-1" };

describe("apply({ kind: 'set' })", () => {
  it("keeps the set as received, in order, and answers that it changed", async () => {
    const host = hostOf("a");

    expect(await host.apply(setOf("h1", 1, "linear", "docs", "alpha"))).toEqual(
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

    await host.apply(setOf("h1", 1, "linear"));

    expect(await host.apply(setOf("h1", 1, "linear"))).toEqual(
      McpApplied.make({ hash: "h1", changed: false }),
    );
  });

  it("replaces the whole set: a server that left is gone, and the order follows the new set", async () => {
    const host = hostOf("a");

    await host.apply(setOf("h1", 1, "linear", "docs"));
    await host.apply(setOf("h2", 2, "docs", "alpha"));

    const stored = await host.readSet();

    expect(stored?.hash).toBe("h2");
    expect(stored?.servers.map(({ name }) => name)).toEqual(["docs", "alpha"]);
  });

  it("keeps the set across an eviction, so a new instance reads what the old one kept", async () => {
    const host = hostOf("a");

    await host.apply(setOf("h1", 1, "linear"));
    await evictDurableObject(host);

    expect((await host.readSet())?.servers.map(({ name }) => name)).toEqual(["linear"]);
    expect(await host.apply(setOf("h1", 1, "linear"))).toEqual(
      McpApplied.make({ hash: "h1", changed: false }),
    );
  });

  it("keeps an empty set like any other: a host that never had a server holds it, and one that had holds no more", async () => {
    const never = hostOf("a");

    expect(await never.apply(emptyAt(1))).toEqual(
      McpApplied.make({ hash: "empty", changed: true }),
    );
    expect(await never.readSet()).toMatchObject({ hash: "empty", revision: 1, servers: [] });

    const had = hostOf("b");

    await had.apply(setOf("h1", 1, "linear"));

    expect(await had.apply(emptyAt(2))).toEqual(McpApplied.make({ hash: "empty", changed: true }));
    expect(await had.readSet()).toMatchObject({ hash: "empty", revision: 2, servers: [] });
  });

  it("refuses a set older than the one held as Stale, and keeps the held one, so an out-of-order push is harmless", async () => {
    const host = hostOf("a");

    await host.apply(setOf("h6", 6, "linear", "docs"));

    // Push 5 was slow: it arrives after the pull that handed out 6.
    expect(await host.apply(setOf("h5", 5, "alpha"))).toEqual(
      McpStale.make({ hash: "h6", revision: 6 }),
    );
    expect(await host.readSet()).toMatchObject({ hash: "h6", revision: 6 });
    expect((await host.readSet())?.servers.map(({ name }) => name)).toEqual(["linear", "docs"]);

    // The same set again under its own revision is held, not stale.
    expect(await host.apply(setOf("h6", 6, "linear", "docs"))).toEqual(
      McpApplied.make({ hash: "h6", changed: false }),
    );
  });

  it("takes the same set under a newer revision as unchanged, and raises the revision it holds", async () => {
    const host = hostOf("a");

    await host.apply(setOf("h1", 1, "linear"));

    expect(await host.apply(setOf("h1", 4, "linear"))).toEqual(
      McpApplied.make({ hash: "h1", changed: false }),
    );
    expect(await host.readSet()).toMatchObject({ hash: "h1", revision: 4 });
    expect(await host.apply(setOf("h0", 3, "alpha"))).toEqual(
      McpStale.make({ hash: "h1", revision: 4 }),
    );
  });

  it("keeps the revision across an eviction", async () => {
    const host = hostOf("a");

    await host.apply(setOf("h6", 6, "linear"));
    await evictDurableObject(host);

    expect(await host.apply(setOf("h5", 5, "docs"))).toEqual(
      McpStale.make({ hash: "h6", revision: 6 }),
    );
  });

  it("holds ${NAME} as written and nothing resolved: no value is in the tables", async () => {
    const host = hostOf("a");

    await host.apply({
      kind: "set",
      hash: "h1",
      revision: 1,
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
    const unknown = JSON.parse('{"kind":"pause_watches","revision":3}');

    expect(await host.apply(unknown)).toEqual(
      HostUnsupported.make({
        message: "This host does not know apply pause_watches",
        op: "pause_watches",
      }),
    );
    expect(await host.readSet()).toBeNull();
  });

  it("fails a set that is malformed as a failure that keeps nothing, and takes keys it does not know", async () => {
    const host = hostOf("a");

    expect(failed(await host.apply(JSON.parse('{"kind":"set","hash":"h"}')))).toBe(true);
    // No revision: it cannot be ordered against the one held.
    expect(failed(await host.apply(JSON.parse('{"kind":"set","hash":"h","entries":[]}')))).toBe(
      true,
    );
    expect(failed(await host.apply(JSON.parse("[]")))).toBe(true);
    expect(await host.readSet()).toBeNull();

    // A newer Registry's extra keys are dropped, not refused.
    const newer = JSON.parse(
      '{"kind":"set","hash":"h","revision":1,"later":1,"entries":[{"name":"a","source":{"kind":"workspace"},"server":{},"hash":"x","conn":"y","identity":"z","later":true}]}',
    );

    expect(await host.apply(newer)).toEqual(McpApplied.make({ hash: "h", changed: true }));
    expect((await host.readSet())?.servers[0]).toMatchObject({
      name: "a",
      source: { kind: "workspace" },
    });
  });

  it("answers with a failure, never a throw, while its storage refuses (a replaced instance), and a new instance reads what it kept", async () => {
    const host = hostOf("a");

    await host.apply(setOf("h1", 1, "linear"));

    await runInDurableObject(host, async (_instance: TestMcpHost, state) => {
      const gate = refusingStorage(state.storage);
      const store = openMcpHostStore(gate.storage);

      gate.trip();

      const result = await Effect.runPromise(
        apply(setOf("h2", 2, "other")).pipe(Effect.provide(hostServicesOver(store))),
      );

      expect(failed(result)).toBe(true);
    });

    await evictDurableObject(host);

    expect((await host.readSet())?.hash).toBe("h1");
  });
});

describe("a storage that refuses (a replaced instance)", () => {
  const CALLER = { session: "s-1", conversation: "1", workspace: "w-1" };

  it("answers `requestStart` and `servers` with `HostFailed` when it cannot read, never with no servers", async () => {
    const host = hostOf("refused");

    await host.apply(setOf("h1", 1, "linear"));

    await runInDurableObject(host, async (_instance: TestMcpHost, state) => {
      const gate = refusingStorage(state.storage);
      const layer = hostServicesOver(openMcpHostStore(gate.storage));

      gate.trip();

      const started = await Effect.runPromise(
        requestStart("refused", { caller: CALLER }).pipe(Effect.provide(layer)),
      );

      const listed = await Effect.runPromise(
        servers("refused", { parts: [] }).pipe(Effect.provide(layer)),
      );

      expect(Predicate.isTagged(started, "HostFailed")).toBe(true);
      expect(Predicate.isTagged(listed, "HostFailed")).toBe(true);
    });
  });

  it("still answers what it reads when only its writes are refused", async () => {
    const host = hostOf("writes");

    await host.apply(setOf("h1", 1, "linear"));

    await runInDurableObject(host, async (_instance: TestMcpHost, state) => {
      const refuse = () => {
        throw new Error("refused");
      };

      const store = { ...openMcpHostStore(state.storage), setMeta: refuse, putStatus: refuse };
      const layer = hostServicesOver(store);

      const started = await Effect.runPromise(
        requestStart("writes", { caller: CALLER }).pipe(Effect.provide(layer)),
      );

      expect(started).toMatchObject({ servers: { linear: { state: "not_discovered" } } });
    });
  });
});

const destroyAt = (revision: number) => JSON.parse(`{"kind":"destroy","revision":${revision}}`);

describe("apply({ kind: 'destroy' })", () => {
  it("wipes the storage, so the host holds nothing and takes a newer set again", async () => {
    const host = hostOf("a");

    await host.apply(setOf("h9", 9, "linear"));

    expect(await host.apply(destroyAt(10))).toEqual(McpDestroyed.make({}));
    expect(await host.readSet()).toBeNull();
    expect(await host.dump()).not.toContain("linear");

    // The tables are there again, empty: a newer set (an Environment made again) is kept.
    expect(await host.apply(setOf("h11", 11, "docs"))).toEqual(
      McpApplied.make({ hash: "h11", changed: true }),
    );
    expect((await host.readSet())?.servers.map(({ name }) => name)).toEqual(["docs"]);
  });

  it("refuses as Stale a set handed out before the wipe, however late it arrives, and keeps nothing", async () => {
    const host = hostOf("a");

    await host.apply(setOf("h9", 9, "linear"));
    await host.apply(destroyAt(10));

    // A push and a pull answered after the wipe, under revisions from before it, and one from the wipe itself.
    expect(await host.apply(setOf("h8", 8, "alpha"))).toEqual(
      McpStale.make({ hash: "", revision: 10 }),
    );
    expect(await host.apply(setOf("h10", 10, "alpha"))).toEqual(
      McpStale.make({ hash: "", revision: 10 }),
    );
    expect(await host.readSet()).toBeNull();

    await host.script({ hash: "h8", signInsRevision: 0, revision: 8, set: [entry("alpha")] });
    await host.requestStart({ caller: CALLER, windowOpened: true });

    expect(await host.readSet()).toBeNull();
  });

  it("keeps the floor across an eviction, and when it is wiped again with an older revision", async () => {
    const host = hostOf("a");

    await host.apply(setOf("h1", 1, "linear"));
    await host.apply(destroyAt(10));
    await evictDurableObject(host);

    expect(await host.apply(setOf("h9", 9, "alpha"))).toEqual(
      McpStale.make({ hash: "", revision: 10 }),
    );

    // The wipe sent again (its answer was lost): answered as before, and the floor does not drop.
    expect(await host.apply(destroyAt(4))).toEqual(McpDestroyed.make({}));
    expect(await host.apply(setOf("h9", 9, "alpha"))).toEqual(
      McpStale.make({ hash: "", revision: 10 }),
    );
  });

  it("answers a destroy that has no revision as a failure, and keeps the set", async () => {
    const host = hostOf("a");

    await host.apply(setOf("h1", 1, "linear"));

    expect(failed(await host.apply(JSON.parse('{"kind":"destroy"}')))).toBe(true);
    expect((await host.readSet())?.hash).toBe("h1");
  });

  it("answers with a failure, never a throw, while its storage refuses the wipe, and keeps what it held", async () => {
    const host = hostOf("a");

    await host.apply(setOf("h1", 1, "linear"));

    await runInDurableObject(host, async (_instance: TestMcpHost, state) => {
      const gate = refusingStorage(state.storage);
      const store = openMcpHostStore(gate.storage);

      gate.trip();

      const result = await Effect.runPromise(
        apply(destroyAt(2)).pipe(Effect.provide(hostServicesOver(store))),
      );

      expect(failed(result)).toBe(true);
    });

    await evictDurableObject(host);

    expect((await host.readSet())?.hash).toBe("h1");
  });
});

/** The names of the servers `requestStart` reports, `windowOpened` or not. */
const serversAfter = async (
  host: ReturnType<typeof hostOf>,
  windowOpened: boolean,
): Promise<ReadonlyArray<string>> =>
  Record.keys((await host.requestStart({ caller: CALLER, windowOpened })).servers);

describe("requestStart", () => {
  it("lists the features the host supports and reports the servers of the set it holds", async () => {
    const host = hostOf("a");
    const empty = await host.requestStart({ caller: CALLER });

    expect(empty).toMatchObject({
      features: MCP_HOST_FEATURES,
      servers: {},
      watches: { changed: [], ended: [] },
    });

    await host.apply(setOf("h1", 1, "linear"));

    const held = await host.requestStart({ caller: CALLER });

    expect(Record.keys(held.servers)).toEqual(["linear"]);
    expect(held.version).not.toBe(empty.version);
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
      revision: 1,
      set: [entry("linear"), entry("docs")],
    });

    const started = await host.requestStart({ caller: CALLER, windowOpened: true });

    expect(Record.keys(started.servers)).toEqual(["linear", "docs"]);
    expect((await host.readSet())?.servers.map(({ name }) => name)).toEqual(["linear", "docs"]);

    const [asked] = await host.asked();

    expect(asked?.environment).toMatch(/^staging/);
    expect(asked?.heldHash).toBeUndefined();
  });

  it("carries the hash it holds, and keeps its set when the Registry says it holds the current one", async () => {
    const host = hostOf("staging");

    await host.apply(setOf("h1", 1, "linear"));
    await host.script({ hash: "h1", signInsRevision: 0 });
    await host.requestStart({ caller: CALLER, windowOpened: true });

    expect((await host.asked())[0]?.heldHash).toBe("h1");
    expect((await host.readSet())?.servers.map(({ name }) => name)).toEqual(["linear"]);
  });

  it("heals a push that was lost: the Registry's newer set replaces the one held", async () => {
    const host = hostOf("staging");

    await host.apply(setOf("h1", 1, "linear"));
    await host.script({ hash: "h2", signInsRevision: 0, revision: 2, set: [entry("docs")] });

    expect(await serversAfter(host, true)).toEqual(["docs"]);
    expect((await host.readSet())?.servers.map(({ name }) => name)).toEqual(["docs"]);
  });

  it("keeps the set an answer carries only with its revision, which an older Registry would not give", async () => {
    const host = hostOf("staging");

    await host.script({ hash: "h1", signInsRevision: 0, set: [entry("linear")] });
    await host.requestStart({ caller: CALLER, windowOpened: true });

    expect(await host.readSet()).toBeNull();
  });

  it("does not let a pull bring back an older set than the one pushed meanwhile", async () => {
    const host = hostOf("staging");

    await host.apply(setOf("h7", 7, "linear"));
    await host.script({ hash: "h6", signInsRevision: 0, revision: 6, set: [entry("docs")] });

    expect(await serversAfter(host, true)).toEqual(["linear"]);
    expect((await host.readSet())?.servers.map(({ name }) => name)).toEqual(["linear"]);
  });

  it("raises the revision it holds when the Registry says it noted the held set as handed under a later one", async () => {
    const host = hostOf("staging");

    await host.apply(setOf("h1", 1, "linear"));
    await host.script({ hash: "h1", signInsRevision: 0, revision: 5 });
    await host.requestStart({ caller: CALLER, windowOpened: true });

    expect(await host.readSet()).toMatchObject({ hash: "h1", revision: 5 });

    // A push the Registry handed out before that pull, arriving late, is refused.
    expect(await host.apply(setOf("h3", 3, "docs"))).toEqual(
      McpStale.make({ hash: "h1", revision: 5 }),
    );
  });

  it("keeps the empty set under the revision the Registry noted for a host that held none, so an older push cannot fill it", async () => {
    const host = hostOf("staging");

    await host.script({ hash: "empty", signInsRevision: 0, revision: 5 });
    await host.requestStart({ caller: CALLER, windowOpened: true });

    expect(await host.readSet()).toMatchObject({ hash: "empty", revision: 5, servers: [] });
    expect(await host.apply(setOf("h3", 3, "docs"))).toEqual(
      McpStale.make({ hash: "empty", revision: 5 }),
    );
  });

  it("answers, holding what it has, when the Registry cannot be asked, and heals at the next window", async () => {
    const host = hostOf("staging");

    await host.apply(setOf("h1", 1, "linear"));
    await host.script(null);

    expect(await serversAfter(host, true)).toEqual(["linear"]);
    expect((await host.readSet())?.hash).toBe("h1");

    await host.script({ hash: "h2", signInsRevision: 0, revision: 2, set: [entry("docs")] });

    expect(await serversAfter(host, true)).toEqual(["docs"]);
  });

  it("pulls nothing for a host that no Environment names, and refuses a set", async () => {
    // A host not addressed as `mcp:<environment>` has none to ask the Registry about.
    const stray = env.MCP_HOSTS.getByName("stray");

    expect((await stray.requestStart({ caller: CALLER, windowOpened: true })).servers).toEqual({});
    expect(await stray.asked()).toEqual([]);
    expect(failed(await stray.apply(setOf("h1", 1, "linear")))).toBe(true);
    expect(await stray.readSet()).toBeNull();
  });
});
