// `McpHost` replaced by a code update mid-call (`docs/architecture/mcp-connections.md` → Deploys; [Deploys under deferred
// Durable Object code updates](https://github.com/ian-pascoe/cloudpid/issues/423) D3, D6): the old instance keeps running
// the calls it has, but every storage operation fails. The host returns the results it has, its writes are best-effort, and
// at its first failed storage operation it stops background work (discoveries, a call's App read, the upkeep of kept pages).
// `replace()` is `refusingStorage`'s `trip()` on the test host's storage; `refuse` and `refuseWrites` make a storage refuse single
// operations or only its writes, which makes each step visible. What a new instance finds is read through a new store over the same storage.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off
// The engine's answers are written as they cross the edge, encoded, so their failures are plain `_tag` objects.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import { APP_MIME_TYPE, modernServer, rpcMethods } from "@cloudpid/mcp/testing";
import type {
  McpApplySet,
  McpEngineDiscoverResult,
  McpEngineRequestResult,
  McpHostRequestInput,
  McpHostToolCall,
  McpSetEntry,
} from "@cloudpid/mcp/types";
import { env } from "cloudflare:workers";
import type * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineScript, RequestScript, TestMcpHost } from "./host.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly MCP_HOSTS: DurableObjectNamespace<TestMcpHost>;
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** `vi.waitFor`, with room for a loaded CI runner. */
const settles = <A>(check: () => Promise<A>) =>
  vi.waitFor(check, { timeout: 10_000, interval: 25 });

let counter = 0;

const freshHost = () => env.MCP_HOSTS.getByName(`mcp:replaced${counter++}`);

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
  hash: entries.map((each) => `${each.name}:${each.hash}`).join("|"),
  revision: revision++,
  entries,
});

const URI = "ui://docs/app";

const TOOLS = [
  { name: "echo", inputSchema: { type: "object" } },
  { name: "app", inputSchema: { type: "object" }, _meta: { ui: { resourceUri: URI } } },
] as const;

const MODERN = { v: 1, era: "modern", version: "2026-07-28", discover: {}, probedAt: 1 } as const;

/** A discovery that found `TOOLS`, its server `era`. */
const found = (era: "modern" | "legacy" = "modern"): EngineScript => ({
  // SAFETY: a discovered answer, encoded as the engine sends it.
  result: {
    kind: "discovered",
    era,
    protocolVersion: "2026-07-28",
    capabilities: { tools: {}, resources: {} },
    tools: TOOLS,
    prompts: [],
    problems: [],
    fetchedAt: Date.now(),
    state: {
      era: era === "modern" ? MODERN : { v: 1, era: "legacy", version: "2025-03-26", probedAt: 1 },
    },
  } as typeof McpEngineDiscoverResult.Encoded,
});

const complete = (
  value: Schema.Json,
  state: typeof McpEngineRequestResult.Encoded.state = {},
): typeof McpEngineRequestResult.Encoded => ({
  kind: "complete",
  result: { kind: "inline", value },
  cacheable: true,
  fetchedAt: Date.now(),
  state,
});

const CALLER = { session: "s-1", conversation: "1", workspace: "ws:w-1" };

const CTX = { origin: "agent", callId: "call-1", ...CALLER } as const;

const callTool = (
  tool: string,
  args: Readonly<Record<string, Schema.Json>> = { q: "x" },
): typeof McpHostToolCall.Encoded => ({
  op: "tools/call",
  server: "docs",
  params: { name: tool, arguments: args },
  ctx: CTX,
});

const htmlOf = (hash: string): typeof McpHostRequestInput.Encoded => ({
  op: "ui/html",
  server: "docs",
  params: { hash },
  ctx: CTX,
});

/** The `resources/read` answer: an App's page. */
const page = (text: string): RequestScript => ({
  op: "resources/read",
  result: complete({ contents: [{ uri: URI, mimeType: APP_MIME_TYPE, text }] }),
});

/** A host whose set is `entries` (each discovered like `docs`: a modern server), after its first request start. */
const discovered = async (era: "modern" | "legacy", ...entries: ReadonlyArray<McpSetEntry>) => {
  const host = freshHost();

  await host.apply(setOf(...entries));

  for (const each of entries) await host.scriptEngine(urlOf(each.name), [found(era)]);

  await host.requestStart({
    caller: CALLER,
    waitFor: entries.map((each) => each.name),
    waitMs: 5000,
  });

  return host;
};

const requestsOf = async (host: Host, op: string) =>
  (await host.engineRequests()).filter((each) => each.request.op === op);

describe("a host replaced mid-call", () => {
  it("returns the result of the call it holds, keeps nothing of it, and answers what it reads with HostFailed", async () => {
    const host = await discovered("modern", entry("docs"));
    const before = await host.prior("conn-docs");

    // The engine answers with a row of its own, which a host that still stored would keep.
    await host.scriptRequest(urlOf("docs"), [
      {
        result: complete(
          { content: [{ type: "text", text: "late" }] },
          { era: { ...MODERN, probedAt: 2 } },
        ),
        hold: true,
      },
    ]);

    const asked = host.request(callTool("echo"), {});

    await settles(async () => expect(await host.engineRequests()).toHaveLength(1));

    // The code update reaches the host while the call is out; then the engine answers.
    await host.replace();
    await host.release(urlOf("docs"));

    expect(await asked).toEqual({
      _tag: "Completed",
      result: { kind: "inline", value: { content: [{ type: "text", text: "late" }] } },
    });

    // What a new instance finds is what was there: the era row the call changed was not kept, and the status stands.
    expect(await host.prior("conn-docs")).toEqual(before);
    expect(await host.statuses()).toEqual({ "conn-docs": { state: "connected", failures: 0 } });

    // It reads nothing any more, and says so; and it starts nothing.
    expect(await host.startResult({ caller: CALLER })).toMatchObject({ _tag: "HostFailed" });
    expect(await host.serversResult({ parts: [] })).toMatchObject({ _tag: "HostFailed" });
    expect(await host.serverLog({ server: "docs" })).toMatchObject({ _tag: "HostFailed" });
    expect(await host.engineCalls()).toHaveLength(1);
  });

  it("returns an App tool's result without the page its read could not keep, and keeps no page", async () => {
    const host = await discovered("modern", entry("docs"));

    // A Modern server's page is read beside the call: both are out when the code update arrives.
    await host.scriptRequest(urlOf("docs"), [
      { result: complete({ content: [{ type: "text", text: "ok" }] }), hold: true },
      { ...page("<p>hello</p>"), hold: true },
    ]);

    const asked = host.request(callTool("app"), {});

    await settles(async () => expect(await host.engineRequests()).toHaveLength(2));
    await host.replace();
    await host.release(urlOf("docs"));

    // No `app`: a result never claims a page that was not kept.
    expect(await asked).toEqual({
      _tag: "Completed",
      result: { kind: "inline", value: { content: [{ type: "text", text: "ok" }] } },
    });
    expect(await host.appPages()).toEqual([]);
    expect(await host.appUiRows()).toEqual([]);
  });
});

describe("a host whose storage refuses an operation", () => {
  it("returns a call's result, and starts no read of the App's page after its row was refused", async () => {
    // A Legacy server with no session is read after the call, which has made its session.
    const host = await discovered("legacy", entry("docs"));

    await host.scriptRequest(urlOf("docs"), [
      { result: complete({ content: [{ type: "text", text: "ok" }] }) },
      page("<p>never asked for</p>"),
    ]);

    await host.refuse(["applyEngineState"]);

    expect(await host.request(callTool("app"), {})).toMatchObject({
      _tag: "Completed",
      result: { kind: "inline" },
    });

    // The refused write stopped background work, a call's App read included: the engine was not asked for the page.
    expect(await requestsOf(host, "resources/read")).toEqual([]);
    expect(await host.appPages()).toEqual([]);
  });

  it("serves a kept page whose mount it could not note, and stops background work at that refused write", async () => {
    const host = await discovered("modern", entry("docs"));

    await host.scriptRequest(urlOf("docs"), [
      { result: complete({ content: [{ type: "text", text: "ok" }] }) },
      page("<p>hello</p>"),
    ]);

    await host.request(callTool("app"), {});
    await settles(async () => expect(await host.appPages()).toHaveLength(1));

    const hash = (await host.appPages())[0]?.hash ?? "";

    // Noting that a View mounted the page is upkeep: its refusal costs the View nothing.
    await host.refuse(["touchApp"]);

    expect(await host.request(htmlOf(hash), {})).toMatchObject({
      _tag: "AppHtml",
      hash,
      html: "<p>hello</p>",
    });

    // The refused write stopped background work: a server new to the set is not discovered.
    await host.accept();
    await host.apply(setOf(entry("docs"), entry("later")));
    await host.scriptEngine(urlOf("later"), [found("modern")]);
    await host.requestStart({ caller: CALLER, waitFor: ["later"], waitMs: 300 });

    expect(await host.engineCalls()).toHaveLength(1);
  });

  it("stops background work at a read it cannot make, which it answers with HostFailed", async () => {
    const host = await discovered("modern", entry("docs"));

    await host.refuse(["statuses"]);
    expect(await host.startResult({ caller: CALLER })).toMatchObject({ _tag: "HostFailed" });

    // The storage answers again, but the instance has seen it fail: nothing new starts.
    await host.accept();
    await host.apply(setOf(entry("docs"), entry("later")));
    await host.scriptEngine(urlOf("later"), [found("modern")]);
    await host.requestStart({ caller: CALLER, waitFor: ["later"], waitMs: 300 });

    expect(await host.engineCalls()).toHaveLength(1);
  });

  it("returns a call's result when the server's logs cannot be kept, and stops background work there", async () => {
    const host = await discovered("modern", entry("docs"));

    await host.scriptRequest(urlOf("docs"), [
      {
        result: {
          ...complete({ content: [{ type: "text", text: "ok" }] }),
          logs: [{ at: 1, level: "info", data: '"said"' }],
        },
      },
    ]);

    await host.refuse(["putLogs"]);

    expect(await host.request(callTool("echo"), {})).toMatchObject({ _tag: "Completed" });

    await host.accept();
    await host.apply(setOf(entry("docs"), entry("later")));
    await host.scriptEngine(urlOf("later"), [found("modern")]);
    await host.requestStart({ caller: CALLER, waitFor: ["later"], waitMs: 300 });

    expect(await host.engineCalls()).toHaveLength(1);
  });

  it("stops background work when the pull at a Context Window cannot keep the set it was handed", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("docs")));
    await host.scriptEngine(urlOf("docs"), [found("modern")]);

    // The Registry hands a newer set, which the storage refuses.
    const next = setOf(entry("docs"), entry("later"));

    await host.script({
      hash: next.hash,
      signInsRevision: 0,
      revision: next.revision,
      set: next.entries,
    });
    await host.refuse(["replaceSet"]);
    await host.requestStart({ caller: CALLER, windowOpened: true, waitFor: ["docs"], waitMs: 300 });

    // `docs` was due, and nothing started it.
    expect(await host.engineCalls()).toEqual([]);
  });

  it("stops background work when an App's read cannot read the rows it passes the engine, and answers the mount with a failure", async () => {
    const host = await discovered("modern", entry("docs"));

    await host.refuse(["prior"]);

    expect(
      await host.request({ op: "ui/html", server: "docs", params: { uri: URI }, ctx: CTX }, {}),
    ).toMatchObject({ _tag: "HostFailed" });

    await host.accept();
    await host.apply(setOf(entry("docs"), entry("later")));
    await host.scriptEngine(urlOf("later"), [found("modern")]);
    await host.requestStart({ caller: CALLER, waitFor: ["later"], waitMs: 300 });

    expect(await host.engineCalls()).toHaveLength(1);
  });

  it("stops discovering at the first refused write, so a server added after it is not discovered", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("docs")));
    await host.scriptEngine(urlOf("docs"), [found("modern")]);
    await host.scriptEngine(urlOf("later"), [found("modern")]);

    // The discovery reaches the engine, and its inventory cannot be kept.
    await host.refuse(["putInventory"]);
    await host.requestStart({ caller: CALLER, waitFor: ["docs"], waitMs: 2000 });
    await settles(async () => expect(await host.engineCalls()).toHaveLength(1));

    // A server new to the set is due at once (a Session used the host a moment ago) but nothing starts it.
    await host.apply(setOf(entry("docs"), entry("later")));
    await host.requestStart({ caller: CALLER, waitFor: ["later"], waitMs: 300 });

    expect(await host.engineCalls()).toHaveLength(1);
    expect(await host.statuses()).not.toHaveProperty("conn-later");
  });
});

describe("a prior row of a format this build does not know", () => {
  it("is passed on as stored and read as absent by the engine, which probes again and writes its own", async () => {
    const server = modernServer();

    // Every outbound `fetch` of the test Worker, the engine's included, reaches the fake server.
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      server.handle(new Request(input, init)),
    );

    const host = freshHost();

    await host.useRealEngine();
    await host.apply(setOf(entry("docs")));
    await host.requestStart({ caller: CALLER, waitFor: ["docs"], waitMs: 10_000 });

    // A newer build's row for the connection, which this build's engine cannot read.
    const newer = JSON.stringify({ v: 2, era: "modern", version: "2099-01-01", extra: "unknown" });

    await host.seedEra("conn-docs", newer);
    server.received.length = 0;

    expect(await host.request(callTool("echo", { text: "hi" }), {})).toMatchObject({
      _tag: "Completed",
    });

    // The engine was given the row as it was stored, took it for no row, and probed again.
    expect(rpcMethods(server)).toContain("server/discover");
    expect(await host.prior("conn-docs")).toMatchObject({ era: { v: 1, era: "modern" } });
  });
});
