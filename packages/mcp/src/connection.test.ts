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
  ECHO_TOOL,
  SHOUT_TOOL,
  type FakeServer,
  fetchTo,
  hostileServer,
  legacyStatefulServer,
  legacyStatelessServer,
  modernServer,
  rpcMethods,
} from "./fakes.fixture.ts";
import { ServerError, Unsupported } from "./types.ts";
import { connect, SUPPORTED_PROTOCOL_VERSIONS } from "./index.ts";
import type { McpCallContext } from "./types.ts";
import { HOST, AGENT, run, testDeps, TARGET, failedWith } from "./core.fixture.ts";

/** `echo`, declared with an outputSchema its answers never meet. */
const COUNTING_TOOL = {
  ...ECHO_TOOL,
  outputSchema: {
    type: "object" as const,
    properties: { count: { type: "number" } },
    required: ["count"],
  },
};

const servers: ReadonlyArray<readonly [string, () => FakeServer, string]> = [
  ["Modern", modernServer, "modern"],
  ["Legacy stateless", legacyStatelessServer, "legacy"],
  ["Legacy stateful with a GET stream", legacyStatefulServer, "legacy"],
];

describe.each(servers)("against a %s server", (_name, makeServer, era) => {
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
    expect(called.value.content).toEqual([{ type: "text", text: "HI" }]);
    expect(rpcMethods(server).filter((method) => method === "tools/list")).toHaveLength(2);
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
    expect(called.value.content).toEqual([{ type: "text", text: "hi" }]);
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

    expect(called.value.structuredContent).toEqual({ count: "many" });
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

  it("offers exactly the five protocol versions", () => {
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual([
      "2026-07-28",
      "2025-11-25",
      "2025-06-18",
      "2025-03-26",
      "2024-11-05",
    ]);
  });

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
