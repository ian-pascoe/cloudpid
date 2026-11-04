// A Modern server's questions through `McpHost.request` (`docs/architecture/mcp-server-requests.md` → Questions, The
// waiting-question record; ADR-0037): a `tools/call` whose caller keeps questions (`ctx.answers.defer`) is answered
// `InputRequired` with the server's `conn`, and `op: "resume"` sends it again with the answers, refused `ServerChanged`
// with nothing sent when the server's `conn` is another. The host passes the `ResumeState` on and keeps nothing.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off
// The engine's answers are written as they cross the edge, encoded, so their failures are plain `_tag` objects.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction */
import { ASK_TOOL, modernServer, rpcMethods } from "@cloudpid/mcp/testing";
import type {
  McpApplySet,
  McpEngineDiscoverResult,
  McpEngineRequestResult,
  McpHostRequest,
  McpSetEntry,
} from "@cloudpid/mcp/types";
import { env } from "cloudflare:workers";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineScript, TestMcpHost } from "./host.fixture.ts";

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

let counter = 0;

const freshHost = () => env.MCP_HOSTS.getByName(`mcp:questions${counter++}`);

const urlOf = (name: string) => `https://${name}.example/mcp`;

const entry = (name: string, server: Readonly<Record<string, Schema.Json>> = {}): McpSetEntry => ({
  name,
  source: { kind: "global" },
  server: { type: "http", url: urlOf(name), headers: {}, ...server },
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

const found = (tools: ReadonlyArray<string>): EngineScript => ({
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
    state: {
      era: { v: 1, era: "modern", version: "2026-07-28", discover: {}, probedAt: 1 },
    },
  } as typeof McpEngineDiscoverResult.Encoded,
});

/** A host whose set is `entries`, each discovered with `tools` by a scripted engine. */
const discovered = async (tools: ReadonlyArray<string>, ...entries: ReadonlyArray<McpSetEntry>) => {
  const host = freshHost();

  await host.apply(setOf(...entries));

  for (const each of entries) await host.scriptEngine(urlOf(each.name), [found(tools)]);

  await host.requestStart({
    caller: { session: "s-1", conversation: "1", workspace: "ws:w-1" },
    waitFor: entries.map((each) => each.name),
    waitMs: 5000,
  });

  return host;
};

const CTX = {
  origin: "agent",
  callId: "call-1",
  session: "s-1",
  conversation: "1",
  workspace: "ws:w-1",
  answers: { elicitation: true, defer: true },
} as const;

/** A `tools/call` of `tool` on `server` whose caller keeps questions. */
const call = (
  server: string,
  tool: string,
  args: Readonly<Record<string, Schema.Json>> = {},
): typeof McpHostRequest.Encoded => ({
  op: "tools/call",
  server,
  params: { name: tool, arguments: args },
  ctx: CTX,
});

const STATE = { v: 1, method: "tools/call", name: "search", arguments: {}, round: 1 };

/** The resume of `tool`'s call on `server`, asked on `conn`. */
const resume = (
  server: string,
  over: { readonly conn?: string; readonly tool?: string; readonly state?: Schema.Json } = {},
): typeof McpHostRequest.Encoded => ({
  op: "resume",
  server,
  params: {
    tool: over.tool ?? "search",
    conn: over.conn ?? `conn-${server}`,
    resume: over.state ?? STATE,
    answers: { q1: { action: "accept", content: { name: "Ada" } } },
  },
  ctx: CTX,
});

const QUESTION = {
  key: "q1",
  kind: "elicitation",
  params: { message: "Who?" },
  mode: "deferrable",
} as const;

const asked: typeof McpEngineRequestResult.Encoded = {
  kind: "input_required",
  requests: [QUESTION],
  resume: STATE,
  state: {},
};

const completed = (text: string): typeof McpEngineRequestResult.Encoded => ({
  kind: "complete",
  result: { kind: "inline", value: { content: [{ type: "text", text }] } },
  cacheable: false,
  fetchedAt: Date.now(),
  state: {},
});

describe("a server's questions through the host", () => {
  it("answers a call whose caller keeps questions InputRequired, with the server's conn and identity", async () => {
    const host = await discovered(["search"], entry("docs"));

    await host.scriptRequest(urlOf("docs"), [{ result: asked }]);

    expect(await host.request(call("docs", "search"), {})).toEqual({
      _tag: "InputRequired",
      requests: [QUESTION],
      resume: STATE,
      conn: "conn-docs",
      identity: "identity-docs",
    });
    expect((await host.engineRequests())[0]?.request.ctx).toMatchObject({
      answers: { elicitation: true, defer: true },
    });
  });

  it("fails a call that keeps no questions when the engine answers some", async () => {
    const host = await discovered(["search"], entry("docs"));

    await host.scriptRequest(urlOf("docs"), [{ result: asked }]);

    const keepsNone = call("docs", "search");

    expect(
      await host.request({ ...keepsNone, ctx: { ...CTX, answers: { elicitation: true } } }, {}),
    ).toMatchObject({ _tag: "CallFailed", error: { _tag: "ProtocolViolation" } });
  });

  it("sends a resume to the engine with the tool's definition, the state as it came and the answers", async () => {
    const host = await discovered(["search"], entry("docs"));

    await host.scriptRequest(urlOf("docs"), [{ result: completed("done") }, { result: asked }]);

    expect(await host.request(resume("docs"), {})).toMatchObject({ _tag: "Completed" });
    // Another round is InputRequired again.
    expect(await host.request(resume("docs"), {})).toMatchObject({ _tag: "InputRequired" });

    const [sent] = await host.engineRequests();

    expect(sent?.request).toEqual({
      op: "resume",
      tool: { name: "search", inputSchema: { type: "object" } },
      resume: STATE,
      answers: { q1: { action: "accept", content: { name: "Ada" } } },
      ctx: { origin: "agent", conversation: "1", workspace: "ws:w-1", answers: CTX.answers },
    });
  });

  it("answers ServerChanged, sending nothing, when the server's conn is not the one it asked on", async () => {
    const host = await discovered(["search"], entry("docs"));

    expect(await host.request(resume("docs", { conn: "conn-old" }), {})).toEqual({
      _tag: "ServerChanged",
      message: expect.stringContaining("changed since it asked"),
      conn: "conn-docs",
      identity: "identity-docs",
    });
    expect(await host.engineRequests()).toEqual([]);
  });

  it("refuses the resume of a tool the server no longer lists, or of a server switched off", async () => {
    const host = await discovered(["search"], entry("docs"), entry("off", { enabled: false }));

    expect((await host.request(resume("docs", { tool: "gone" }), {}))._tag).toBe("NotAllowed");
    expect((await host.request(resume("off"), {}))._tag).toBe("NotAllowed");
    expect(await host.engineRequests()).toEqual([]);
  });
});

describe("a server's questions through the real engine", () => {
  it("defers a Modern server's form, and its resume sends the call once more with the answer", async () => {
    const options = { moreTools: [ASK_TOOL], asked: [] };
    const server = modernServer(options);

    // Every outbound `fetch` of the test Worker, the engine's included, reaches the fake server.
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      server.handle(new Request(input, init)),
    );

    const host = freshHost();

    await host.useRealEngine();
    await host.apply(setOf(entry("docs")));
    await host.requestStart({
      caller: { session: "s-1", conversation: "1", workspace: "ws:w-1" },
      waitFor: ["docs"],
      waitMs: 10_000,
    });

    const first = await host.request(call("docs", "ask", { message: "Who are you?" }), {
      onInput: () => Promise.resolve({ kind: "defer" }),
    });

    expect(first).toMatchObject({
      _tag: "InputRequired",
      requests: [{ key: "q1", kind: "elicitation", mode: "deferrable" }],
      conn: "conn-docs",
    });

    if (!Predicate.isTagged(first, "InputRequired")) throw new Error("Expected InputRequired");

    const done = await host.request(resume("docs", { tool: "ask", state: first.resume }), {
      onInput: () => Promise.resolve({ kind: "defer" }),
    });

    expect(done).toMatchObject({
      _tag: "Completed",
      result: { kind: "inline", value: { content: [{ type: "text" }] } },
    });
    expect(rpcMethods(server).filter((method) => method === "tools/call")).toHaveLength(2);
    expect(options.asked).toEqual([
      expect.objectContaining({
        round: 1,
        responses: { q1: { action: "accept", content: { name: "Ada" } } },
      }),
    ]);
  });
});
