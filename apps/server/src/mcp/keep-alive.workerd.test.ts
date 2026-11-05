// `McpHost`'s keep-alive (`docs/architecture/mcp-connections.md` → The host object, Discovery and the MCP inventory): the
// object holds an alarm about 30 s ahead while a discovery is in flight, armed again at each firing while one still is,
// and none once the last ends, however it ends. An alarm with nothing in flight, a fresh instance's after an eviction
// included, arms nothing and starts nothing.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off
// The engine's answers are written as they cross the edge, encoded, so their failures are plain `_tag` objects.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { McpApplySet, McpEngineDiscoverResult, McpSetEntry } from "@cloudpid/mcp/types";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { DISCOVERY_DEADLINE_MS } from "./discovery.ts";
import type { EngineScript, TestMcpHost } from "./host.fixture.ts";
import { KEEP_ALIVE_MS } from "./keep-alive.ts";

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
const freshHost = () => env.MCP_HOSTS.getByName(`mcp:keep-alive${counter++}`);

/** The host of the last `freshHost`, through a new stub: one made before a reset no longer reaches it. */
const lastHost = () => env.MCP_HOSTS.getByName(`mcp:keep-alive${counter - 1}`);

type Host = ReturnType<typeof freshHost>;

const urlOf = (name: string) => `https://${name}.example/mcp`;

const entry = (name: string): McpSetEntry => ({
  name,
  source: { kind: "global" },
  server: { type: "http", url: urlOf(name), headers: {} },
  hash: `hash-${name}`,
  conn: `conn-${name}`,
  identity: `identity-${name}`,
});

let revision = 1;

const setOf = (...entries: ReadonlyArray<McpSetEntry>): McpApplySet => ({
  kind: "set",
  hash: entries.map((each) => `${each.name}:${each.conn}`).join("|"),
  revision: revision++,
  entries,
});

type Encoded = typeof McpEngineDiscoverResult.Encoded;

/** A discovery that found `tools`, held until the test releases it. */
const heldFound = (tools: ReadonlyArray<string>): EngineScript => ({
  // SAFETY: a discovered answer, encoded as the engine sends it.
  result: {
    kind: "discovered",
    era: "modern",
    protocolVersion: "2026-07-28",
    capabilities: { tools: {} },
    tools: tools.map((name) => ({ name, inputSchema: { type: "object" } })),
    prompts: [],
    problems: [],
    fetchedAt: Date.now(),
    state: {},
  } as Encoded,
  hold: true,
});

/** A discovery that failed, held until the test releases it. */
const heldUnreachable = (): EngineScript => ({
  // SAFETY: a failure as it crosses the edge.
  result: { kind: "failed", error: { _tag: "Unreachable", message: "down" }, state: {} } as Encoded,
  hold: true,
});

const CALLER = { session: "s-1", conversation: "1", workspace: "w-1" };

/** `requestStart` as a Session that built its tools before: it starts what is due and waits for nothing. */
const restart = (host: Host) => host.requestStart({ caller: CALLER, known: "built" });

/** Wait for every discovery in flight to end (`servers` with its longest wait). */
const settled = (host: Host) => host.servers({ parts: [], waitMs: 10_000 });

const calls = async (host: Host) => (await host.engineCalls()).length;

/** When the object's alarm is set for, or null when none is. */
const alarmOf = (host: Host) =>
  runInDurableObject(host, (_instance: TestMcpHost, state) => state.storage.getAlarm());

/** Expect the alarm set about `KEEP_ALIVE_MS` from a time between `before` and now. */
const expectArmedSince = async (host: Host, before: number) => {
  const at = await alarmOf(host);

  expect(at).not.toBeNull();
  expect(at).toBeGreaterThanOrEqual(before + KEEP_ALIVE_MS);
  expect(at).toBeLessThanOrEqual(Date.now() + KEEP_ALIVE_MS);
};

/** A host with `name`'s discovery started and held at the engine, its alarm armed. */
const inFlight = async (name: string, script: EngineScript) => {
  const host = freshHost();

  await host.apply(setOf(entry(name)));
  await host.scriptEngine(urlOf(name), [script]);

  const before = Date.now();

  await restart(host);
  await vi.waitFor(async () => expect(await calls(host)).toBe(1));
  await expectArmedSince(host, before);

  return host;
};

describe("the keep-alive alarm", () => {
  it("is armed about 30 s ahead while a discovery is in flight, and not once it ends connected", async () => {
    expect(KEEP_ALIVE_MS).toBe(30_000);

    const host = await inFlight("linear", heldFound(["search"]));

    await host.release(urlOf("linear"));
    await settled(host);

    expect((await restart(host)).servers.linear?.state).toBe("connected");
    expect(await alarmOf(host)).toBeNull();
  });

  it("is not armed once a discovery ends failed", async () => {
    const host = await inFlight("down", heldUnreachable());

    await host.release(urlOf("down"));
    await settled(host);

    expect((await restart(host)).servers.down?.state).toBe("unavailable");
    expect(await alarmOf(host)).toBeNull();
  });

  it("is not armed once a discovery is interrupted by a set change", async () => {
    const host = await inFlight("gone", heldFound(["a"]));

    await host.apply(setOf());

    await vi.waitFor(async () => expect(await alarmOf(host)).toBeNull());
    await host.release(urlOf("gone"));
  });

  it("is not armed once a discovery is given up past its 360 s slot", async () => {
    const host = await inFlight("slow", heldFound(["late"]));

    await host.advance(DISCOVERY_DEADLINE_MS + 1_000);
    await restart(host);

    expect((await host.servers({ parts: [] })).servers[0]?.error).toBe(
      "The discovery did not end in time",
    );
    await vi.waitFor(async () => expect(await alarmOf(host)).toBeNull());
    await host.release(urlOf("slow"));
  });

  it("stays armed while any discovery is in flight, and goes once the last ends", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("one"), entry("two")));
    await host.scriptEngine(urlOf("one"), [heldFound(["a"])]);
    await host.scriptEngine(urlOf("two"), [heldFound(["b"])]);
    await restart(host);
    await vi.waitFor(async () => expect(await calls(host)).toBe(2));

    await host.release(urlOf("one"));
    await vi.waitFor(async () =>
      expect((await restart(host)).servers.one?.state).toBe("connected"),
    );
    expect(await alarmOf(host)).not.toBeNull();

    await host.release(urlOf("two"));
    await settled(host);
    expect(await alarmOf(host)).toBeNull();
  });

  it("arms itself again at each firing while a discovery is still in flight", async () => {
    const host = await inFlight("slow", heldFound(["a"]));

    for (const _firing of [1, 2]) {
      const before = Date.now();

      expect(await runDurableObjectAlarm(host)).toBe(true);
      await expectArmedSince(host, before);
    }

    await host.release(urlOf("slow"));
    await settled(host);
    expect(await alarmOf(host)).toBeNull();
  });

  it("arms nothing and starts nothing when it fires with nothing in flight", async () => {
    const host = await inFlight("slow", heldFound(["a"]));

    await host.release(urlOf("slow"));
    await settled(host);

    // As an alarm left from before would: set, then fired, with no discovery in flight.
    await runInDurableObject(host, (_instance: TestMcpHost, state) =>
      state.storage.setAlarm(Date.now() + KEEP_ALIVE_MS),
    );

    expect(await runDurableObjectAlarm(host)).toBe(true);
    expect(await alarmOf(host)).toBeNull();
    expect(await calls(host)).toBe(1);
  });

  it("arms nothing and starts nothing when it fires on a fresh instance after an eviction or deploy", async () => {
    await inFlight("slow", heldFound(["a"]));

    // The instance that ran the discovery is gone, with its fiber; its alarm is still set. (A graceful eviction waits
    // for the discovery's own deadline timer, so the instance is reset instead.)
    await abortAllDurableObjects();

    const host = lastHost();

    expect(await alarmOf(host)).not.toBeNull();

    expect(await runDurableObjectAlarm(host)).toBe(true);
    expect(await alarmOf(host)).toBeNull();
    expect(await calls(host)).toBe(0);
  });

  it("is never armed for an Environment with no discovery in flight", async () => {
    const empty = freshHost();

    await empty.apply(setOf());
    await restart(empty);
    await empty.servers({ parts: ["tools"] });
    expect(await alarmOf(empty)).toBeNull();

    // A failed server is not retried on demand: reads start nothing, so nothing holds the object.
    const failed = freshHost();

    await failed.apply(setOf(entry("broken")));
    await failed.scriptEngine(urlOf("broken"), [
      {
        // SAFETY: a failure as it crosses the edge.
        result: {
          kind: "failed",
          error: { _tag: "ProtocolViolation", message: "bad" },
          state: {},
        } as Encoded,
      },
    ]);
    await restart(failed);
    await settled(failed);
    expect((await restart(failed)).servers.broken?.state).toBe("failed");

    await restart(failed);
    await failed.servers({ parts: ["status"], waitMs: 100 });
    expect(await calls(failed)).toBe(1);
    expect(await alarmOf(failed)).toBeNull();
  });
});
