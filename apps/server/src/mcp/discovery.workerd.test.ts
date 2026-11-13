// `McpHost`'s discovery and MCP inventory over real Durable Object SQLite, a scripted Registry and a scripted engine
// (`docs/architecture/mcp-connections.md` → Discovery and the MCP inventory, Storage, Testing; `mcp.md` → Protocol eras):
// set diffs, stable versions, the 10 s wait, single-flight and the 3 slots, states and backoff, the era cache's drops,
// `servers` and `reload`, and what `destroy` aborts.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off globalDate:off globalTimers:off newPromise:off
// The engine's answers are written as they cross the edge, encoded, so their failures are plain `_tag` objects.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import { runInDurableObject } from "cloudflare:test";
import type {
  McpApplySet,
  McpEngineDiscoverResult,
  McpRequestStart,
  McpSetEntry,
} from "@cloudpid/mcp/types";
import { env } from "cloudflare:workers";
import type * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { DISCOVERY_DEADLINE_MS } from "./discovery.ts";
import type { EngineScript, TestMcpHost } from "./host.fixture.ts";
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

/** A host named as the main Worker names one, that no earlier test has touched. */
const freshHost = () => env.MCP_HOSTS.getByName(`mcp:discovery${counter++}`);

type Host = ReturnType<typeof freshHost>;

const urlOf = (name: string) => `https://${name}.example/mcp`;

const entry = (
  name: string,
  server: Readonly<Record<string, Schema.Json>> = {},
  extra: Partial<McpSetEntry> = {},
): McpSetEntry => ({
  name,
  source: { kind: "global" },
  server: { type: "http", url: urlOf(name), headers: {}, ...server },
  hash: `hash-${name}`,
  conn: `conn-${name}`,
  identity: `identity-${name}`,
  ...extra,
});

let revision = 1;

const setOf = (...entries: ReadonlyArray<McpSetEntry>): McpApplySet => ({
  kind: "set",
  hash: entries.map((each) => `${each.name}:${each.hash}:${each.conn}`).join("|"),
  revision: revision++,
  entries,
});

type Encoded = typeof McpEngineDiscoverResult.Encoded;

/** A discovery that found `tools` (by name), with the era row it kept. */
const found = (tools: ReadonlyArray<string>, extra: Partial<Encoded> = {}): EngineScript => ({
  // SAFETY: a discovered answer, encoded as the engine sends it, with the fields `extra` overrides.
  result: {
    kind: "discovered",
    era: "modern",
    protocolVersion: "2026-07-28",
    capabilities: { tools: {} },
    tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })),
    prompts: [],
    problems: [],
    fetchedAt: Date.now(),
    state: {
      era: { v: 1, era: "modern", version: "2026-07-28", discover: {}, probedAt: 1 },
    },
    ...extra,
  } as Encoded,
});

/** A discovery that failed with `error`, as the engine sends it. */
const failedWith = (
  error: Readonly<Record<string, Schema.Json>>,
  state: Readonly<Record<string, Schema.Json>> = {},
): EngineScript => ({
  // SAFETY: a failure as it crosses the edge; the host decodes it, an unknown tag included.
  result: { kind: "failed", error, state } as Encoded,
});

const unreachable = () => failedWith({ _tag: "Unreachable", message: "down" });

const CALLER = { session: "s-1", conversation: "1", workspace: "w-1" };

const start = (host: Host, more: Partial<McpRequestStart> = {}) =>
  host.requestStart({ caller: CALLER, ...more });

/** `requestStart` as a Session that built its tools before: it waits for nothing. */
const restart = (host: Host) => start(host, { known: "built" });

const stateOf = async (host: Host, name: string) => (await restart(host)).servers[name]?.state;

/** Wait for every discovery in flight to end (`servers` with its longest wait). */
const settled = (host: Host) => host.servers({ parts: [], waitMs: 10_000 });

const calls = async (host: Host) => (await host.engineCalls()).length;

const MINUTE = 60_000;

/** Long enough for a discovery that was started to reach the engine. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));

describe("discovery at the first request", () => {
  it("waits for the servers it is asked to, and answers them connected with their hashes", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("linear")));
    await host.scriptEngine(urlOf("linear"), [found(["search"])]);

    const answer = await start(host, { waitFor: ["linear"], waitMs: 5000 });

    expect(answer.servers.linear?.state).toBe("connected");
    expect(answer.servers.linear?.toolsHash).toMatch(/^[0-9a-f]{32}$/);
    expect(answer.version).toMatch(/^[0-9a-f]{32}$/);

    const [call] = await host.engineCalls();

    expect(call?.target).toMatchObject({ kind: "http", conn: "conn-linear", url: urlOf("linear") });
  });

  it("stops waiting at `waitMs`, answering `connecting`, and the discovery goes on in the background", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("slow")));
    await host.scriptEngine(urlOf("slow"), [{ ...found(["a"]), hold: true }]);

    expect((await start(host, { waitFor: ["slow"], waitMs: 200 })).servers.slow?.state).toBe(
      "connecting",
    );

    await host.release(urlOf("slow"));
    await settled(host);

    expect(await stateOf(host, "slow")).toBe("connected");
  });

  it("waits at most 10 s, whatever `waitMs` asks", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("stuck")));
    await host.scriptEngine(urlOf("stuck"), [{ ...found(["a"]), hold: true }]);

    const began = Date.now();

    await start(host, { waitFor: ["stuck"], waitMs: 60_000 });

    const waited = Date.now() - began;

    expect(waited).toBeGreaterThanOrEqual(9_500);
    expect(waited).toBeLessThan(15_000);

    await host.release(urlOf("stuck"));
  }, 30_000);

  it("does not wait for a caller that built its tools before, nor for servers it did not name", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("slow"), entry("other")));
    await host.scriptEngine(urlOf("slow"), [{ ...found(["a"]), hold: true }]);
    await host.scriptEngine(urlOf("other"), [{ ...found(["b"]), hold: true }]);

    const began = Date.now();
    const known = await start(host, { known: "v", waitFor: ["slow"], waitMs: 5000 });
    const unnamed = await start(host, { waitFor: ["nobody"], waitMs: 5000 });

    expect(Date.now() - began).toBeLessThan(3000);
    expect(known.servers.slow?.state).toBe("connecting");
    expect(unnamed.servers.other?.state).toBe("connecting");

    await host.release(urlOf("slow"));
    await host.release(urlOf("other"));
  });

  it("ends the wait for a server that settles at `sign_in`, `unavailable` or `failed`", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("auth"), entry("down"), entry("broken")));
    await host.scriptEngine(urlOf("auth"), [
      failedWith({ _tag: "SignInRequired", message: "401", rejected: false }),
    ]);
    await host.scriptEngine(urlOf("down"), [unreachable()]);
    await host.scriptEngine(urlOf("broken"), [
      failedWith({ _tag: "ServerError", message: "403", status: 403 }),
    ]);

    const began = Date.now();
    const answer = await start(host, { waitFor: ["auth", "down", "broken"], waitMs: 8000 });

    expect(Date.now() - began).toBeLessThan(5000);
    expect(answer.servers.auth?.state).toBe("sign_in");
    expect(answer.servers.down?.state).toBe("unavailable");
    expect(answer.servers.broken?.state).toBe("failed");
  });
});

describe("servers with demand: false", () => {
  it("answers what the host holds and starts no discovery, where a plain read starts the due one", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("linear")));
    await host.scriptEngine(urlOf("linear"), [found(["search"])]);

    const held = await host.servers({ parts: ["tools"], demand: false, waitMs: 5000 });

    await pause();

    expect(held.servers.map(({ name, state }) => [name, state])).toEqual([
      ["linear", "not_discovered"],
    ]);
    expect(await calls(host)).toBe(0);

    // The same read as a demand discovers it.
    await host.servers({ parts: [] });
    await vi.waitFor(async () => expect(await calls(host)).toBe(1));
    await settled(host);

    expect((await host.servers({ parts: [], demand: false })).servers[0]?.state).toBe("connected");
  });

  it("returns a stale `connecting` status to the state before it, and still starts no discovery", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("lost")));
    await host.scriptEngine(urlOf("lost"), [found(["search"])]);

    // What an instance that died mid-discovery left, with no backoff to hold a discovery back.
    await runInDurableObject(host, (_: TestMcpHost, state) => {
      openMcpHostStore(state.storage).putStatus({
        conn: "conn-lost",
        state: "connecting",
        since: Date.now(),
        failures: 0,
        previousState: "connected",
      });
    });

    const states = async () =>
      (await host.servers({ parts: [], demand: false })).servers.map(({ state }) => state);

    // Within 120 s, another instance may still be discovering it.
    expect(await states()).toEqual(["connecting"]);

    await host.advance(121_000);

    // Back to `connected`, where a demand would now discover (nothing holds it back): this read does not.
    expect(await states()).toEqual(["connected"]);

    await pause();

    expect(await calls(host)).toBe(0);
  });
});

describe("single-flight and slots", () => {
  it("discovers a `conn` once, however many reads ask while it runs", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("linear")));
    await host.scriptEngine(urlOf("linear"), [{ ...found(["a"]), hold: true }]);

    await restart(host);
    await restart(host);
    await host.servers({ parts: [] });

    await vi.waitFor(async () => expect(await calls(host)).toBe(1));

    await host.release(urlOf("linear"));
    await settled(host);

    expect(await calls(host)).toBe(1);
  });

  it("runs at most 3 discoveries at once, the next starting as one ends", async () => {
    const host = freshHost();
    const names = ["a", "b", "c", "d"];

    await host.apply(setOf(...names.map((name) => entry(name))));

    for (const name of names) {
      await host.scriptEngine(urlOf(name), [{ ...found([name]), hold: true }]);
    }

    await restart(host);
    await vi.waitFor(async () => expect(await calls(host)).toBe(3));
    await pause();

    expect(await calls(host)).toBe(3);

    await host.release(urlOf("a"));
    await vi.waitFor(async () => expect(await calls(host)).toBe(4));

    for (const name of names) await host.release(urlOf(name));
  });
});

describe("states and backoff", () => {
  it("retries an unavailable server only on demand once its backoff (30 s, then 1 min) is over", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("down")));
    await host.scriptEngine(urlOf("down"), [unreachable(), unreachable(), found(["a"])]);
    await start(host, { waitFor: ["down"] });

    const [first] = (await host.servers({ parts: ["status"] })).servers;

    expect(first).toMatchObject({ state: "unavailable", error: "down" });
    expect(first?.status).toMatchObject({ failures: 1 });

    await restart(host);
    expect(await calls(host)).toBe(1);

    await host.advance(31_000);
    await restart(host);
    await settled(host);
    expect(await calls(host)).toBe(2);

    // The second failure in a row waits a minute.
    await host.advance(31_000);
    await restart(host);
    expect(await calls(host)).toBe(2);

    await host.advance(30_000);
    await restart(host);
    await settled(host);
    expect(await calls(host)).toBe(3);
    expect(await stateOf(host, "down")).toBe("connected");
  });

  it("backs an unavailable server off 30 s, 1, 2, 5, then 10 min, and stays at 10 min", async () => {
    const host = freshHost();
    const steps = [30_000, MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 10 * MINUTE];

    await host.apply(setOf(entry("down")));
    await host.scriptEngine(urlOf("down"), Array.from({ length: 7 }, unreachable));
    await start(host, { waitFor: ["down"] });

    let expected = 1;

    for (const step of steps) {
      await host.advance(step - 1_000);
      await restart(host);
      expect(await calls(host)).toBe(expected);

      await host.advance(1_000);
      await restart(host);
      await settled(host);
      expected += 1;
      expect(await calls(host)).toBe(expected);
    }

    const [down] = (await host.servers({ parts: ["status"] })).servers;

    expect(down?.status).toMatchObject({ failures: 7 });
  });

  it("reads an engine out of reach as no failure of the server's: its state stays, held back 30 s", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("linear")));
    await host.scriptEngine(urlOf("linear"), [
      found(["a"]),
      { ...found(["a"]), reject: "Network connection lost." },
      found(["b"]),
    ]);
    await start(host, { waitFor: ["linear"] });

    await host.advance(11 * MINUTE);
    await restart(host);
    await settled(host);

    const [linear] = (await host.servers({ parts: ["status", "tools"] })).servers;

    expect(linear).toMatchObject({ state: "connected", status: { failures: 0 } });
    expect(linear?.error).toContain("Network connection lost.");
    expect(linear?.tools?.map((tool) => tool.name)).toEqual(["a"]);

    await restart(host);
    expect(await calls(host)).toBe(2);

    await host.advance(30_000);
    await restart(host);
    await settled(host);
    expect(await calls(host)).toBe(3);
  });

  it("gives up a discovery that outlives its deadline, holding the server back 30 s, and drops its answer", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("slow")));
    await host.scriptEngine(urlOf("slow"), [{ ...found(["late"]), hold: true }, found(["b"])]);
    await restart(host);
    await vi.waitFor(async () => expect(await calls(host)).toBe(1));
    expect(await stateOf(host, "slow")).toBe("connecting");

    await host.advance(DISCOVERY_DEADLINE_MS + 1_000);
    await restart(host);

    const [given] = (await host.servers({ parts: ["status"] })).servers;

    expect(given).toMatchObject({
      state: "not_discovered",
      error: "The discovery did not end in time",
    });
    expect(await calls(host)).toBe(1);

    await host.advance(30_000);
    await restart(host);
    await settled(host);

    expect(await calls(host)).toBe(2);
    expect(await stateOf(host, "slow")).toBe("connected");

    await host.release(urlOf("slow"));
    await settled(host);

    const [slow] = (await host.servers({ parts: ["tools"] })).servers;

    expect(slow?.tools?.map((tool) => tool.name)).toEqual(["b"]);
  });

  it("counts a discovery's deadline from when it holds a slot, not while it waits for one", async () => {
    const host = freshHost();
    const names = ["q1", "q2", "q3", "q4"];

    await host.apply(setOf(...names.map((name) => entry(name))));

    for (const name of names)
      await host.scriptEngine(urlOf(name), [{ ...found(["a"]), hold: true }]);

    await restart(host);
    await vi.waitFor(async () => expect(await calls(host)).toBe(3));

    await host.advance(DISCOVERY_DEADLINE_MS + 1_000);
    await restart(host);

    // The three that held their slots past the deadline are given up; the fourth, which waited, now runs.
    await vi.waitFor(async () => expect(await calls(host)).toBe(4));

    const answer = await restart(host);

    expect(answer.servers.q4?.state).toBe("connecting");
    expect(answer.servers.q1?.state).toBe("not_discovered");

    for (const name of names) await host.release(urlOf(name));
    await settled(host);
  });

  it("never retries a failed server on demand, and a set change retries it once a minute has passed", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("broken")));
    await host.scriptEngine(urlOf("broken"), [
      failedWith({ _tag: "ProtocolViolation", message: "not JSON-RPC" }),
      found(["a"]),
    ]);
    await start(host, { waitFor: ["broken"] });

    await host.advance(60 * MINUTE);
    await restart(host);
    expect(await calls(host)).toBe(1);

    await host.apply(setOf(entry("broken"), entry("new")));
    await settled(host);

    expect(await stateOf(host, "broken")).toBe("connected");
  });

  it("keeps a server at `sign_in` without asking it again on demand", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("auth")));
    await host.scriptEngine(urlOf("auth"), [
      failedWith({ _tag: "SignInRequired", message: "401", rejected: true }),
    ]);
    await start(host, { waitFor: ["auth"] });
    await host.advance(60 * MINUTE);

    expect(await stateOf(host, "auth")).toBe("rejected");
    expect(await calls(host)).toBe(1);
  });

  it("reads an engine failure it does not know as `failed`", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("odd")));
    await host.scriptEngine(urlOf("odd"), [failedWith({ _tag: "BrandNew", message: "?" })]);

    expect((await start(host, { waitFor: ["odd"] })).servers.odd?.state).toBe("failed");
  });

  it("returns a `connecting` status left by an instance that died to the state before it, after 120 s", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("lost")));

    // What an instance that died mid-discovery left: no discovery of this instance holds it.
    await runInDurableObject(host, (_: TestMcpHost, state) => {
      openMcpHostStore(state.storage).putStatus({
        conn: "conn-lost",
        state: "connecting",
        since: Date.now(),
        failures: 2,
        nextRetryAt: Date.now() + 10 * MINUTE,
        previousState: "unavailable",
      });
    });

    // Within 120 s, another instance may still be discovering it.
    expect(await stateOf(host, "lost")).toBe("connecting");

    await host.advance(121_000);

    // Back to `unavailable`, whose backoff still runs: no discovery yet.
    expect(await stateOf(host, "lost")).toBe("unavailable");
    expect(await calls(host)).toBe(0);
  });

  it("skips a server whose `${NAME}` resolves to nothing, and sends the resolved headers otherwise", async () => {
    const host = freshHost();
    const headers = { Authorization: "Bearer ${TOKEN}" };

    await host.apply(setOf(entry("vault", { headers })));
    await host.scriptValues("vault", {
      status: "values",
      env: {},
      headers,
      missing: ["TOKEN"],
    });

    const skipped = (await start(host, { waitFor: ["vault"] })).servers.vault;
    const [read] = (await host.servers({ parts: [] })).servers;

    expect(skipped?.state).toBe("skipped");
    expect(read?.error).toContain("${TOKEN}");
    expect(await calls(host)).toBe(0);

    await host.scriptValues("vault", {
      status: "values",
      env: {},
      headers: { Authorization: "Bearer sekrit-value" },
      missing: [],
    });
    await host.scriptEngine(urlOf("vault"), [found(["a"])]);
    await host.advance(MINUTE + 1);
    await restart(host);
    await settled(host);

    const [call] = await host.engineCalls();

    expect(call?.target).toMatchObject({ headers: { Authorization: "Bearer sekrit-value" } });
    expect(await stateOf(host, "vault")).toBe("connected");
    expect(await host.dump()).not.toContain("sekrit-value");
  });

  it("never discovers a server switched off or hidden", async () => {
    const host = freshHost();

    await host.apply(
      setOf(entry("off", { enabled: false }), entry("hidden", { exposure: "hidden" })),
    );

    const answer = await start(host, { waitFor: ["off", "hidden"] });

    expect(answer.servers.off?.state).toBe("disabled");
    expect(answer.servers.hidden?.state).toBe("disabled");
    expect(await calls(host)).toBe(0);
  });
});

describe("versions", () => {
  it("are stable over a refresh with the same content, move with it, and come back on a flip back", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("linear")));
    await host.scriptEngine(urlOf("linear"), [
      found(["a"]),
      found(["a"], { fetchedAt: Date.now() + 5 }),
      found(["a", "b"]),
      found(["a"]),
    ]);

    const first = (await start(host, { waitFor: ["linear"] })).version;

    expect((await restart(host)).version).toBe(first);

    /** Pass the TTL (10 min), and let the refresh it starts end. */
    const refreshed = async () => {
      await host.advance(11 * MINUTE);
      await restart(host);
      await settled(host);

      return (await restart(host)).version;
    };

    expect(await refreshed()).toBe(first);

    const grown = await refreshed();

    expect(grown).not.toBe(first);
    expect(await refreshed()).toBe(first);
    expect(await calls(host)).toBe(4);
  });

  it("move with a key outside `conn`, with no new discovery", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("linear")));
    await host.scriptEngine(urlOf("linear"), [found(["a"])]);

    const before = await start(host, { waitFor: ["linear"] });

    await host.apply(setOf(entry("linear", { description: "edited" }, { hash: "hash-edited" })));

    const after = await restart(host);

    expect(after.version).not.toBe(before.version);
    expect(after.servers.linear?.state).toBe("connected");
    expect(await calls(host)).toBe(1);
  });
});

describe("versions, prompts", () => {
  it("keep the prompts version over a change to the tools alone", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("linear")));
    await host.scriptEngine(urlOf("linear"), [found(["a"]), found(["b"])]);

    const before = await start(host, { waitFor: ["linear"] });

    await host.advance(11 * MINUTE);
    await restart(host);
    await settled(host);

    const after = await restart(host);

    expect(await calls(host)).toBe(2);
    expect(after.version).not.toBe(before.version);
    expect(after.servers.linear?.toolsHash).not.toBe(before.servers.linear?.toolsHash);
    expect(after.promptsVersion).toBe(before.promptsVersion);
    expect(after.servers.linear?.promptsHash).toBe(before.servers.linear?.promptsHash);
  });
});

describe("set diffs and the era cache", () => {
  it("drops a changed server's discovery unread, drops its era, rediscovers the new `conn`, and reuses the old inventory on a revert", async () => {
    const host = freshHost();
    const a = entry("linear");
    const b = entry("linear", { url: urlOf("moved") }, { hash: "hash-moved", conn: "conn-moved" });

    await host.apply(setOf(a));
    await host.scriptEngine(urlOf("linear"), [found(["a"]), { ...found(["a"]), hold: true }]);
    await start(host, { waitFor: ["linear"] });

    expect((await host.prior("conn-linear")).era).toMatchObject({ era: "modern" });

    // A refresh in flight when the server changes is dropped: its answer, once it comes, is never kept.
    await host.advance(11 * MINUTE);
    await restart(host);
    await vi.waitFor(async () => expect(await calls(host)).toBe(2));

    await host.scriptEngine(urlOf("moved"), [found(["b"])]);
    await host.apply(setOf(b));
    await settled(host);

    await host.release(urlOf("linear"));
    await settled(host);

    expect(await host.prior("conn-linear")).toEqual({});
    expect(await stateOf(host, "linear")).toBe("connected");
    expect((await host.engineCalls()).at(-1)?.target).toMatchObject({ url: urlOf("moved") });

    const moved = (await restart(host)).version;

    // Its lists' TTL passed meanwhile, so the kept inventory is served while it refreshes.
    await host.scriptEngine(urlOf("linear"), [{ ...found(["a"]), hold: true }]);
    await host.apply(setOf(a));

    const reverted = await host.servers({ parts: ["tools"] });

    expect(reverted.servers[0]?.state).toBe("connected");
    expect(reverted.servers[0]?.tools?.map((tool) => tool.name)).toEqual(["a"]);
    expect(reverted.version).not.toBe(moved);

    await host.release(urlOf("linear"));
  });

  it("discovers a server new to the set at once only if a Session used the host in the last 24 h", async () => {
    const idle = freshHost();

    await idle.scriptEngine(urlOf("linear"), [found(["a"])]);
    await idle.apply(setOf(entry("linear")));
    await pause();

    expect(await calls(idle)).toBe(0);

    await restart(idle);
    await settled(idle);
    expect(await calls(idle)).toBe(1);

    await idle.scriptEngine(urlOf("docs"), [found(["d"])]);
    await idle.apply(setOf(entry("linear"), entry("docs")));
    await settled(idle);
    expect(await calls(idle)).toBe(2);

    await idle.advance(25 * 60 * MINUTE);
    await idle.apply(setOf(entry("linear"), entry("docs"), entry("late")));
    await pause();
    expect(
      (await idle.engineCalls()).map((call) =>
        call.target.kind === "http" ? call.target.url : "",
      ),
    ).not.toContain(urlOf("late"));
  });

  it("passes the era row it keeps as `prior`, and drops it when the engine says so", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("linear")));
    await host.scriptEngine(urlOf("linear"), [
      found(["a"]),
      found(["a"], { state: { era: null } }),
      found(["a"]),
    ]);
    await start(host, { waitFor: ["linear"] });

    await host.advance(11 * MINUTE);
    await restart(host);
    await settled(host);

    const [, second] = await host.engineCalls();

    expect(second?.prior.era).toMatchObject({ v: 1, era: "modern" });
    expect(await host.prior("conn-linear")).toEqual({});
  });

  it("drops eras and Legacy sessions at a reload, and rediscovers at once, a failed server included", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("legacy")));
    await host.scriptEngine(urlOf("legacy"), [
      failedWith(
        { _tag: "ServerError", message: "bad" },
        {
          era: { v: 1, era: "legacy", version: "2025-11-25", probedAt: 1 },
          session: { v: 1, sessionId: "s" },
        },
      ),
      found(["a"], { era: "legacy", protocolVersion: "2025-11-25", state: {} }),
    ]);
    await start(host, { waitFor: ["legacy"] });

    expect(Object.keys(await host.prior("conn-legacy"))).toEqual(["era", "session"]);

    expect(
      await host.apply(JSON.parse('{"kind":"reload","servers":["legacy","missing"]}')),
    ).toEqual({ _tag: "Reloaded", servers: ["legacy"] });

    await settled(host);

    const [, second] = await host.engineCalls();

    expect(second?.prior).toEqual({});
    expect(await stateOf(host, "legacy")).toBe("connected");
  });
});

describe("reload and retention", () => {
  it("drops a discovery in flight at a reload before its rows, so its answer never writes them back", async () => {
    const host = freshHost();
    const stale = { v: 1, era: "modern", version: "stale", discover: {}, probedAt: 1 };

    await host.apply(setOf(entry("linear")));
    await host.scriptEngine(urlOf("linear"), [
      found(["a"]),
      { ...found(["a"], { state: { era: stale } }), hold: true },
      found(["b"], { state: {} }),
    ]);
    await start(host, { waitFor: ["linear"] });
    await host.advance(11 * MINUTE);
    await restart(host);
    await vi.waitFor(async () => expect(await calls(host)).toBe(2));

    await host.apply(JSON.parse('{"kind":"reload"}'));
    await settled(host);
    await host.release(urlOf("linear"));
    await settled(host);

    const third = (await host.engineCalls())[2];

    expect(third?.prior).toEqual({});
    expect(await host.prior("conn-linear")).toEqual({});
    expect(
      (await host.servers({ parts: ["tools"] })).servers[0]?.tools?.map((tool) => tool.name),
    ).toEqual(["b"]);
  });

  it("keeps the inventories of at most 20 servers that left the set, for 30 days", async () => {
    const host = freshHost();
    const names = Array.from({ length: 22 }, (_, index) => `s${index}`);

    for (const name of names) {
      await host.apply(setOf(entry(name)));
      await host.scriptEngine(urlOf(name), [found(["a"])]);
      await start(host, { waitFor: [name] });
      await host.advance(1_000);
    }

    // s0 to s20 left the set, s0 first: the 20 most recent are kept.
    const kept = await host.dump();

    expect(kept).not.toContain('"conn-s0"');
    expect(kept).toContain('"conn-s1"');
    expect(kept).toContain('"conn-s20"');

    await host.advance(31 * 24 * 60 * MINUTE);
    await host.apply(setOf(entry("last")));

    const pruned = await host.dump();

    expect(pruned).not.toContain('"conn-s1"');
    expect(pruned).not.toContain('"conn-s20"');
    expect(pruned).toContain('"conn-s21"');
  });
});

describe("servers", () => {
  it("answers each server's config, state and counts, and the parts asked for", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("linear"), entry("docs")));
    await host.scriptEngine(urlOf("linear"), [
      found(["a", "b"], {
        instructions: "Use it well",
        prompts: [{ name: "p" }],
        capabilities: { tools: {}, resources: {} },
      }),
    ]);
    await host.scriptEngine(urlOf("docs"), [unreachable()]);

    const answer = await host.servers({
      names: ["linear"],
      parts: ["tools", "prompts", "instructions", "status", "something-new"],
      waitMs: 5000,
    });

    expect(answer.servers).toHaveLength(1);
    expect(answer.servers[0]).toMatchObject({
      name: "linear",
      conn: "conn-linear",
      state: "connected",
      protocolVersion: "2026-07-28",
      counts: { tools: 2, prompts: 1 },
      resources: true,
      instructions: "Use it well",
      prompts: [{ name: "p" }],
      status: { failures: 0 },
    });
    expect(answer.servers[0]?.tools?.map((tool) => tool.name)).toEqual(["a", "b"]);

    const bare = (await host.servers({ parts: [], waitMs: 5000 })).servers;

    expect(bare.map((server) => [server.name, server.state])).toEqual([
      ["linear", "connected"],
      ["docs", "unavailable"],
    ]);
    expect(bare[0]?.tools).toBeUndefined();
  });

  it("answers a host with no set with no servers", async () => {
    expect((await freshHost().servers({ parts: ["tools"] })).servers).toEqual([]);
  });
});

describe("apply({ kind: 'destroy' })", () => {
  it("drops the discoveries in flight before it wipes the storage, and passes the engine no callback but the deprecation note", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("linear")));
    await host.scriptEngine(urlOf("linear"), [{ ...found(["a"]), hold: true }]);
    await restart(host);
    await vi.waitFor(async () => expect(await calls(host)).toBe(1));

    expect(await host.apply(JSON.parse(`{"kind":"destroy","revision":${revision++}}`))).toEqual({
      _tag: "Destroyed",
    });
    await host.release(urlOf("linear"));
    await settled(host);

    expect(await host.dump()).not.toContain("conn-linear");
    expect((await host.engineCalls()).map((call) => call.hooks)).toEqual([["onDeprecated"]]);
  });
});
