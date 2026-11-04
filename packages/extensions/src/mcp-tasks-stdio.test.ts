// An MCP task a stdio server's call started (`docs/architecture/mcp-server-requests.md` → MCP tasks, Polling cadence,
// Failures, Lifecycle): it is offered one like an HTTP server's call, and a task lives in the process that started it, so
// a poll answered by another spawn, a `-32602` (a restarted process cannot know it), or a stopped Container (a poll
// never starts it) ends it `unknown` at once, and is posted as a follow-up Run like any end cloudpid decided. A scripted
// model on a Harness over an in-memory host.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off globalDate:off
import { McpHostCallFailed, NotFound, ServerChanged, Unreachable } from "@cloudpid/mcp/types";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { FakeMcpServer } from "./mcp.testing.ts";
import {
  offers,
  recordNow,
  scripted,
  SERVER,
  setup,
  TIMING,
  toldOfEnd,
  turn,
} from "./mcp-tasks.fixture.ts";
import { pollDelayMs } from "./mcp/task-policy.ts";
import { taskContext } from "./mcp/task-port.ts";
import { context } from "./subagents/harness.fixture.ts";

const STDIO: FakeMcpServer = { ...SERVER, entry: { type: "stdio", command: "npx" } };

const stdio = { servers: [STDIO], ready: async () => true };

const stopped = async () =>
  McpHostCallFailed.make({
    error: Unreachable.make({ message: "Container stopped", stopped: true }),
  });

const unknownTask = async () =>
  McpHostCallFailed.make({ error: NotFound.make({ message: "unknown task", code: -32602 }) });

describe("a stdio server's MCP task", () => {
  it("is offered a task, recorded with its Workspace and process, and detached with the Container's warning", async () => {
    const { session, taskServer } = await setup(10_000, TIMING, scripted(), {
      ...stdio,
      host: { spawnOf: () => "spawn-1" },
    });

    await turn(session, "go");

    expect(offers(taskServer)).toEqual([true]);
    expect(await recordNow(session, "mcp-task-1")).toMatchObject({
      transport: "stdio",
      workspace: "ws:w1",
      spawn: "spawn-1",
      background: true,
    });
    expect((await session.texts("toolResult"))[0]).toContain("runs in the Workspace's Container");
    await session.root.abort(context, { background: true });
  });

  it("is `unknown` when the Container stopped, and the end is posted in a Run of its own", async () => {
    const { session, submitted, taskServer } = await setup(10_000, TIMING, scripted(), {
      ...stdio,
      host: {
        spawnOf: () => "spawn-1",
        getAnswer: (n) => (n >= 40 ? stopped() : undefined),
      },
    });

    await turn(session, "go");
    await session.until(async () => await toldOfEnd(session), "the end to be posted");
    await session.settle();

    const record = await recordNow(session, "mcp-task-1");

    expect(record?.end).toMatchObject({ status: "unknown", by: "cloudpid" });
    expect(record?.end?.reason).toContain("Container stopped");
    expect(record?.delivery).toBe("auto");
    expect(submitted).toHaveLength(1);
    expect(
      (await session.texts("user")).find((text) => text.startsWith("[MCP task ended")),
    ).toContain("status=unknown");
    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(0);
  });

  it("is `unknown` at once when a poll is answered by another process", async () => {
    const { session } = await setup(10_000, TIMING, scripted(), {
      ...stdio,
      host: { spawnOf: (n) => (n >= 40 ? "spawn-2" : "spawn-1") },
    });

    await turn(session, "go");
    await session.until(async () => await toldOfEnd(session), "the end to be posted");

    expect((await recordNow(session, "mcp-task-1"))?.end).toMatchObject({
      status: "unknown",
      reason: "the server's process was restarted, which ended the task",
    });
  });

  it("is retried for the grace when the server does not know the task, and then `unknown` without claiming a restart", async () => {
    const { session } = await setup(10_000, { ...TIMING, unknownGraceMs: 120 }, scripted(), {
      ...stdio,
      host: {
        spawnOf: () => "spawn-1",
        getAnswer: (n) => (n >= 40 ? unknownTask() : undefined),
      },
    });

    await turn(session, "go");
    await session.until(
      async () => (await recordNow(session, "mcp-task-1"))?.failures.unknownSince !== undefined,
      "the first -32602",
    );
    // Inside the grace nothing ended it: a lag looks like this too.
    expect((await recordNow(session, "mcp-task-1"))?.end).toBeUndefined();
    await session.until(async () => await toldOfEnd(session), "the end to be posted");

    const end = (await recordNow(session, "mcp-task-1"))?.end;

    expect(end).toMatchObject({
      status: "unknown",
      by: "cloudpid",
      reason: "the server no longer knows it",
    });
    expect(end?.reason).not.toContain("restart");
  });

  it("is `unknown` at once, whatever the grace, when its server's definition changed", async () => {
    const changed = async () =>
      ServerChanged.make({ message: "changed", conn: "conn-2", identity: "identity-docs" });

    const { session, taskServer } = await setup(
      10_000,
      { ...TIMING, unknownGraceMs: 60_000 },
      scripted(),
      {
        ...stdio,
        host: {
          spawnOf: () => "spawn-1",
          getAnswer: (n) => (n >= 40 ? changed() : undefined),
        },
      },
    );

    await turn(session, "go");
    await session.until(async () => await toldOfEnd(session), "the end to be posted");

    // The same identity would be re-pinned for an HTTP server; a stdio process may be another command, so it is lost.
    expect((await recordNow(session, "mcp-task-1"))?.end).toMatchObject({
      status: "unknown",
      by: "cloudpid",
      reason: "the server's definition changed, so its process is not the one that ran the task",
    });
    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(0);
  });

  it("is polled in the Workspace of its record, never the Session's", () => {
    const ctx = taskContext(
      { session: "s1", workspace: "ws:session" },
      { callId: "c1", conversation: ROOT_CONVERSATION_ID, workspace: "ws:subagent" },
    );

    expect(ctx.workspace).toBe("ws:subagent");
    expect(
      taskContext(
        { session: "s1", workspace: "ws:session" },
        { callId: "c1", conversation: ROOT_CONVERSATION_ID },
      ).workspace,
    ).toBe("ws:session");
  });

  it("is polled at most a minute apart, though its server asks for five", () => {
    const cadence = { ageMs: 0, pollIntervalMs: 300_000, background: true, ownerOnly: false };

    expect(pollDelayMs({ ...cadence, jitter: 0 })).toBe(300_000);
    expect(pollDelayMs({ ...cadence, stdio: true, jitter: 0 })).toBe(60_000);
    expect(pollDelayMs({ ...cadence, stdio: true, jitter: 0.99 })).toBeLessThan(66_100);
  });

  it("is not a reason to end an HTTP server's task: a stopped answer is retried there", async () => {
    const { session } = await setup(10_000, TIMING, scripted(), {
      host: { getAnswer: (n) => (n >= 40 ? stopped() : undefined) },
    });

    await turn(session, "go");
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect((await recordNow(session, "mcp-task-1"))?.end).toBeUndefined();
  });
});
