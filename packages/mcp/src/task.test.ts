/**
 * The core's task wire (`docs/architecture/mcp-server-requests.md` → MCP tasks, The wire), against a fake Modern task
 * server: a `tools/call` answered with an MCP task only for a caller that can wait for one, `tasks/get`, `tasks/update`
 * and `tasks/cancel` with their headers, the 16 MiB result limit, and the `-32021` message.
 */
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  fetchTo,
  hostileServer,
  legacyStatelessServer,
  modernServer,
  modernTaskServer,
  REPORT_TOOL,
  rpcMethods,
  sse,
  type FakeServer,
  type RpcBody,
  TASKS_EXTENSION,
} from "./fakes.fixture.ts";
import { connect, type McpConnection } from "./index.ts";
import {
  AGENT,
  completed,
  failedWith,
  HOST,
  run,
  settled,
  started,
  testDeps,
  TARGET,
} from "./core.fixture.ts";
import {
  Cut,
  MCP_LARGE_RESULT_BYTES,
  type McpCallContext,
  type McpError,
  NotFound,
  ProtocolViolation,
  ServerError,
  TooLarge,
  Unsupported,
} from "./types.ts";

const TASKING: McpCallContext = { ...AGENT, allowTask: true };

type Args = Record<string, string | number | boolean>;

/** Connects to `server` and runs `use`. */
const withConnection = <A>(
  server: FakeServer,
  use: (connection: McpConnection) => Effect.Effect<A, McpError>,
  target = TARGET,
) =>
  run(
    Effect.gen(function* () {
      const connection = yield* connect(target, testDeps(fetchTo(server)));

      return yield* use(connection);
    }),
  );

const report = (connection: McpConnection, args: Args, ctx = TASKING) =>
  connection.callTool({ tool: REPORT_TOOL, arguments: args }, ctx);

/** A `report` task made with `args`, its id. */
const taskOf = (connection: McpConnection, args: Args) =>
  report(connection, args).pipe(Effect.map((outcome) => started(outcome).task.taskId));

describe("a tools/call that may start an MCP task", () => {
  it("answers with the task the server started, declaring the extension only on that request", async () => {
    const server = modernTaskServer();

    const outcome = await withConnection(server, (connection) =>
      report(connection, { region: "eu" }),
    );

    expect(started(outcome).task).toMatchObject({
      taskId: "task-1",
      status: "working",
      ttlMs: 60_000,
    });
    expect(server.tasks.get("task-1")?.status).toBe("working");
    expect(server.declared).toEqual([{ method: "tools/call", tasks: true }]);
  });

  it("sends the call as a Modern request with its standard headers and the tool's Mcp-Param header", async () => {
    const server = modernTaskServer();

    await withConnection(server, (connection) => report(connection, { region: "eu-west" }));

    const call = server.received.find((received) => received.rpc?.method === "tools/call");

    expect(call?.headers.get("mcp-method")).toBe("tools/call");
    expect(call?.headers.get("mcp-name")).toBe("report");
    expect(call?.headers.get("mcp-protocol-version")).toBe("2026-07-28");
    expect(call?.headers.get("mcp-param-region")).toBe("eu-west");
    expect(call?.rpc?.params?.["_meta"]).toMatchObject({
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "cloudpid" },
    });
  });

  it("base64-wraps a header value that is not plain ASCII", async () => {
    const server = modernTaskServer();

    const outcome = await withConnection(server, (connection) =>
      report(connection, { region: "é" }),
    );

    // The fake decodes the wrapper and compares the value with the argument, so a task means the header matched.
    expect(outcome.kind).toBe("task");
    expect(
      server.received
        .find((received) => received.rpc?.method === "tools/call")
        ?.headers.get("mcp-param-region"),
    ).toBe("=?base64?w6k=?=");
  });

  it("never offers a task to a call without allowTask: the extension is not declared and the result is the tool's", async () => {
    const server = modernTaskServer();

    const outcome = await withConnection(server, (connection) =>
      report(connection, { region: "eu" }, AGENT),
    );

    expect(completed(outcome).value.content).toEqual([{ type: "text", text: "report:eu" }]);
    expect(server.tasks.size).toBe(0);
    expect(server.declared).toEqual([{ method: "tools/call", tasks: false }]);
  });

  it("never offers a task for a host's own call, an unadvertised extension or a Legacy server", async () => {
    const hosted = modernTaskServer();
    const unadvertised = modernTaskServer({ unadvertised: true });
    const legacy = legacyStatelessServer({ moreTools: [REPORT_TOOL] });

    const outcomes = await Promise.all([
      withConnection(hosted, (connection) => report(connection, { region: "a" }, HOST)),
      withConnection(unadvertised, (connection) => report(connection, { region: "a" })),
      withConnection(legacy, (connection) =>
        connection.callTool({ tool: REPORT_TOOL, arguments: { text: "legacy" } }, TASKING),
      ),
    ]);

    expect(outcomes.map((outcome) => outcome.kind)).toEqual(["complete", "complete", "complete"]);
    expect(hosted.tasks.size + unadvertised.tasks.size).toBe(0);
    expect(hosted.declared).toEqual([{ method: "tools/call", tasks: false }]);
    expect(unadvertised.declared).toEqual([{ method: "tools/call", tasks: false }]);
    expect(JSON.stringify(legacy.received.map((received) => received.rpc))).not.toContain(
      TASKS_EXTENSION,
    );
  });

  it("returns the result as a synchronous call does when the server completes it at once", async () => {
    const outcome = await withConnection(modernTaskServer(), (connection) =>
      report(connection, { region: "eu", inline: true }),
    );

    expect(completed(outcome).value.content).toEqual([{ type: "text", text: "report:eu" }]);
  });

  it("turns a -32021 that names the extension into the message of a call that could not be offered it", async () => {
    const result = await withConnection(
      modernTaskServer({ requireTask: true }),
      (connection) => settled(report(connection, { region: "eu" }, AGENT)),
      { ...TARGET, name: "reports" },
    );

    expect(result).toEqual(
      failedWith(ServerError, {
        code: -32021,
        message:
          "reports needs to run this as an MCP task, which cloudpid couldn't offer here: This tool runs only as an MCP task",
      }),
    );
  });

  it("leaves another -32021 as the server's own error", async () => {
    const server = hostileServer(modernServer(), (_request, rpc) =>
      rpc?.method === "tools/call"
        ? Response.json(
            {
              jsonrpc: "2.0",
              id: rpc.id,
              error: {
                code: -32021,
                message: "needs roots",
                data: { requiredCapabilities: { roots: {} } },
              },
            },
            { status: 400 },
          )
        : undefined,
    );

    const result = await withConnection(server, (connection) => settled(report(connection, {})));

    expect(result).toEqual(failedWith(ServerError, { code: -32021, message: "needs roots" }));
  });
});

describe("tasks/get, tasks/update and tasks/cancel", () => {
  it("polls a task to its result with the headers the spec asks for", async () => {
    const server = modernTaskServer({ pollIntervalMs: 2000 });

    const states = await withConnection(server, (connection) =>
      Effect.gen(function* () {
        const id = yield* taskOf(connection, { region: "eu", polls: 2 });

        return [yield* connection.task.get(id, TASKING), yield* connection.task.get(id, TASKING)];
      }),
    );

    expect(states[0]?.task).toMatchObject({ status: "working", pollIntervalMs: 2000 });
    expect(states[0]?.result).toBeUndefined();
    expect(states[1]?.task.status).toBe("completed");
    expect(states[1]?.result?.content).toEqual([{ type: "text", text: "report:eu" }]);

    const get = server.received.find((received) => received.rpc?.method === "tasks/get");

    expect(get?.headers.get("mcp-method")).toBe("tasks/get");
    expect(get?.headers.get("mcp-name")).toBe("task-1");
    expect(get?.rpc?.params?.["_meta"]).toMatchObject({
      "io.modelcontextprotocol/clientCapabilities": { extensions: { [TASKS_EXTENSION]: {} } },
    });
  });

  it("answers a task's questions with tasks/update and reads the result after", async () => {
    const server = modernTaskServer();

    const states = await withConnection(server, (connection) =>
      Effect.gen(function* () {
        const id = yield* taskOf(connection, { region: "eu", ask: true });
        const asking = yield* connection.task.get(id, TASKING);

        yield* connection.task.update(
          id,
          { which: { action: "accept", content: { region: "eu" } } },
          TASKING,
        );

        return [asking, yield* connection.task.get(id, TASKING)];
      }),
    );

    expect(states[0]?.task).toMatchObject({
      status: "input_required",
      inputRequests: { which: { method: "elicitation/create" } },
    });
    expect(states[1]?.task.status).toBe("completed");
    expect(server.tasks.get("task-1")?.answers).toEqual({
      which: { action: "accept", content: { region: "eu" } },
    });
    expect(rpcMethods(server)).toContain("tasks/update");
  });

  it("cancels a task, and reads a failed one's error", async () => {
    const ended = await withConnection(modernTaskServer(), (connection) =>
      Effect.gen(function* () {
        const slow = yield* taskOf(connection, { polls: 5 });
        const broken = yield* taskOf(connection, { fail: true });

        yield* connection.task.cancel(slow, TASKING);

        return [
          yield* connection.task.get(slow, TASKING),
          yield* connection.task.get(broken, TASKING),
        ];
      }),
    );

    expect(ended[0]?.task.status).toBe("cancelled");
    expect(ended[1]?.task).toMatchObject({
      status: "failed",
      error: { code: -32000, message: "the report failed" },
    });
  });

  it("fails an unknown task as not found, and a Legacy connection as unsupported", async () => {
    const unknown = await withConnection(modernTaskServer(), (connection) =>
      settled(connection.task.get("no-such-task", TASKING)),
    );

    expect(unknown).toEqual(failedWith(NotFound, { code: -32602 }));

    const legacy = await withConnection(legacyStatelessServer(), (connection) =>
      settled(connection.task.get("task-1", TASKING)),
    );

    expect(legacy).toEqual(failedWith(Unsupported));
  });
});

describe("the 16 MiB limits", () => {
  it("brings a result just under 16 MiB through tasks/get, and refuses one over it", async () => {
    const read = (bytes: number) =>
      withConnection(modernTaskServer(), (connection) =>
        Effect.gen(function* () {
          const id = yield* taskOf(connection, { bytes });

          return yield* settled(connection.task.get(id, TASKING));
        }),
      );

    const under = await read(MCP_LARGE_RESULT_BYTES - 1024);
    const over = await read(MCP_LARGE_RESULT_BYTES + 1024);

    expect(under).toMatchObject({ value: { task: { status: "completed" } } });
    expect(over).toEqual(failedWith(TooLarge, { limit: MCP_LARGE_RESULT_BYTES }));
  });

  it("refuses a tools/call answered inline over 16 MiB as it does on the client's own path", async () => {
    const result = await withConnection(modernTaskServer(), (connection) =>
      settled(report(connection, { bytes: MCP_LARGE_RESULT_BYTES + 1024, inline: true })),
    );

    expect(result).toEqual(failedWith(TooLarge));
  });
});

/**
 * `base`, except that its first `times` requests for `method` are cut: the connection breaks, or (`streamed`) the answer's
 * stream ends before its answer arrives.
 */
const cutting = (base: FakeServer, method: string, times: number, streamed = false) => {
  let cut = 0;

  return hostileServer(base, (_request, rpc) => {
    if (rpc?.method !== method || cut >= times) return undefined;

    cut += 1;

    if (streamed) {
      return sse([
        { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "x" } },
      ]);
    }

    throw new TypeError("network connection lost");
  });
};

describe("a tasks/* request cut before its answer", () => {
  it("sends tasks/get once more, as a read", async () => {
    const base = modernTaskServer();
    const server = cutting(base, "tasks/get", 1, true);

    const state = await withConnection(server, (connection) =>
      Effect.gen(function* () {
        const id = yield* taskOf(connection, {});

        return yield* connection.task.get(id, TASKING);
      }),
    );

    expect(state.task.status).toBe("completed");
    expect(rpcMethods(server).filter((method) => method === "tasks/get")).toHaveLength(2);
  });

  it("sends tasks/update and tasks/cancel once more, though the first may have run", async () => {
    const base = modernTaskServer();
    const server = cutting(cutting(base, "tasks/update", 1), "tasks/cancel", 1);

    await withConnection(server, (connection) =>
      Effect.gen(function* () {
        const asking = yield* taskOf(connection, { ask: true });
        const slow = yield* taskOf(connection, { polls: 5 });

        yield* connection.task.update(asking, { which: { action: "accept" } }, TASKING);
        yield* connection.task.cancel(slow, TASKING);
      }),
    );

    expect(rpcMethods(server).filter((method) => method === "tasks/update")).toHaveLength(2);
    expect(rpcMethods(server).filter((method) => method === "tasks/cancel")).toHaveLength(2);
    expect(base.tasks.get("task-2")?.status).toBe("cancelled");
  });

  it("fails a cancel cut twice as a cut that may have run, after one resend only", async () => {
    const server = cutting(modernTaskServer(), "tasks/cancel", 5);

    const failed = await withConnection(server, (connection) =>
      Effect.gen(function* () {
        const id = yield* taskOf(connection, { polls: 5 });

        return yield* settled(connection.task.cancel(id, TASKING));
      }),
    );

    expect(failed).toEqual(failedWith(Cut, { mayHaveRun: true }));
    expect(rpcMethods(server).filter((method) => method === "tasks/cancel")).toHaveLength(2);
  });

  it("fails a tasks/get cut twice as a cut that did not run, after one resend only", async () => {
    const server = cutting(modernTaskServer(), "tasks/get", 5, true);

    const failed = await withConnection(server, (connection) =>
      Effect.gen(function* () {
        const id = yield* taskOf(connection, {});

        return yield* settled(connection.task.get(id, TASKING));
      }),
    );

    expect(failed).toEqual(failedWith(Cut, { mayHaveRun: false }));
    expect(rpcMethods(server).filter((method) => method === "tasks/get")).toHaveLength(2);
  });

  it("never sends a tools/call that may have run once more", async () => {
    const server = cutting(modernTaskServer(), "tools/call", 5);

    const failed = await withConnection(server, (connection) =>
      settled(report(connection, { region: "eu" })),
    );

    expect(failed).toEqual(failedWith(Cut, { mayHaveRun: true }));
    expect(rpcMethods(server).filter((method) => method === "tools/call")).toHaveLength(1);
  });
});

/**
 * A server that answers as `first` until its next `method` request, which gets a 405 (a Modern era drop) and is
 * followed by `then`, as a server downgraded or redeployed without the extension does.
 */
const replacedAt = (method: string, first: FakeServer, then: FakeServer) => {
  let active = first;

  const server = hostileServer(
    { handle: (request) => active.handle(request), received: [] },
    (_request, rpc: RpcBody | undefined) => {
      if (rpc?.method !== method || active !== first) return undefined;

      active = then;

      return new Response(null, { status: 405 });
    },
  );

  return server;
};

describe("a request after the server's era dropped", () => {
  it("fails a tasks/* request as unsupported, sending none to a server that is Legacy now", async () => {
    const legacy = legacyStatelessServer({ moreTools: [REPORT_TOOL] });
    const server = replacedAt("tasks/get", modernTaskServer(), legacy);

    const failed = await withConnection(server, (connection) =>
      Effect.gen(function* () {
        const id = yield* taskOf(connection, {});

        return yield* settled(connection.task.get(id, TASKING));
      }),
    );

    expect(failed).toEqual(failedWith(Unsupported, { message: expect.stringContaining("Legacy") }));
    expect(rpcMethods(legacy)).not.toContain("tasks/get");
  });

  it("fails a tasks/* request as unsupported when the server is Modern but no longer advertises the extension", async () => {
    const after = modernTaskServer({ unadvertised: true });
    const server = replacedAt("tasks/cancel", modernTaskServer(), after);

    const failed = await withConnection(server, (connection) =>
      Effect.gen(function* () {
        const id = yield* taskOf(connection, { polls: 5 });

        return yield* settled(connection.task.cancel(id, TASKING));
      }),
    );

    expect(failed).toEqual(
      failedWith(Unsupported, { message: expect.stringContaining("no longer advertises") }),
    );
    expect(rpcMethods(after)).not.toContain("tasks/cancel");
  });

  it("sends a tools/call again to a server that is Legacy now without declaring the extension", async () => {
    const legacy = legacyStatelessServer({ moreTools: [REPORT_TOOL] });
    const server = replacedAt("tools/call", modernTaskServer(), legacy);

    const outcome = await withConnection(server, (connection) =>
      report(connection, { text: "again" }),
    );

    expect(outcome.kind).toBe("complete");
    expect(rpcMethods(legacy)).toContain("tools/call");
    expect(JSON.stringify(legacy.received.map((received) => received.rpc))).not.toContain(
      TASKS_EXTENSION,
    );
  });

  it("sends a tools/call again to a Modern server that no longer advertises the extension without declaring it", async () => {
    const after = modernTaskServer({ unadvertised: true });
    const server = replacedAt("tools/call", modernTaskServer(), after);

    const outcome = await withConnection(server, (connection) =>
      report(connection, { region: "eu" }),
    );

    expect(completed(outcome).value.content).toEqual([{ type: "text", text: "report:eu" }]);
    expect(after.declared).toEqual([{ method: "tools/call", tasks: false }]);
    expect(after.tasks.size).toBe(0);
  });
});

describe("a task the request did not ask for", () => {
  it("is a protocol violation on the client's own path, and the caller never gets the task", async () => {
    const server = modernTaskServer({ alwaysTask: true });

    const failed = await withConnection(server, (connection) =>
      settled(report(connection, { region: "eu" }, AGENT)),
    );

    expect(failed).toEqual(
      failedWith(ProtocolViolation, { message: expect.stringContaining("not asked for") }),
    );
    expect(server.declared).toEqual([{ method: "tools/call", tasks: false }]);
  });
});
