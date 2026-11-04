// `McpHost`'s server logs and spans over real Durable Object SQLite, a scripted Registry and a scripted engine
// (`docs/architecture/mcp-connections.md` → Telemetry; `mcp-in-a-session.md` → Server logging; `mcp.md` → Testing and
// tracing): the engine's logs come back in a discovery that passed it no hooks and are kept in a ring of 50 per server,
// `warning` and above are span events, `serverLog` reads storage only and never starts a Container, a discovery
// records the trace that caused it, and no span carries a value or a token.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off globalDate:off globalTimers:off newPromise:off strictEffectProvide:off
// The engine's answers are written as they cross the edge, encoded.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import { runInDurableObject } from "cloudflare:test";
import { refusingStorage } from "@cloudpid/effect-durable/sqlite/testing";
import {
  MCP_LOG_RING,
  type McpApplySet,
  type McpEngineDiscoverResult,
  type McpLogEntry,
  type McpServerLogResult,
  type McpSetEntry,
} from "@cloudpid/mcp/types";
import { env } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { describe, expect, it } from "vitest";
import { type EngineScript, hostServicesOver, type TestMcpHost } from "./host.fixture.ts";
import { serverLog } from "./host.ts";
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

const freshHost = () => env.MCP_HOSTS.getByName(`mcp:logs${counter++}`);

type Host = ReturnType<typeof freshHost>;

const SECRET = "sk-resolved-secret-0123456789";

const urlOf = (name: string) => `https://${name}.example/private/path?key=querysecret`;

const entry = (name: string, server: Partial<McpSetEntry["server"]> = {}): McpSetEntry => ({
  name,
  source: { kind: "global" },
  server: {
    type: "http",
    url: urlOf(name),
    headers: { authorization: "Bearer ${TOKEN}" },
    ...server,
  },
  hash: `hash-${name}`,
  conn: `conn-${name}`,
  identity: `identity-${name}`,
});

let revision = 1;

const setOf = (...entries: ReadonlyArray<McpSetEntry>): McpApplySet => ({
  kind: "set",
  hash: entries.map((each) => `${each.name}:${each.hash}`).join("|"),
  revision: revision++,
  entries,
});

type Encoded = typeof McpEngineDiscoverResult.Encoded;

const log = (n: number, level = "warning", logger?: string): McpLogEntry =>
  logger === undefined
    ? { at: n, level, data: `message ${n}` }
    : { at: n, level, logger, data: `message ${n}` };

/** A discovery that found one tool and heard `logs`. */
const hearing = (logs: ReadonlyArray<McpLogEntry>): EngineScript => ({
  // SAFETY: a discovered answer, encoded as the engine sends it.
  result: {
    kind: "discovered",
    era: "modern",
    protocolVersion: "2026-07-28",
    capabilities: { tools: {}, logging: {} },
    tools: [{ name: "search", inputSchema: { type: "object" } }],
    prompts: [],
    problems: [],
    fetchedAt: Date.now(),
    logs,
    state: {},
  } as Encoded,
});

const CALLER = { session: "s-1", conversation: "1", workspace: "w-1" };

/** The host discovered `name` once, hearing `logs`, and settled. */
const discovered = async (host: Host, name: string, logs: ReadonlyArray<McpLogEntry>) => {
  await host.scriptEngine(urlOf(name), [hearing(logs)]);
  await host.requestStart({ caller: CALLER, waitFor: [name], waitMs: 5000 });
};

const ringOf = async (host: Host, server: string) => {
  const answer = await host.serverLog({ server });

  if (!Predicate.isTagged(answer, "ServerLog")) throw new Error(JSON.stringify(answer));

  return answer.entries;
};

describe("a discovery's logs", () => {
  it("come back in the result of a discovery that passed only the deprecation hook, and are kept, oldest first", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("docs")));
    await discovered(host, "docs", [log(1, "info"), log(2, "warning", "disk"), log(3, "error")]);

    const [call] = await host.engineCalls();

    expect(call?.hooks).toEqual(["onDeprecated"]);
    expect(await ringOf(host, "docs")).toEqual([
      log(1, "info"),
      log(2, "warning", "disk"),
      log(3, "error"),
    ]);
  });

  it("are kept 50 to a server: a later discovery's push the oldest out", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("docs")));
    await discovered(
      host,
      "docs",
      Array.from({ length: 40 }, (_, n) => log(n)),
    );

    await host.scriptEngine(urlOf("docs"), [
      hearing(Array.from({ length: 40 }, (_, n) => log(100 + n))),
    ]);
    await host.apply({ kind: "reload" });
    await host.servers({ parts: [], waitMs: 5000 });

    const ring = await ringOf(host, "docs");

    expect(ring).toHaveLength(MCP_LOG_RING);
    expect(ring[0]).toEqual(log(30));
    expect(ring.at(-1)).toEqual(log(139));
  });

  it("are kept for a discovery that failed", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("docs")));
    await host.scriptEngine(urlOf("docs"), [
      {
        // SAFETY: a failure as it crosses the edge.
        result: {
          kind: "failed",
          error: { _tag: "ServerError", message: "403", status: 403 },
          logs: [log(1, "error", "auth")],
          state: {},
        } as Encoded,
      },
    ]);
    await host.requestStart({ caller: CALLER, waitFor: ["docs"], waitMs: 5000 });

    expect(await ringOf(host, "docs")).toEqual([log(1, "error", "auth")]);
  });

  it("cut what the engine did not: data to 2 KiB", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("docs")));
    await discovered(host, "docs", [{ at: 1, level: "warning", data: "x".repeat(5000) }]);

    expect((await ringOf(host, "docs"))[0]?.data).toHaveLength(2048);
  });
});

describe("serverLog", () => {
  it("answers an empty ring for a server never discovered, and NoServer for a name not in the set", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("docs")));

    expect(await host.serverLog({ server: "docs" })).toEqual({ _tag: "ServerLog", entries: [] });
    expect(await host.serverLog({ server: "nobody" })).toEqual({ _tag: "NoServer" });
  });

  it("reads storage only: it starts no discovery, asks nothing of the engine or the Registry, whatever Workspace is named", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("docs")));

    const before = await host.serverLog({ server: "docs", workspace: "w-1" });

    // Not a discovery, not a pull: nothing a Container could be woken by. The status stays as it was.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(before).toEqual({ _tag: "ServerLog", entries: [] });
    expect(await host.engineCalls()).toEqual([]);
    expect(await host.asked()).toEqual([]);
    // No status row: nothing ever started a discovery (`mcp_status` is the dump's fourth table).
    expect(JSON.parse(await host.dump())[3]).toEqual([]);
    expect(
      (await host.spans()).filter((span) => span.name === "mcp.server_log").length,
    ).toBeGreaterThan(0);
    expect((await host.spans()).map((span) => span.name)).not.toContain("mcp.discover");
  });

  it("answers `HostFailed` when the storage refuses, never an empty ring", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("docs")));

    await runInDurableObject(host, async (_instance: TestMcpHost, state) => {
      const gate = refusingStorage(state.storage);
      const layer = hostServicesOver(openMcpHostStore(gate.storage));

      gate.trip();

      const answer: McpServerLogResult = await Effect.runPromise(
        serverLog({ server: "docs" }).pipe(Effect.provide(layer)),
      );

      expect(Predicate.isTagged(answer, "HostFailed")).toBe(true);
    });
  });
});

describe("a discovery's spans", () => {
  it("raise a span event for each warning or above, with its data, and count them", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("docs")));
    await discovered(host, "docs", [log(1, "info"), log(2, "warning", "disk"), log(3, "error")]);

    const span = (await host.spans()).find((each) => each.name === "mcp.discover");

    expect(span?.events).toEqual([
      { name: "mcp.log", attributes: { level: "warning", logger: "disk", data: "message 2" } },
      { name: "mcp.log", attributes: { level: "error", logger: "", data: "message 3" } },
    ]);
    expect(span?.attributes).toMatchObject({
      server: "docs",
      "mcp.logs": 3,
      "mcp.log_warnings": 2,
      "mcp.outcome": "discovered",
      "mcp.era": "modern",
      "mcp.tools": 1,
      "mcp.state": "connected",
    });
  });

  it("record the trace of the invocation that caused a background discovery", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("docs")));
    await host.scriptEngine(urlOf("docs"), [hearing([])]);
    await host.requestStart({ caller: CALLER, waitFor: ["docs"], waitMs: 5000 });

    const spans = await host.spans();
    const cause = spans.find((each) => each.name === "mcp.request_start");
    const discovery = spans.find((each) => each.name === "mcp.discover");

    expect(cause?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(discovery?.attributes["mcp.cause_trace_id"]).toBe(cause?.traceId);
  });

  it("carry no value, token or URL path: the server's name, counts and states only", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("docs")));
    await host.scriptValues("docs", {
      status: "values",
      env: {},
      headers: { authorization: `Bearer ${SECRET}` },
      missing: [],
      redact: [SECRET],
    });
    await discovered(host, "docs", [log(1, "warning", "auth")]);
    await host.servers({ parts: ["tools", "status"] });
    await host.serverLog({ server: "docs" });

    const recorded = JSON.stringify(await host.spans());

    for (const value of [SECRET, "querysecret", "/private/path", "Bearer", "${TOKEN}"]) {
      expect(recorded).not.toContain(value);
    }

    expect((await host.spans()).map((span) => span.name)).toEqual(
      expect.arrayContaining([
        "mcp.request_start",
        "mcp.discover",
        "mcp.servers",
        "mcp.server_log",
      ]),
    );
  });
});
