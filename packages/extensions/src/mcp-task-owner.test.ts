// What the owner does with the Session's MCP tasks from a client (`docs/architecture/mcp-server-requests.md` → MCP tasks,
// Cancellation): the list, a cancel that ends the task as `owner`, and Keep the Container of a stdio server's task.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off globalDate:off
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";
import type { FakeMcpServer } from "./mcp.testing.ts";
import {
  ended,
  recordNow,
  scripted,
  SECRET,
  SERVER,
  setup,
  TIMING,
  turn,
} from "./mcp-tasks.fixture.ts";
import { viewOfTasks } from "./mcp/task-owner.ts";
import { McpTasksDoc } from "./mcp/task-state.ts";
import { context } from "./subagents/harness.fixture.ts";

const STDIO: FakeMcpServer = { ...SERVER, entry: { type: "stdio", command: "npx" } };

describe("the owner's MCP tasks", () => {
  it("lists a task by its handle, never the server's task id, and one that ended with how", async () => {
    const { session, tools } = await setup(10_000);

    await turn(session, "go");

    const [live] = viewOfTasks(await session.harness.snapshot(McpTasksDoc, context));

    expect(live).toMatchObject({
      task: "mcp-task-1",
      server: "docs",
      background: true,
      status: "working",
    });
    expect(JSON.stringify(live)).not.toContain(SECRET);

    const took = await Effect.runPromise(tools.cancelTask(session.harness, "mcp-task-1"));

    expect(took).toBe("sent");
    await session.until(ended(session), "the task to end");

    const [gone] = viewOfTasks(await session.harness.snapshot(McpTasksDoc, context));

    expect(gone).toMatchObject({ status: "cancelled", end: { by: "owner" } });
    expect(gone?.endedAt).toBeTypeOf("number");
    await session.root.abort(context, { background: true });
  });

  it("lists when the agent was told, and nothing for one that was not", async () => {
    const { session } = await setup(10_000);

    await turn(session, "go");

    const state = await session.harness.snapshot(McpTasksDoc, context);
    const record = state?.tasks["mcp-task-1"];

    if (state === undefined || record === undefined) throw new Error("no task");

    expect(viewOfTasks(state)[0]).not.toHaveProperty("toldAt");

    const told = { ...state, tasks: { "mcp-task-1": { ...record, toldAt: 1234 } } };

    expect(viewOfTasks(told)[0]).toMatchObject({ toldAt: 1234 });
    await session.root.abort(context, { background: true });
  });

  it("is cancelled once, and says so for one that is gone, ended or unknown", async () => {
    const { session, taskServer, tools } = await setup(10_000);

    await turn(session, "go");

    const cancel = (task: string) => Effect.runPromise(tools.cancelTask(session.harness, task));

    expect(await cancel("mcp-task-1")).toBe("sent");
    expect(await cancel("mcp-task-1")).toBe("already_sent");
    expect(await cancel("mcp-task-9")).toBe("unknown");
    await session.until(ended(session), "the task to end");
    expect(await cancel("mcp-task-1")).toBe("ended");
    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
    expect(await recordNow(session, "mcp-task-1")).toMatchObject({ end: { by: "owner" } });
  });

  it("keeps the Container of a stdio server's task, and only of a live stdio one", async () => {
    const touched: boolean[] = [];

    const { session, tools } = await setup(10_000, TIMING, scripted(), {
      servers: [STDIO],
      ready: async () => {
        touched.push(true);

        return true;
      },
    });

    await turn(session, "go");

    const keep = (task: string) => Effect.runPromise(tools.keepContainer(session.harness, task));

    expect(await keep("mcp-task-1")).toBe("kept");
    expect(touched.length).toBeGreaterThan(0);
    expect(await keep("mcp-task-7")).toBe("unknown");
    expect(viewOfTasks(await session.harness.snapshot(McpTasksDoc, context))[0]).toMatchObject({
      stdio: true,
    });
    await session.root.abort(context, { background: true });
    await session.until(ended(session), "the task to end");
    expect(await keep("mcp-task-1")).toBe("ended");
  });

  it("does not keep the Container of an HTTP server's task", async () => {
    const { session, tools } = await setup(10_000);

    await turn(session, "go");
    expect(await Effect.runPromise(tools.keepContainer(session.harness, "mcp-task-1"))).toBe(
      "not_stdio",
    );
    await session.root.abort(context, { background: true });
  });
});
