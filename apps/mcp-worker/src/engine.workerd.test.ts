// workerd's RPC and `cloudflare:test` APIs are Promise-based, so this file is too.
// Plain assertions over RPC results: Promise-based, decoding synchronously.
// @effect-diagnostics asyncFunction:off globalFetch:off schemaSync:off newPromise:off globalTimers:off preferEffectArray:off
import { env } from "cloudflare:workers";
import type { McpEngineMethods } from "@cloudpid/mcp/types";
import {
  Cut,
  McpEngineDiscoverResult,
  McpEngineRequestResult,
  Unsupported,
} from "@cloudpid/mcp/types";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import type { Caller } from "./workerd.fixture.ts";

declare global {
  namespace Cloudflare {
    /** The bindings `vitest.config.ts` gives the test Worker. */
    interface Env {
      readonly MCP_ENGINE: McpEngineMethods;
      readonly MCP_WORKER: Fetcher;
      readonly FAKES: Fetcher;
      readonly CALLERS: DurableObjectNamespace<Caller>;
    }
  }
}

/** A target on a fake of `kind`, fresh for `key`. */
const target = (kind: "modern" | "legacy" | "stateful" | "headers", key: string) => ({
  kind: "http" as const,
  conn: `conn-${key}`,
  name: key,
  url: `https://${kind}.test/${key}/mcp`,
});

const AGENT = { origin: "agent" as const, conversation: "conversation-1" };

const ECHO = { name: "echo", inputSchema: { type: "object" } };

/** What the fake behind `server` received and which of its calls were cancelled. */
const seen = async (server: ReturnType<typeof target>) => {
  const response = await env.FAKES.fetch(server.url.replace(/\/mcp$/, "/_seen"));

  // SAFETY: the fakes Worker answers `_seen` with this shape (`fakes.fixture.ts`).
  return (await response.json()) as {
    methods: Array<string>;
    notifications: Array<string>;
    cancelled: Array<string>;
  };
};

const decodeRequest = Schema.decodeSync(McpEngineRequestResult);

const MiB = 1024 * 1024;

const BIG = { name: "big", inputSchema: { type: "object" } };

/** A `tools/call` of the fakes' `big` tool, answering `bytes` bytes of text. */
const bigCall = (bytes: number) =>
  ({ op: "tools/call", tool: BIG, arguments: { bytes }, ctx: AGENT }) as const;

/** The text of a streamed `tools/call` result. */
const streamedText = async (result: ReturnType<typeof decodeRequest>) => {
  if (result.kind !== "complete" || result.result.kind !== "stream") {
    throw new Error(`not a streamed result: ${JSON.stringify(result)}`);
  }

  // SAFETY: the stream carries a `tools/call` result's JSON.
  const value = (await new Response(result.result.body).json()) as {
    content: Array<{ text: string }>;
  };

  return value.content[0]?.text ?? "";
};

/** Hooks of a caller that never aborts. */
const patient = () => ({ untilAborted: () => new Promise<void>(() => undefined) });

describe("McpWorker", () => {
  it("answers an HTTP request with 404", async () => {
    const response = await env.MCP_WORKER.fetch("https://mcp-worker.example/");

    expect(response.status).toBe(404);
  });
});

describe("discover", () => {
  it("discovers a Modern server: its era, tools and prompts, and keeps its era row", async () => {
    const discovered = Schema.decodeSync(McpEngineDiscoverResult)(
      await env.MCP_ENGINE.discover(target("modern", "discover-modern"), {}, patient()),
    );

    expect(discovered).toMatchObject({
      kind: "discovered",
      era: "modern",
      protocolVersion: "2026-07-28",
      instructions: "Use the echo tool.",
      state: { era: { v: 1, era: "modern", version: "2026-07-28" } },
    });
  });
});

describe("discover, Legacy", () => {
  it("discovers a stateless Legacy server, keeping its era row and no session", async () => {
    const discovered = Schema.decodeSync(McpEngineDiscoverResult)(
      await env.MCP_ENGINE.discover(target("legacy", "discover-legacy"), {}, patient()),
    );

    expect(discovered).toMatchObject({
      kind: "discovered",
      era: "legacy",
      protocolVersion: "2025-11-25",
      state: { era: { v: 1, era: "legacy", version: "2025-11-25" }, session: null },
    });
    expect(discovered.kind === "discovered" && discovered.tools.map((tool) => tool.name)).toEqual([
      "echo",
      "shout",
      "big",
      "hang",
      "typed",
      "region",
    ]);
  });

  it("keeps a stateful Legacy server's session row, and goes on with it with no initialize", async () => {
    const server = target("stateful", "discover-stateful");

    const discovered = Schema.decodeSync(McpEngineDiscoverResult)(
      await env.MCP_ENGINE.discover(server, {}, patient()),
    );

    expect(discovered.state.session).toMatchObject({ v: 1, sessionId: "session-1" });

    const called = decodeRequest(
      await env.MCP_ENGINE.request(
        server,
        discovered.state,
        { op: "tools/call", tool: ECHO, arguments: { text: "again" }, ctx: AGENT },
        patient(),
      ),
    );

    expect(called).toMatchObject({
      kind: "complete",
      result: { kind: "inline", value: { content: [{ type: "text", text: "again" }] } },
      state: {},
    });
    expect((await seen(server)).methods.filter((method) => method === "initialize")).toHaveLength(
      1,
    );
  });
});

describe("request", () => {
  it("calls a tool on a Modern server from its era row, with no round trip before the call", async () => {
    const server = target("modern", "call-modern");

    const discovered = Schema.decodeSync(McpEngineDiscoverResult)(
      await env.MCP_ENGINE.discover(server, {}, patient()),
    );

    const before = (await seen(server)).methods.length;

    const called = decodeRequest(
      await env.MCP_ENGINE.request(
        server,
        discovered.state,
        { op: "tools/call", tool: ECHO, arguments: { text: "hi" }, ctx: AGENT },
        patient(),
      ),
    );

    expect(called).toMatchObject({
      kind: "complete",
      result: { kind: "inline", value: { content: [{ type: "text", text: "hi" }] } },
      cacheable: true,
    });
    expect((await seen(server)).methods.slice(before)).toEqual(["tools/call"]);
  });

  it("walks every page of a list", async () => {
    const listed = decodeRequest(
      await env.MCP_ENGINE.request(
        target("legacy", "list-legacy"),
        {},
        { op: "tools/list", ctx: AGENT },
        patient(),
      ),
    );

    expect(listed).toMatchObject({ kind: "complete", result: { kind: "inline" } });
    expect(
      listed.kind === "complete" &&
        listed.result.kind === "inline" &&
        Array.isArray(listed.result.value) &&
        listed.result.value.length,
    ).toBe(6);
  });

  it("fails an op it does not know as Unsupported, sending nothing", async () => {
    const server = target("modern", "unknown-op");

    const failed = decodeRequest(
      await env.MCP_ENGINE.request(
        server,
        {},
        // SAFETY: a newer host's op, which this engine does not know.
        { op: "tasks/get", ctx: AGENT } as never,
        patient(),
      ),
    );

    expect(failed).toMatchObject({ kind: "failed", error: expect.any(Unsupported) });
    expect((await seen(server)).methods).toEqual([]);
  });
});

describe("structuredContent", () => {
  const TYPED = {
    name: "typed",
    inputSchema: { type: "object" },
    outputSchema: {
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    },
  };

  it("is valid when it fits the tool's outputSchema", async () => {
    const called = decodeRequest(
      await env.MCP_ENGINE.request(
        target("legacy", "typed-valid"),
        {},
        { op: "tools/call", tool: TYPED, arguments: { structured: { count: 3 } }, ctx: AGENT },
        patient(),
      ),
    );

    expect(called).toMatchObject({ kind: "complete", structuredOutput: { valid: true } });
  });

  it("is invalid, with its errors, when it does not; the result is kept as it came", async () => {
    const called = decodeRequest(
      await env.MCP_ENGINE.request(
        target("legacy", "typed-invalid"),
        {},
        { op: "tools/call", tool: TYPED, arguments: { structured: { count: "many" } }, ctx: AGENT },
        patient(),
      ),
    );

    expect(called).toMatchObject({
      kind: "complete",
      result: { kind: "inline", value: { structuredContent: { count: "many" } } },
      structuredOutput: { valid: false, errors: [expect.stringContaining("/count")] },
    });
  });

  it("is invalid when the tool declares an outputSchema and returns none", async () => {
    const called = decodeRequest(
      await env.MCP_ENGINE.request(
        target("legacy", "typed-missing"),
        {},
        { op: "tools/call", tool: TYPED, arguments: {}, ctx: AGENT },
        patient(),
      ),
    );

    expect(called).toMatchObject({ structuredOutput: { valid: false } });
  });
});

describe("a header the server rejects (-32020)", () => {
  it("lists the tools again, sends the call once more with the fresh definition, and returns the tools", async () => {
    const server = target("headers", "region");

    const called = decodeRequest(
      await env.MCP_ENGINE.request(
        server,
        {},
        {
          op: "tools/call",
          tool: { name: "region", inputSchema: { type: "object" } },
          arguments: { region: "eu" },
          ctx: AGENT,
        },
        patient(),
      ),
    );

    expect(called).toMatchObject({
      kind: "complete",
      result: { kind: "inline", value: { content: [{ type: "text", text: "eu" }] } },
    });
    expect(called.kind === "complete" && called.tools?.map((tool) => tool.name)).toContain(
      "region",
    );
    expect((await seen(server)).methods.filter((method) => method === "tools/call")).toHaveLength(
      2,
    );
  });
});

describe("access tokens", () => {
  it("asks the host's auth hook and scrubs the token from the result", async () => {
    const token = "secret-token-0123456789";

    const called = decodeRequest(
      await env.MCP_ENGINE.request(
        target("legacy", "token-echo"),
        {},
        { op: "tools/call", tool: ECHO, arguments: { text: `you sent ${token}` }, ctx: AGENT },
        { ...patient(), auth: async () => token },
      ),
    );

    expect(called).toMatchObject({
      result: {
        kind: "inline",
        value: { content: [{ type: "text", text: "you sent [REDACTED]" }] },
      },
    });
  });
});

describe("aborts", () => {
  it("aborts the server request when the caller aborts, and fails as a cut that may have run", async () => {
    const server = target("stateful", "abort");
    let abort: () => void = () => undefined;

    const aborted = new Promise<void>((resolve) => {
      abort = resolve;
    });

    const pending = env.MCP_ENGINE.request(
      server,
      {},
      { op: "tools/call", tool: { name: "hang", inputSchema: { type: "object" } }, ctx: AGENT },
      { untilAborted: () => aborted },
    );

    await expect.poll(async () => (await seen(server)).methods).toContain("tools/call");
    abort();

    expect(decodeRequest(await pending)).toMatchObject({
      kind: "failed",
      error: expect.objectContaining({ constructor: Cut, mayHaveRun: true }),
    });
    await expect.poll(async () => (await seen(server)).cancelled).toEqual(["hang"]);
  });

  it("aborts the server request when the caller dies mid-call", async () => {
    const server = target("stateful", "dead-caller");
    const caller = env.CALLERS.getByName("dead-caller");

    const pending = caller
      .request(
        server,
        {},
        { op: "tools/call", tool: { name: "hang", inputSchema: { type: "object" } }, ctx: AGENT },
      )
      .catch((error) => error);

    await expect.poll(async () => (await seen(server)).methods).toContain("tools/call");
    await caller.die().catch(() => undefined);

    expect(await pending).toBeInstanceOf(Error);
    await expect.poll(async () => (await seen(server)).cancelled).toEqual(["hang"]);
    expect((await seen(server)).notifications).toContain("notifications/cancelled");
  });
});

describe("large results", () => {
  it.each(["modern", "legacy"] as const)(
    "streams a 16 MiB result from a %s server as a native byte stream",
    async (kind) => {
      const bytes = 16 * MiB - 64 * 1024;

      const called = decodeRequest(
        await env.MCP_ENGINE.request(target(kind, `big-${kind}`), {}, bigCall(bytes), patient()),
      );

      expect(called).toMatchObject({ kind: "complete", result: { kind: "stream" } });
      expect(
        called.kind === "complete" && called.result.kind === "stream" && called.result.body,
      ).toBeInstanceOf(ReadableStream);
      expect((await streamedText(called)).length).toBe(bytes);
    },
  );

  it("returns a result of up to 1 MiB inline", async () => {
    const called = decodeRequest(
      await env.MCP_ENGINE.request(target("legacy", "small"), {}, bigCall(MiB - 1024), patient()),
    );

    expect(called).toMatchObject({ kind: "complete", result: { kind: "inline" } });
  });
});

describe("the byte budget", () => {
  it("holds a second large result back until the first is read, while small calls go on", async () => {
    const first = decodeRequest(
      await env.MCP_ENGINE.request(target("legacy", "budget-1"), {}, bigCall(10 * MiB), patient()),
    );

    let secondDone = false;

    const second = env.MCP_ENGINE.request(
      target("legacy", "budget-2"),
      {},
      bigCall(10 * MiB),
      patient(),
    ).then((result) => {
      secondDone = true;

      return decodeRequest(result);
    });

    const small = decodeRequest(
      await env.MCP_ENGINE.request(
        target("legacy", "budget-3"),
        {},
        { op: "tools/call", tool: ECHO, arguments: { text: "small" }, ctx: AGENT },
        patient(),
      ),
    );

    expect(small).toMatchObject({ kind: "complete" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(secondDone).toBe(false);

    expect((await streamedText(first)).length).toBe(10 * MiB);
    expect((await streamedText(await second)).length).toBe(10 * MiB);
  });
});
