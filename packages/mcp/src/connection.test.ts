/**
 * The core's seam (`docs/architecture/mcp.md` → Packages and objects): `connect(target, deps)` and the connection's
 * `list` and `callTool`, against the fake servers of both eras behind the injected `fetch`
 * (`docs/architecture/mcp.md` → Testing and tracing).
 */
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  APP_MIME_TYPE,
  appTool,
  ECHO_TOOL,
  SHOUT_TOOL,
  type FakeOptions,
  type FakeServer,
  fetchTo,
  hostileServer,
  legacyStatefulServer,
  legacyStatelessServer,
  modernServer,
  PROGRESS_TOOL,
  rpcMethods,
} from "./fakes.fixture.ts";
import { type McpProgress, ServerError, Unsupported } from "./types.ts";
import { connect } from "./index.ts";
import type { McpCallContext } from "./types.ts";
import {
  HOST,
  AGENT,
  OWNER,
  completed,
  run,
  testDeps,
  TARGET,
  failedWith,
} from "./core.fixture.ts";

/** `echo`, declared with an outputSchema its answers never meet. */
const COUNTING_TOOL = {
  ...ECHO_TOOL,
  outputSchema: {
    type: "object" as const,
    properties: { count: { type: "number" } },
    required: ["count"],
  },
};

/** Each fake: its name, how to make it, its era, and whether it answers a call on a stream it can send progress on. */
const servers: ReadonlyArray<
  readonly [string, (options?: FakeOptions) => FakeServer, string, boolean]
> = [
  ["Modern", modernServer, "modern", true],
  ["Legacy stateless", legacyStatelessServer, "legacy", false],
  ["Legacy stateful with a GET stream", legacyStatefulServer, "legacy", true],
];

describe.each(servers)("against a %s server", (_name, makeServer, era, streams) => {
  it("lists every page of tools and calls one", async () => {
    const server = makeServer();

    const { tools, called, connectedEra } = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));
        const tools = yield* connection.list("tools", HOST);

        const called = yield* connection.callTool(
          { tool: SHOUT_TOOL, arguments: { text: "hi" } },
          AGENT,
        );

        return { tools, called, connectedEra: connection.era };
      }),
    );

    expect(connectedEra).toBe(era);
    expect(tools.kind).toBe("complete");
    expect(tools.value.map((tool) => tool.name)).toEqual(["echo", "shout"]);
    expect(completed(called).value.content).toEqual([{ type: "text", text: "HI" }]);
    expect(rpcMethods(server).filter((method) => method === "tools/list")).toHaveLength(2);
  });

  it("reads a resource by its URI, and fails for one the server does not have", async () => {
    const server = makeServer({
      resources: [
        {
          uri: "ui://docs/app",
          name: "app",
          mimeType: APP_MIME_TYPE,
          contents: [{ uri: "ui://docs/app", mimeType: APP_MIME_TYPE, text: "<p>hi</p>" }],
        },
      ],
      moreTools: [appTool("app", "ui://docs/app")],
    });

    const { read, missing, tools } = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));
        const tools = yield* connection.list("tools", HOST);
        const read = yield* connection.readResource("ui://docs/app", HOST);
        const missing = yield* Effect.flip(connection.readResource("ui://docs/none", HOST));

        return { read, missing, tools };
      }),
    );

    expect(tools.value.find((tool) => tool.name === "app")?._meta).toEqual({
      ui: { resourceUri: "ui://docs/app" },
    });
    expect(read.kind).toBe("complete");
    expect(read.kind === "complete" && read.value.contents).toEqual([
      { uri: "ui://docs/app", mimeType: APP_MIME_TYPE, text: "<p>hi</p>" },
    ]);
    expect(missing._tag).toBe("ServerError");
    expect(rpcMethods(server).filter((method) => method === "resources/read")).toHaveLength(2);
  });

  it("gets a prompt with its arguments, and fails for one the server does not have", async () => {
    const server = makeServer({
      prompts: [
        {
          name: "review_pr",
          arguments: [{ name: "pr_number", required: true }],
          get: (args) => ({
            description: "Review a PR",
            messages: [
              { role: "user", content: { type: "text", text: `Review PR ${args["pr_number"]}` } },
            ],
          }),
        },
      ],
    });

    const { got, listed, missing } = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));
        const listed = yield* connection.list("prompts", HOST);
        const got = yield* connection.getPrompt("review_pr", { pr_number: "123" }, OWNER);
        const missing = yield* Effect.flip(connection.getPrompt("none", {}, OWNER));

        return { got, listed, missing };
      }),
    );

    expect(listed.value.map((prompt) => prompt.name)).toEqual(["review_pr"]);
    expect(got.kind).toBe("complete");
    expect(got.value.messages).toEqual([
      { role: "user", content: { type: "text", text: "Review PR 123" } },
    ]);
    expect(missing._tag).toBe("ServerError");
    expect(rpcMethods(server).filter((method) => method === "prompts/get")).toHaveLength(2);
  });

  it("passes a call's progress to onProgress, and asks for none without it", async () => {
    const server = makeServer({ moreTools: [PROGRESS_TOOL] });
    const seen: Array<McpProgress> = [];

    const called = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, {
          ...testDeps(fetchTo(server)),
          onProgress: (progress) => seen.push(progress),
        });

        const withProgress = yield* connection.callTool(
          { tool: PROGRESS_TOOL, arguments: { steps: 2 } },
          AGENT,
        );

        const quiet = yield* connect(TARGET, testDeps(fetchTo(server)));

        yield* quiet.callTool({ tool: PROGRESS_TOOL, arguments: { steps: 2 } }, AGENT);

        return withProgress;
      }),
    );

    expect(completed(called).value.content).toEqual([{ type: "text", text: "done" }]);
    // A server that answers with plain JSON has no stream to send progress on.
    expect(seen).toEqual(
      streams
        ? [
            { progress: 1, total: 2, message: "step 1" },
            { progress: 2, total: 2, message: "step 2" },
          ]
        : [],
    );
    // The call without `onProgress` asked for none: its request carried no progress token.
    const calls = server.received.filter((received) => received.rpc?.method === "tools/call");

    expect(calls.map((received) => JSON.stringify(received.rpc).includes("progressToken"))).toEqual(
      [true, false],
    );
  });

  it("leaves structuredContent to the host: a tool with an outputSchema may answer without it", async () => {
    const server = makeServer();

    const called = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

        return yield* connection.callTool(
          { tool: COUNTING_TOOL, arguments: { text: "hi" } },
          AGENT,
        );
      }),
    );

    expect(called.kind).toBe("complete");
    expect(completed(called).value.content).toEqual([{ type: "text", text: "hi" }]);
  });
});

describe("a Legacy session's GET stream", () => {
  it("is opened, and carries the server's notifications to the client", async () => {
    const server = legacyStatefulServer();
    const announced = () => server.streamed.join("").includes("notifications/tools/list_changed");

    await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

        // Each call sends a notification on the GET stream; the stream may open after the first.
        for (let calls = 0; calls < 20 && !announced(); calls++) {
          yield* connection.callTool({ tool: ECHO_TOOL, arguments: { text: "hi" } }, AGENT);
          yield* Effect.sleep(Duration.millis(10));
        }
      }),
    );

    expect(
      server.received.some(
        (received) =>
          received.method === "GET" && received.headers.get("mcp-session-id") === "session-1",
      ),
    ).toBe(true);
    expect(announced()).toBe(true);
  });
});

describe("a header the server rejects (-32020)", () => {
  it("fails the call as a ServerError, sent once: the refresh and retry are the catalog owner's", async () => {
    const server = hostileServer(modernServer(), (_request, rpc) =>
      rpc?.method === "tools/call"
        ? Response.json(
            {
              jsonrpc: "2.0",
              id: rpc.id ?? null,
              error: { code: -32020, message: "Header mismatch" },
            },
            { status: 400 },
          )
        : undefined,
    );

    const ended = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

        return yield* connection.callTool({ tool: ECHO_TOOL, arguments: { text: "hi" } }, AGENT);
      }).pipe(Effect.catch((error) => Effect.succeed({ failed: error }))),
    );

    expect(ended).toEqual(failedWith(ServerError, { code: -32020 }));
    expect(rpcMethods(server).filter((method) => method === "tools/call")).toHaveLength(1);
  });
});

describe("structuredContent", () => {
  it("passes through unchecked when it does not match the tool's outputSchema", async () => {
    const server = hostileServer(legacyStatelessServer(), (_request, rpc) =>
      rpc?.method === "tools/call"
        ? Response.json({
            jsonrpc: "2.0",
            id: rpc.id ?? null,
            result: { content: [], structuredContent: { count: "many" } },
          })
        : undefined,
    );

    const called = await run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, testDeps(fetchTo(server)));

        return yield* connection.callTool({ tool: COUNTING_TOOL, arguments: {} }, AGENT);
      }),
    );

    expect(completed(called).value.structuredContent).toEqual({ count: "many" });
  });
});

describe("what the client declares", () => {
  const MCP_APPS = { mimeTypes: ["text/html;profile=mcp-app"] };
  const EXTENSIONS = { "io.modelcontextprotocol/ui": MCP_APPS, "example.test/extension": {} };

  const declaringDeps = (server: FakeServer, asked: Array<McpCallContext | undefined>) =>
    testDeps(fetchTo(server), {
      capabilities: (ctx) => {
        asked.push(ctx);

        return ctx?.origin === "agent" ? { elicitation: { form: {} } } : {};
      },
      extensions: { "example.test/extension": {} },
      clientInfo: { name: "cloudpid", version: "deploy-1" },
    });

  const listAndCall = (server: FakeServer, asked: Array<McpCallContext | undefined>) =>
    run(
      Effect.gen(function* () {
        const connection = yield* connect(TARGET, declaringDeps(server, asked));

        yield* connection.list("tools", HOST);
        yield* connection.callTool({ tool: ECHO_TOOL, arguments: { text: "hi" } }, AGENT);
      }),
    );

  const rpc = (server: FakeServer, method: string) =>
    server.received.flatMap((received) =>
      received.rpc?.method === method && received.rpc.params !== undefined
        ? [received.rpc.params]
        : [],
    );

  it("declares MCP Apps and the injected extensions at a Legacy initialize, with clientInfo", async () => {
    const server = legacyStatelessServer();
    const asked: Array<McpCallContext | undefined> = [];

    await listAndCall(server, asked);

    expect(rpc(server, "initialize")).toEqual([
      {
        protocolVersion: "2025-11-25",
        capabilities: { extensions: EXTENSIONS },
        clientInfo: { name: "cloudpid", version: "deploy-1" },
      },
    ]);
  });

  it("declares MCP Apps on every Modern request, with what capabilities(ctx) gives for its context", async () => {
    const server = modernServer();
    const asked: Array<McpCallContext | undefined> = [];

    await listAndCall(server, asked);

    const declared = (method: string) => rpc(server, method).map((params) => params["_meta"]);

    expect(declared("server/discover")).toEqual([
      expect.objectContaining({
        "io.modelcontextprotocol/clientCapabilities": { extensions: EXTENSIONS },
        "io.modelcontextprotocol/clientInfo": { name: "cloudpid", version: "deploy-1" },
      }),
    ]);
    expect(declared("tools/list")).toEqual([
      expect.objectContaining({
        "io.modelcontextprotocol/clientCapabilities": { extensions: EXTENSIONS },
      }),
      expect.objectContaining({
        "io.modelcontextprotocol/clientCapabilities": { extensions: EXTENSIONS },
      }),
    ]);
    expect(declared("tools/call")).toEqual([
      expect.objectContaining({
        "io.modelcontextprotocol/clientCapabilities": {
          elicitation: { form: {} },
          extensions: EXTENSIONS,
        },
      }),
    ]);
    expect(asked).toContainEqual(AGENT);
  });

  it.each([
    ["accepts", "2024-11-05", { connected: "2024-11-05" }],
    ["refuses", "2024-10-07", failedWith(Unsupported)],
  ])("%s a Legacy server answering %s", async (_verb, version, expected) => {
    const server = hostileServer(legacyStatelessServer(), (_request, rpc) =>
      rpc?.method === "initialize"
        ? Response.json({
            jsonrpc: "2.0",
            id: rpc.id ?? null,
            result: {
              protocolVersion: version,
              capabilities: { tools: {} },
              serverInfo: { name: "old", version: "1" },
            },
          })
        : undefined,
    );

    const ended = await run(
      connect(TARGET, testDeps(fetchTo(server))).pipe(
        Effect.map((connection) => ({ connected: connection.protocolVersion })),
        Effect.catch((error) => Effect.succeed({ failed: error })),
      ),
    );

    expect(ended).toEqual(expected);
  });
});
