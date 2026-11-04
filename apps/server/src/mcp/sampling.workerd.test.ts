// What the host does about a server's Sampling requests (`docs/architecture/mcp-server-requests.md` → Sampling requests,
// Deprecation): the first one is noted on the server's status as `deprecated: ["sampling"]` and logged once per server
// per host lifetime, whichever way it comes (a scripted engine's note, and the real engine on a call that did not offer
// to answer it, which refuses it; the standalone stream is in the core's tests); and a stdio server's `sampling: "allow"`, which is not declared
// until its bridge carries questions, is told on its status as a problem, never silently.
// workerd's Durable Object and `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalDate:off
import { legacyStatefulServer, SAMPLE_TOOL } from "@cloudpid/mcp/testing";
import type {
  McpApplySet,
  McpEngineDiscoverResult,
  McpEngineRequestResult,
  McpHostRequest,
  McpSetEntry,
} from "@cloudpid/mcp/types";
import { env } from "cloudflare:workers";
import type * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TestMcpHost } from "./host.fixture.ts";
import { STDIO_SAMPLING_PROBLEM } from "./host.ts";

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

const freshHost = () => env.MCP_HOSTS.getByName(`mcp:sampling${counter++}`);

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

const CTX = {
  origin: "agent",
  callId: "call-1",
  session: "s-1",
  conversation: "1",
  workspace: "ws:w-1",
  answers: { sampling: true, inputWaitMs: 1000 },
} as const;

const call = (
  tool: string,
  args: Readonly<Record<string, Schema.Json>> = {},
): typeof McpHostRequest.Encoded => ({
  op: "tools/call",
  server: "docs",
  params: { name: tool, arguments: args },
  ctx: CTX,
});

const completed = (text: string): typeof McpEngineRequestResult.Encoded => ({
  kind: "complete",
  result: { kind: "inline", value: { content: [{ type: "text", text }] } },
  cacheable: false,
  fetchedAt: Date.now(),
  state: {},
});

const found: typeof McpEngineDiscoverResult.Encoded = {
  kind: "discovered",
  era: "legacy",
  protocolVersion: "2025-11-25",
  capabilities: { tools: {} },
  tools: [{ name: "search", inputSchema: { type: "object" } }],
  prompts: [],
  problems: [],
  fetchedAt: Date.now(),
  state: { era: { v: 1, era: "legacy", version: "2025-11-25", probedAt: 1 } },
};

const statusOf = async (host: ReturnType<typeof freshHost>) =>
  (await host.servers({ parts: ["status"] })).servers[0];

describe("the host and a server's Sampling requests", () => {
  it("notes the use of sampling on the server's status and logs it once, however many requests there are", async () => {
    const host = freshHost();

    await host.apply(setOf(entry("docs")));
    await host.scriptEngine(urlOf("docs"), [{ result: found }]);
    await host.requestStart({
      caller: { session: "s-1", conversation: "1", workspace: "ws:w-1" },
      waitFor: ["docs"],
      waitMs: 5000,
    });

    expect((await statusOf(host))?.status?.deprecated).toBeUndefined();

    await host.scriptRequest(urlOf("docs"), [
      { result: completed("one"), deprecated: ["sampling"] },
      { result: completed("two"), deprecated: ["sampling", "sampling"] },
    ]);
    await host.request(call("search"), {});
    await host.request(call("search"), {});

    expect((await statusOf(host))?.status?.deprecated).toEqual(["sampling"]);
    expect(
      (await host.observed()).split("used sampling, which the MCP spec deprecated"),
    ).toHaveLength(2);
  });

  it("notes it, through the real engine, for a request the call did not offer to answer, which is refused", async () => {
    const options = { moreTools: [SAMPLE_TOOL], sampled: [] };
    const server = legacyStatefulServer(options);

    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      server.handle(new Request(input, init)),
    );

    const host = freshHost();

    await host.useRealEngine();
    await host.apply(setOf(entry("docs", { sampling: "allow" })));
    await host.requestStart({
      caller: { session: "s-1", conversation: "1", workspace: "ws:w-1" },
      waitFor: ["docs"],
      waitMs: 10_000,
    });

    // A call that offered only to answer forms: the request is refused, never handed to the caller, and noted all the same.
    await host.request(
      { ...call("sample"), ctx: { ...CTX, answers: { elicitation: true, inputWaitMs: 1000 } } },
      { onInput: () => Promise.reject(new Error("never asked: the call did not offer it")) },
    );

    expect(options.sampled).toEqual([{ error: expect.any(String), code: -1 }]);
    expect((await statusOf(host))?.status?.deprecated).toEqual(["sampling"]);
  });

  it("tells a stdio server's `sampling: allow` on its status, as it is not declared yet", async () => {
    const host = freshHost();

    await host.apply(
      setOf(entry("docs"), {
        name: "local",
        source: { kind: "global" },
        server: { type: "stdio", command: "node", args: [], sampling: "allow" },
        hash: "hash-local",
        conn: "conn-local",
        identity: "identity-local",
      }),
    );

    const { servers } = await host.servers({ parts: [] });

    expect(servers.find((each) => each.name === "local")?.problems).toEqual([
      { problem: STDIO_SAMPLING_PROBLEM },
    ]);
    expect(servers.find((each) => each.name === "docs")?.problems).toEqual([]);
  });
});
