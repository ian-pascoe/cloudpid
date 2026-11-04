// workerd's RPC and `cloudflare:test` APIs are Promise-based, so this file is too.
// Plain assertions over RPC results: Promise-based, decoding synchronously.
// @effect-diagnostics asyncFunction:off globalFetch:off schemaSync:off newPromise:off globalTimers:off preferEffectArray:off
import { env } from "cloudflare:workers";
import type { McpEngineMethods } from "@cloudpid/mcp/types";
import {
  Cut,
  McpEngineDiscoverResult,
  McpEngineListenResult,
  type McpListenEvent,
  McpEngineRequestResult,
  SignInRequired,
  StepUpRequired,
  TimedOut,
  Unsupported,
} from "@cloudpid/mcp/types";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { MiB } from "./units.ts";
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
const target = (
  kind:
    | "modern"
    | "legacy"
    | "stateful"
    | "headers"
    | "logging"
    | "apps"
    | "resources"
    | "subscribable"
    | "subscribable-legacy"
    | "prompts"
    | "unauthorized"
    | "forbidden",
  key: string,
) => ({
  kind: "http" as const,
  conn: `conn-${key}`,
  name: key,
  url: `https://${kind}.test/${key}/mcp`,
});

const AGENT = { origin: "agent" as const, conversation: "conversation-1" };

const ECHO = { name: "echo", inputSchema: { type: "object" } };

/** The problem the headers fake's `uncompilable` tool has (`fakes.fixture.ts`). */
const UNCOMPILABLE_PROBLEM = {
  tool: "uncompilable",
  problem: expect.stringContaining("invalid outputSchema"),
};

/** What the fake behind `server` received and which of its calls were cancelled. */
const seen = async (server: ReturnType<typeof target>) => {
  const response = await env.FAKES.fetch(server.url.replace(/\/mcp$/, "/_seen"));

  // SAFETY: the fakes Worker answers `_seen` with this shape (`fakes.fixture.ts`).
  return (await response.json()) as {
    methods: Array<string>;
    notifications: Array<string>;
    cancelled: Array<string>;
    subscribed: Array<string>;
    unsubscribed: Array<string>;
  };
};

const decodeRequest = Schema.decodeSync(McpEngineRequestResult);

const decodeListen = Schema.decodeSync(McpEngineListenResult);

const WATCHED = "file:///watched.md";

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

  it("discovers with no `untilAborted`, as the host's background discovery calls it", async () => {
    const discovered = Schema.decodeSync(McpEngineDiscoverResult)(
      await env.MCP_ENGINE.discover(target("modern", "discover-no-hooks"), {}, {}),
    );

    expect(discovered).toMatchObject({ kind: "discovered", era: "modern" });
  });
});

describe("a resources/read request", () => {
  it("reads a resource and returns the server's result, scrubbed of the token it was sent", async () => {
    const server = { ...target("apps", "read-app"), redact: ["sk-echoed-secret-0123456789"] };

    const result = decodeRequest(
      await env.MCP_ENGINE.request(
        server,
        {},
        { op: "resources/read", uri: "ui://docs/app", ctx: AGENT },
        patient(),
      ),
    );

    expect(result).toMatchObject({
      kind: "complete",
      result: {
        kind: "inline",
        value: {
          contents: [
            {
              uri: "ui://docs/app",
              mimeType: "text/html;profile=mcp-app",
              text: "<p>[REDACTED]</p>",
              _meta: { ui: { prefersBorder: true } },
            },
          ],
        },
      },
    });
    expect((await seen(server)).methods).toContain("resources/read");
  });

  it("fails as the server's error for a resource it does not have", async () => {
    const result = decodeRequest(
      await env.MCP_ENGINE.request(
        target("apps", "read-missing"),
        {},
        { op: "resources/read", uri: "ui://docs/none", ctx: AGENT },
        patient(),
      ),
    );

    expect(result.kind === "failed" && Predicate.isTagged(result.error, "ServerError")).toBe(true);
  });
});

describe("a resource list page request", () => {
  const redact = ["sk-echoed-secret-0123456789"];

  it("answers one page with the server's own result shape, its cursor and its cache hints, scrubbed", async () => {
    const server = { ...target("resources", "page-resources"), redact };

    const first = decodeRequest(
      await env.MCP_ENGINE.request(
        server,
        {},
        { op: "resources/list_page", ctx: AGENT },
        patient(),
      ),
    );

    expect(first).toMatchObject({
      kind: "complete",
      ttlMs: 60_000,
      result: {
        kind: "inline",
        value: { resources: [{ uri: "file:///notes.md" }], nextCursor: "1" },
      },
    });

    const second = decodeRequest(
      await env.MCP_ENGINE.request(
        server,
        {},
        { op: "resources/list_page", cursor: "1", ctx: AGENT },
        patient(),
      ),
    );

    expect(second).toMatchObject({
      kind: "complete",
      result: {
        kind: "inline",
        value: { resources: [{ uri: "file:///logo.png", description: "for [REDACTED]" }] },
      },
    });
    expect(JSON.stringify(second)).not.toContain("nextCursor");
    expect((await seen(server)).methods.filter((m) => m === "resources/list")).toHaveLength(2);
  });

  it("answers a page of resource templates", async () => {
    const result = decodeRequest(
      await env.MCP_ENGINE.request(
        target("resources", "page-templates"),
        {},
        { op: "resources/templates/list_page", ctx: AGENT },
        patient(),
      ),
    );

    expect(result).toMatchObject({
      kind: "complete",
      result: {
        kind: "inline",
        value: { resourceTemplates: [{ uriTemplate: "file:///{path}", name: "files" }] },
      },
    });
  });

  it("answers a read with the SHA-256 of its contents", async () => {
    const server = { ...target("resources", "read-sha"), redact };

    const read = async () =>
      decodeRequest(
        await env.MCP_ENGINE.request(
          server,
          {},
          { op: "resources/read", uri: "file:///notes.md", ctx: AGENT },
          patient(),
        ),
      );

    const first = await read();
    const again = await read();

    expect(first).toMatchObject({
      kind: "complete",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      result: { value: { contents: [{ text: "key [REDACTED]" }] } },
    });
    expect(again.kind === "complete" && again.sha256).toBe(
      first.kind === "complete" && first.sha256,
    );
  });
});

describe("a prompts/get request", () => {
  it("gets a prompt with its arguments and returns the server's result, scrubbed of the token it was sent", async () => {
    const server = { ...target("prompts", "get-prompt"), redact: ["sk-echoed-secret-0123456789"] };

    const result = decodeRequest(
      await env.MCP_ENGINE.request(
        server,
        {},
        { op: "prompts/get", name: "review", arguments: { pr: "123" }, ctx: AGENT },
        patient(),
      ),
    );

    expect(result).toMatchObject({
      kind: "complete",
      result: {
        kind: "inline",
        value: {
          description: "Review a PR",
          messages: [{ role: "user", content: { type: "text", text: "Review 123 [REDACTED]" } }],
        },
      },
    });
    expect((await seen(server)).methods).toContain("prompts/get");
  });

  it("fails as the server's error for a prompt it does not have", async () => {
    const result = decodeRequest(
      await env.MCP_ENGINE.request(
        target("prompts", "get-missing"),
        {},
        { op: "prompts/get", name: "none", arguments: {}, ctx: AGENT },
        patient(),
      ),
    );

    expect(result.kind === "failed" && Predicate.isTagged(result.error, "ServerError")).toBe(true);
  });
});

describe("server logs", () => {
  const logging = (key: string) => ({
    ...target("logging", key),
    headers: { authorization: "Bearer sk-echoed-secret-0123456789" },
    redact: ["sk-echoed-secret-0123456789"],
  });

  it("come back in a discovery that passed no hooks: warning and above, cut to 2 KiB, scrubbed", async () => {
    const discovered = Schema.decodeSync(McpEngineDiscoverResult)(
      await env.MCP_ENGINE.discover(logging("logs-discover"), {}, {}),
    );

    if (discovered.kind !== "discovered") throw new Error(JSON.stringify(discovered));

    expect(discovered.logs?.map((log) => [log.level, log.logger])).toEqual([
      ["warning", "auth"],
      ["error", undefined],
    ]);
    expect(discovered.logs?.[0]?.data).toBe("rejected Bearer [REDACTED]");
    expect(discovered.logs?.[1]?.data).toHaveLength(2048);
    expect(JSON.stringify(discovered)).not.toContain("sk-echoed-secret");
  });

  it("come back with a call's result", async () => {
    const result = decodeRequest(
      await env.MCP_ENGINE.request(
        logging("logs-call"),
        {},
        { op: "tools/call", tool: ECHO, arguments: { text: "hi" }, ctx: AGENT },
        patient(),
      ),
    );

    expect(result.kind).toBe("complete");
    expect(result.logs?.map((log) => log.level)).toEqual(["warning", "error"]);
    expect(JSON.stringify(result)).not.toContain("sk-echoed-secret");
  });

  it("are absent when the server declares no logging", async () => {
    const discovered = Schema.decodeSync(McpEngineDiscoverResult)(
      await env.MCP_ENGINE.discover(target("modern", "logs-none"), {}, {}),
    );

    expect(discovered).not.toHaveProperty("logs");
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
        { op: "tasks/list", ctx: AGENT } as never,
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
    expect(called).toMatchObject({ problems: [UNCOMPILABLE_PROBLEM] });
    expect((await seen(server)).methods.filter((method) => method === "tools/call")).toHaveLength(
      2,
    );
  });

  it("returns the fresh tools and their problems when the second send fails too", async () => {
    const server = target("headers", "stubborn");

    const called = decodeRequest(
      await env.MCP_ENGINE.request(
        server,
        {},
        {
          op: "tools/call",
          tool: { name: "stubborn", inputSchema: { type: "object" } },
          ctx: AGENT,
        },
        patient(),
      ),
    );

    expect(called).toMatchObject({
      kind: "failed",
      error: { code: -32020 },
      problems: [UNCOMPILABLE_PROBLEM],
    });
    expect("tools" in called ? called.tools?.map((tool) => tool.name) : []).toContain("stubborn");
    expect((await seen(server)).methods.filter((method) => method === "tools/call")).toHaveLength(
      2,
    );
  });
});

describe("tools/list", () => {
  it("returns the listed tools with their schema problems, compiled as discovery compiles them", async () => {
    const listed = decodeRequest(
      await env.MCP_ENGINE.request(
        target("headers", "list-problems"),
        {},
        { op: "tools/list", ctx: AGENT },
        patient(),
      ),
    );

    expect(listed).toMatchObject({ kind: "complete", problems: [UNCOMPILABLE_PROBLEM] });
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

  it("scrubs the token from a server's error", async () => {
    const token = "secret-token-0123456789";

    const called = decodeRequest(
      await env.MCP_ENGINE.request(
        target("headers", "token-error"),
        {},
        {
          op: "tools/call",
          tool: { name: "complain", inputSchema: { type: "object" } },
          arguments: { text: `you sent ${token}` },
          ctx: AGENT,
        },
        { ...patient(), auth: async () => token },
      ),
    );

    expect(called).toMatchObject({
      kind: "failed",
      error: { message: expect.stringContaining("you sent [REDACTED]") },
    });
    expect(JSON.stringify(called)).not.toContain(token);
  });
});

describe("an OAuth wall", () => {
  const discover = async (server: ReturnType<typeof target>) =>
    Schema.decodeSync(McpEngineDiscoverResult)(
      await env.MCP_ENGINE.discover(server, {}, patient()),
    );

  it("fails a 401 as a sign-in with the parameters of its WWW-Authenticate challenge", async () => {
    expect(await discover(target("unauthorized", "wall"))).toMatchObject({
      kind: "failed",
      error: expect.objectContaining({
        constructor: SignInRequired,
        rejected: false,
        challenge: {
          resourceMetadataUrl: "https://unauthorized.test/.well-known/oauth-protected-resource",
          error: "invalid_token",
          errorDescription: "expired",
        },
      }),
    });
  });

  it("fails a 403 for more scope as a step-up with the scope and the challenge", async () => {
    expect(await discover(target("forbidden", "wall"))).toMatchObject({
      kind: "failed",
      error: expect.objectContaining({
        constructor: StepUpRequired,
        scope: "write",
        challenge: {
          resourceMetadataUrl: "https://forbidden.test/.well-known/oauth-protected-resource",
          scope: "write",
          error: "insufficient_scope",
          errorDescription: "Needs write",
        },
      }),
    });
  });
});

describe("aborts", () => {
  /** Hooks of a caller that has already aborted. */
  const aborted = () => ({ untilAborted: () => Promise.resolve() });

  it("fails an aborted discovery as a cut that ran nothing", async () => {
    const discovered = Schema.decodeSync(McpEngineDiscoverResult)(
      await env.MCP_ENGINE.discover(target("legacy", "abort-discover"), {}, aborted()),
    );

    expect(discovered).toMatchObject({
      kind: "failed",
      error: expect.objectContaining({ constructor: Cut, mayHaveRun: false }),
    });
  });

  it("fails an aborted list as a cut that ran nothing", async () => {
    const listed = decodeRequest(
      await env.MCP_ENGINE.request(
        target("legacy", "abort-list"),
        {},
        { op: "tools/list", ctx: AGENT },
        aborted(),
      ),
    );

    expect(listed).toMatchObject({
      kind: "failed",
      error: expect.objectContaining({ constructor: Cut, mayHaveRun: false }),
    });
  });

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

  it("lets concurrent calls that oversubscribe the pool all complete", async () => {
    const texts = await Promise.all(
      ["a", "b", "c", "d"].map(async (key) =>
        streamedText(
          decodeRequest(
            await env.MCP_ENGINE.request(
              target("legacy", `oversubscribe-${key}`),
              {},
              bigCall(3 * MiB),
              patient(),
            ),
          ),
        ),
      ),
    );

    expect(texts.map((text) => text.length)).toEqual([3 * MiB, 3 * MiB, 3 * MiB, 3 * MiB]);
  });

  it.each([
    ["aborted", "budget-abort"],
    ["timed out", "budget-timeout"],
  ] as const)(
    "frees a call %s while it waits for the budget at once, and the next call goes on",
    async (how, key) => {
      const holder = decodeRequest(
        await env.MCP_ENGINE.request(
          target("legacy", `${key}-1`),
          {},
          bigCall(10 * MiB),
          patient(),
        ),
      );

      let abort: () => void = () => undefined;

      const aborted = new Promise<void>((resolve) => {
        abort = resolve;
      });

      const waiting = env.MCP_ENGINE.request(
        { ...target("legacy", `${key}-2`), timeoutMs: how === "timed out" ? 300 : 60_000 },
        {},
        bigCall(10 * MiB),
        { untilAborted: () => aborted },
      );

      if (how === "aborted") {
        await new Promise((resolve) => setTimeout(resolve, 300));
        abort();
      }

      expect(decodeRequest(await waiting)).toMatchObject({
        kind: "failed",
        error: expect.any(how === "aborted" ? Cut : TimedOut),
      });

      expect((await streamedText(holder)).length).toBe(10 * MiB);

      const next = decodeRequest(
        await env.MCP_ENGINE.request(
          target("legacy", `${key}-3`),
          {},
          bigCall(10 * MiB),
          patient(),
        ),
      );

      expect((await streamedText(next)).length).toBe(10 * MiB);
    },
  );
});

/** The events a listen's stream has written so far, as lines; `wait` reads until `count` of them have come. */
const eventReader = (events: ReadableStream<Uint8Array>) => {
  const reader = events.getReader();
  const decoder = new TextDecoder();
  const heard: Array<McpListenEvent> = [];
  let tail = "";

  const wait = async (count: number) => {
    while (heard.length < count) {
      const chunk = await reader.read();

      if (chunk.done) break;

      const lines = (tail + decoder.decode(chunk.value, { stream: true })).split("\n");

      tail = lines.pop() ?? "";

      for (const line of lines) {
        // SAFETY: the engine writes `McpListenEvent`s as JSON lines.
        heard.push(JSON.parse(line) as McpListenEvent);
      }
    }

    return heard;
  };

  return { wait, cancel: () => reader.cancel() };
};

/** The listening answer of `result`, which a test expects. */
const listening = (result: ReturnType<typeof decodeListen>) => {
  if (result.kind !== "listening") throw new Error(`not listening: ${JSON.stringify(result)}`);

  return result;
};

describe("listen", () => {
  it("opens a Modern listen, writes the events the server publishes as lines, and closes it when the stream is cancelled", async () => {
    const server = target("subscribable", "listen-modern");

    const result = listening(
      decodeListen(
        await env.MCP_ENGINE.listen(
          server,
          {},
          { resourceSubscriptions: [WATCHED], resourcesListChanged: true },
          {},
        ),
      ),
    );

    expect(result.era).toBe("modern");
    expect(result.honored.resourceSubscriptions).toEqual([WATCHED]);

    const events = eventReader(result.events);

    await env.FAKES.fetch(server.url.replace(/\/mcp$/, `/_notify?uri=${WATCHED}`));

    expect(await events.wait(1)).toEqual([{ kind: "resource_updated", uri: WATCHED }]);

    await events.cancel();
    await env.FAKES.fetch(server.url.replace(/\/mcp$/, `/_notify?uri=${WATCHED}`));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect((await seen(server)).notifications).toContain("notifications/cancelled");
  });

  it("subscribes each URI of a Legacy server and hears its GET stream, keeping the session row for the host", async () => {
    const server = target("subscribable-legacy", "listen-legacy");

    const result = listening(
      decodeListen(
        await env.MCP_ENGINE.listen(server, {}, { resourceSubscriptions: [WATCHED] }, {}),
      ),
    );

    expect(result.era).toBe("legacy");
    expect(result.honored.resourceSubscriptions).toEqual([WATCHED]);
    expect(result.state.session).toBeDefined();

    const events = eventReader(result.events);

    await env.FAKES.fetch(server.url.replace(/\/mcp$/, `/_notify?uri=${WATCHED}`));

    expect(await events.wait(1)).toContainEqual({ kind: "resource_updated", uri: WATCHED });

    // The engine sees the events cancelled when it next writes one.
    await events.cancel();
    await env.FAKES.fetch(server.url.replace(/\/mcp$/, `/_notify?uri=${WATCHED}`));
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect((await seen(server)).unsubscribed).toEqual([WATCHED]);
  });

  it.each(["subscribable", "subscribable-legacy"] as const)(
    "ends a %s listen at once when the caller closes its stop stream, and ends the events",
    async (kind) => {
      const server = target(kind, `listen-stop-${kind}`);
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();

      const result = listening(
        decodeListen(
          await env.MCP_ENGINE.listen(
            server,
            {},
            { resourceSubscriptions: [WATCHED] },
            {},
            readable,
          ),
        ),
      );

      const events = eventReader(result.events);

      await writable.getWriter().close();

      // The events end with the listen, and a Legacy server is unsubscribed.
      expect(await events.wait(1)).toEqual([]);

      if (kind === "subscribable-legacy") {
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect((await seen(server)).unsubscribed).toEqual([WATCHED]);
      }
    },
  );

  it("ends the stream with a closed line when the server cuts a Legacy listen", async () => {
    const server = target("subscribable-legacy", "listen-cut");

    const result = listening(
      decodeListen(
        await env.MCP_ENGINE.listen(server, {}, { resourceSubscriptions: [WATCHED] }, {}),
      ),
    );

    const events = eventReader(result.events);

    await env.FAKES.fetch(server.url.replace(/\/mcp$/, "/_cut"));

    expect((await events.wait(1)).at(-1)).toEqual({ kind: "closed", cause: "remote" });
  });

  it("fails a listen of a server that cannot send updates as unsupported, holding nothing", async () => {
    const result = decodeListen(
      await env.MCP_ENGINE.listen(
        target("legacy", "listen-405"),
        {},
        { resourceSubscriptions: [WATCHED] },
        {},
      ),
    );

    expect(result).toMatchObject({
      kind: "failed",
      error: expect.objectContaining({
        constructor: Unsupported,
        message: "The server cannot send updates",
      }),
    });
  });

  it("fails a listen of a server behind an OAuth wall as a sign-in", async () => {
    const result = decodeListen(
      await env.MCP_ENGINE.listen(target("unauthorized", "listen-wall"), {}, {}, {}),
    );

    expect(result).toMatchObject({ kind: "failed", error: expect.any(SignInRequired) });
  });

  it("fails a filter it cannot read as unsupported", async () => {
    // SAFETY: a filter from a newer host, whose shape this engine does not know.
    const result = decodeListen(
      await env.MCP_ENGINE.listen(
        target("subscribable", "listen-odd"),
        {},
        { resourceSubscriptions: 3 } as never,
        {},
      ),
    );

    expect(result).toMatchObject({
      kind: "failed",
      error: expect.objectContaining({ constructor: Unsupported }),
    });
  });
});
