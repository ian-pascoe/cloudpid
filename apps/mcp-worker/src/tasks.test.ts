/**
 * The engine's `tasks/*` requests and task-capable `tools/call` (`docs/architecture/mcp-server-requests.md` → MCP
 * tasks), over the core and a fake Modern task server: a task only for a call that asked for one, `tasks/get`'s result
 * as any result's value (a stream when large), its `structuredContent` checked, `tasks/update` and `tasks/cancel`
 * answered as acks, and what the server says of a task scrubbed of the call's tokens.
 */
// @effect-diagnostics asyncFunction:off globalFetch:off preferEffectArray:off strictEffectProvide:off schemaSync:off
import {
  fetchTo,
  hostileServer,
  REPORT_TOOL,
  modernTaskServer,
  type FakeServer,
} from "@cloudpid/mcp/testing";
import {
  type McpCallContext,
  type McpEngineRequestEncoded,
  McpEngineRequestResult,
  NotFound,
} from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ByteBudget } from "./budget.ts";
import { request } from "./calls.ts";
import { Validators } from "./validators.ts";

const TOKEN = "tok-from-the-host-0123456789";

const AGENT: McpCallContext = { origin: "agent", conversation: "conversation-1" };

const TASKING: McpCallContext = { ...AGENT, allowTask: true };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** `input` run against `server`, as the engine runs a host's request. */
const requested = async (server: FakeServer, input: McpEngineRequestEncoded) => {
  vi.stubGlobal("fetch", fetchTo(server));

  const answer = await Effect.runPromise(
    request(
      { kind: "http", conn: "conn-1", name: "reports", url: "https://reports.example.test/mcp" },
      {},
      input,
      { auth: () => Promise.resolve(TOKEN) },
      { version: "test", hold: () => undefined },
    ).pipe(Effect.provide(Layer.mergeAll(ByteBudget.layer, Validators.layer))),
  );

  return Schema.decodeSync(McpEngineRequestResult)(answer);
};

const call = (ctx: McpCallContext, args: Record<string, string | number | boolean> = {}) =>
  ({ op: "tools/call", tool: REPORT_TOOL, arguments: args, ctx }) satisfies McpEngineRequestEncoded;

describe("a tools/call", () => {
  it("returns the task the server started to a call that asked for one", async () => {
    const result = await requested(modernTaskServer(), call(TASKING, { region: "eu" }));

    expect(result).toMatchObject({
      kind: "task",
      task: { taskId: "task-1", status: "working" },
    });
  });

  it("returns a result, never a task, to a call that did not ask for one", async () => {
    const server = modernTaskServer();
    const result = await requested(server, call(AGENT, { region: "eu" }));

    expect(result.kind).toBe("complete");
    expect(server.tasks.size).toBe(0);
  });
});

describe("tasks/get", () => {
  it("answers where the task stands, and a completed task's result as a result's value", async () => {
    const server = modernTaskServer();

    await requested(server, call(TASKING, { region: "eu" }));

    const done = await requested(server, { op: "tasks/get", taskId: "task-1", ctx: TASKING });

    expect(done).toMatchObject({
      kind: "task_state",
      task: { status: "completed" },
      result: {
        kind: "inline",
        value: { content: [{ type: "text", text: "report:eu" }] },
      },
    });
  });

  it("answers a working task with no result", async () => {
    const server = modernTaskServer();

    await requested(server, call(TASKING, { polls: 3 }));

    const working = await requested(server, { op: "tasks/get", taskId: "task-1", ctx: TASKING });

    expect(working).toMatchObject({ kind: "task_state", task: { status: "working" } });
    expect(working).not.toHaveProperty("result");
  });

  it("streams a completed task's result over 1 MiB, and holds it to its tool's outputSchema", async () => {
    const server = modernTaskServer();

    await requested(server, call(TASKING, { bytes: 2 * 1024 * 1024 }));

    const big = await requested(server, {
      op: "tasks/get",
      taskId: "task-1",
      tool: {
        ...REPORT_TOOL,
        outputSchema: {
          type: "object",
          properties: { count: { type: "number" } },
          required: ["count"],
        },
      },
      ctx: TASKING,
    });

    expect(big).toMatchObject({
      kind: "task_state",
      result: { kind: "stream" },
      structuredOutput: { valid: false },
    });
  });

  it("scrubs what the server says of the task of the tokens the call sent", async () => {
    const base = modernTaskServer();

    const leaky = hostileServer(base, (_request, rpc) =>
      rpc?.method === "tasks/get"
        ? Response.json({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              resultType: "complete",
              taskId: "task-1",
              status: "failed",
              createdAt: "2026-01-01T00:00:00.000Z",
              lastUpdatedAt: "2026-01-01T00:00:00.000Z",
              ttlMs: null,
              statusMessage: `rejected ${TOKEN}`,
              error: { code: -32000, message: `bad credential ${TOKEN}` },
            },
          })
        : undefined,
    );

    await requested(leaky, call(TASKING));

    const failed = await requested(leaky, { op: "tasks/get", taskId: "task-1", ctx: TASKING });

    expect(JSON.stringify(failed)).not.toContain(TOKEN);
    expect(failed).toMatchObject({
      kind: "task_state",
      task: { status: "failed", ttlMs: null, error: { code: -32000 } },
    });
  });
});

describe("tasks/update and tasks/cancel", () => {
  it("answer an ack once the server took them", async () => {
    const server = modernTaskServer();

    await requested(server, call(TASKING, { ask: true }));

    const updated = await requested(server, {
      op: "tasks/update",
      taskId: "task-1",
      inputResponses: { which: { action: "accept", content: {} } },
      ctx: TASKING,
    });

    const cancelled = await requested(server, {
      op: "tasks/cancel",
      taskId: "task-1",
      ctx: TASKING,
    });

    expect([updated.kind, cancelled.kind]).toEqual(["task_ack", "task_ack"]);
    expect(server.tasks.get("task-1")?.answers).toEqual({
      which: { action: "accept", content: {} },
    });
    expect(server.tasks.get("task-1")?.status).toBe("cancelled");
  });

  it("fail as the server fails them: an unknown task is not found", async () => {
    const result = await requested(modernTaskServer(), {
      op: "tasks/cancel",
      taskId: "task-9",
      ctx: TASKING,
    });

    expect(result).toMatchObject({
      kind: "failed",
      error: expect.objectContaining({ constructor: NotFound, code: -32602 }),
    });
  });
});
