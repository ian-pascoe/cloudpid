// An MCP task the root agent's call started, followed through the `mcp` extension over an in-memory host (`docs/architecture/
// mcp-server-requests.md` → MCP tasks): a call that ends inside the window returns as a synchronous call would; one that
// does not detaches with a handle and the three tools, is followed by its follower to its end, and the agent is told by
// an entry and a follow-up Run (or, for an end the agent caused, a notice and no Run); `mcp_task_wait` reads the result as
// often as asked; the server's task id reaches nothing the model reads; and a call a restart cut off after its record was
// stored finds the record and sends nothing again. A scripted model on a Harness.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off globalDate:off
import {
  McpHostCallFailed,
  McpHostTaskAck,
  McpHostTaskStarted,
  NotFound,
  ServerError,
} from "@cloudpid/mcp/types";
import type { TaskId, ToolExecutionApi } from "@earendil-works/pi-durable";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import * as Record from "effect/Record";
import { describe, expect, it, vi } from "vitest";
import { open } from "./mcp.fixture.ts";
import {
  makeMcpTools,
  memoryMcpToolsStore,
  MCP_TASK_ENDED_KIND,
  MCP_TASK_NOTICE_KIND,
} from "./mcp.ts";
import { type FakeMcpServer, fakeMcpHost } from "./mcp.testing.ts";
import { recordOfCall, startTask } from "./mcp/task-inline.ts";
import {
  CREATED,
  ended,
  memory,
  offers,
  recordNow,
  scripted,
  SECRET,
  SERVER,
  setup,
  TIMING,
  taskHost,
  toldOfEnd,
  turn,
} from "./mcp-tasks.fixture.ts";
import { addTask, McpTasksDoc, type McpTasksState } from "./mcp/task-state.ts";
import { HostLost, type McpHostClientService } from "./mcp/client.ts";
import { resultPool } from "./mcp/task-results.ts";
import { sweepTasks } from "./mcp/task-sweep.ts";
import { answer, call, context, gate } from "./subagents/harness.fixture.ts";

describe("an MCP task inside the window", () => {
  it("returns as a synchronous call would, offered a task and never shown its id", async () => {
    const { session, taskServer, toolCalls, submitted, everything } = await setup(3, {
      ...TIMING,
      windowMs: 5000,
    });

    await session.root
      .submit({ type: "input", content: "go" }, context)
      .then((s) => s.wait(context));

    expect(await session.texts("toolResult")).toEqual([expect.stringContaining("the report")]);
    expect(toolCalls()).toHaveLength(1);
    expect(toolCalls()[0]?.ctx).toMatchObject({ allowTask: true, origin: "agent" });
    expect(taskServer.gets()).toBe(3);
    // Nothing detached: nobody was told of an end and no follower started a Run.
    expect(submitted).toEqual([]);
    expect(await everything()).not.toContain(MCP_TASK_ENDED_KIND);
    expect(await everything()).not.toContain(SECRET);

    const gets = taskServer.sent.filter((input) => input.op === "tasks/get");

    expect(gets[0]).toMatchObject({
      server: "docs",
      params: { taskId: SECRET, tool: "report", conn: "conn-docs" },
    });
  });
});

describe("an MCP task that outlasts the window", () => {
  it("detaches with a handle and the tools, and the follower tells the agent of the end in a Run of its own", async () => {
    const { session, taskServer, toolCalls, submitted, everything } = await setup(30);

    await session.root
      .submit({ type: "input", content: "go" }, context)
      .then((s) => s.wait(context));

    // The call returned at the window's end, with the handle, and its tools were loaded for the next request.
    const [first] = await session.texts("toolResult");

    expect(first).toContain("runs as MCP task mcp-task-1");
    expect(first).not.toContain(SECRET);

    await session.until(async () =>
      (await session.texts("user")).some((text) => text.startsWith("[MCP task ended")),
    );
    await session.settle();

    const ended =
      (await session.texts("user")).find((text) => text.startsWith("[MCP task ended")) ?? "";

    expect(ended).toContain(
      "task=mcp-task-1 | server=docs | tool=mcp__docs__report | status=completed",
    );
    expect(ended).toContain('Read its result with mcp_task_wait (task "mcp-task-1")');
    expect(submitted).toHaveLength(1);
    expect(toolCalls()).toHaveLength(1);
    expect(taskServer.gets()).toBe(30);

    // The entry is the follower's, a kind the web renders; the Run it started answered it.
    const entries = await session.entries();

    expect(entries.some((entry) => entry.kind === MCP_TASK_ENDED_KIND)).toBe(true);
    expect(await session.texts("assistant")).toContain("noted the end");
    expect(await everything()).not.toContain(SECRET);

    // The three tools were offered after the detach.
    const last = session.requests.at(-1);

    expect(last?.tools).toEqual(
      expect.arrayContaining(["mcp_tasks", "mcp_task_wait", "mcp_task_cancel"]),
    );
  });

  it("is read by mcp_task_wait as often as asked, after the end as before it", async () => {
    const { session, everything } = await setup(
      30,
      TIMING,
      scripted((text) =>
        text === "wait" || text === "again"
          ? call(["mcp_task_wait", { task: "mcp-task-1" }])
          : undefined,
      ),
    );

    await session.root
      .submit({ type: "input", content: "go" }, context)
      .then((s) => s.wait(context));
    await session.root
      .submit({ type: "input", content: "wait" }, context)
      .then((s) => s.wait(context));
    await session.settle();
    await session.root
      .submit({ type: "input", content: "again" }, context)
      .then((s) => s.wait(context));

    const results = await session.texts("toolResult");

    expect(results.filter((text) => text.includes("the report"))).toHaveLength(2);
    expect(await everything()).not.toContain(SECRET);
  });

  it("lists the agent's tasks, and a task of another name is one it does not have", async () => {
    const { session } = await setup(
      200,
      TIMING,
      scripted((text) => {
        if (text === "wait") return call(["mcp_tasks", {}]);

        return text === "again"
          ? call(["mcp_task_wait", { task: "mcp-task-9", timeout_s: 1 }])
          : undefined;
      }),
    );

    await session.root
      .submit({ type: "input", content: "go" }, context)
      .then((s) => s.wait(context));
    await session.root
      .submit({ type: "input", content: "wait" }, context)
      .then((s) => s.wait(context));
    await session.root
      .submit({ type: "input", content: "again" }, context)
      .then((s) => s.wait(context));

    const results = await session.texts("toolResult");

    expect(results[1]).toContain("mcp-task-1 · docs · mcp__docs__report · working");
    expect(results[1]).not.toContain(SECRET);
    expect(results[2]).toContain('You have no MCP task "mcp-task-9"');

    await session.root.abort(context);
  });

  it("is cancelled at the server by the agent, who is told in a notice and no Run", async () => {
    const { session, taskServer, written, submitted, everything } = await setup(
      10_000,
      TIMING,
      scripted((text) =>
        text === "cancel" ? call(["mcp_task_cancel", { task: "mcp-task-1" }]) : undefined,
      ),
    );

    await session.root
      .submit({ type: "input", content: "go" }, context)
      .then((s) => s.wait(context));
    await session.root
      .submit({ type: "input", content: "cancel" }, context)
      .then((s) => s.wait(context));
    await session.until(async () => written.length > 0, "the notice");
    await session.settle();

    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
    expect(written).toEqual([
      expect.objectContaining({
        requestId: "mcp-task-notice:mcp-task-1",
        kind: MCP_TASK_NOTICE_KIND,
      }),
    ]);
    expect(submitted).toEqual([]);
    expect((await session.texts("user")).some((text) => text.startsWith("[MCP task ended"))).toBe(
      false,
    );
    expect(await everything()).not.toContain(SECRET);
  });

  it("is unknown once the host answers every poll with -32602 for the grace", async () => {
    const host = fakeMcpHost([SERVER]);
    const taskServer = taskHost(10_000);

    host.answer(async (input, hooks) => {
      if (input.op === "tasks/get") {
        taskServer.sent.push(input);

        return McpHostCallFailed.make({ error: NotFound.make({ message: "gone", code: -32602 }) });
      }

      return taskServer.answerOf(input, hooks);
    });

    const tools = makeMcpTools(host.client, memoryMcpToolsStore(), {
      slackMs: 0,
      tasks: { storage: memory(), timing: { ...TIMING, windowMs: 20 } },
    });

    const session = await open(scripted());

    await session.start(tools);
    await session.root
      .submit({ type: "input", content: "go" }, context)
      .then((s) => s.wait(context));
    await session.until(async () =>
      (await session.texts("user")).some((text) => text.includes("status=unknown")),
    );
    await session.settle();

    const ended =
      (await session.texts("user")).find((text) => text.includes("status=unknown")) ?? "";

    expect(ended).toContain("(the server no longer knows it)");
  });
});

/** What a commit of the fake `ToolExecutionApi` is given. */
type FakeTx = {
  readonly doc: (kind: typeof McpTasksDoc) => Promise<McpTasksState>;
  readonly createTask: () => Promise<string>;
};

/** The members of the tool API the task record's code reads, over a state kept in memory. */
const fakeApi = (state: McpTasksState, memos: Map<string, string>, crashOnMemo: boolean) => {
  const api = {
    callId: "call-1",
    taskId: "call-1",
    conversationId: ROOT_CONVERSATION_ID,
    now: () => 5000,
    commit: async <T>(fn: (tx: FakeTx) => Promise<T> | T): Promise<T> =>
      fn({ doc: async () => state, createTask: async () => "follower-1" }),
    memo: async (key: string, value: string): Promise<string> => {
      if (crashOnMemo) throw new Error("the object went away");

      const held = memos.get(key);

      if (held !== undefined) return held;

      memos.set(key, value);

      return value;
    },
    snapshot: async () => state,
  };

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: a partial fake of the tool API: `startTask` and `recordOfCall` read only these members.
  return api as unknown as ToolExecutionApi;
};

describe("a call a restart cut off after its record was stored", () => {
  it("finds the record whether or not the `mcp.task` marker followed it, and stores no second one", async () => {
    const state: McpTasksState = { next: 1, tasks: {}, recent: [] };
    const memos = new Map<string, string>();

    const started = McpHostTaskStarted.make({
      task: { ...CREATED, status: "working" },
      conn: "conn-docs",
    });

    const draft = {
      server: "docs",
      tool: "report",
      modelTool: "mcp__docs__report",
      windowMs: 60_000,
    };

    const take = (api: ToolExecutionApi): Parameters<typeof startTask>[0] =>
      // SAFETY: `startTask` reads only the call's `api` and `context`.
      ({ api, context }) as Parameters<typeof startTask>[0];

    // The object stops between the commit and the marker.
    await expect(startTask(take(fakeApi(state, memos, true)), started, draft)).rejects.toThrow(
      "went away",
    );
    expect(Record.keys(state.tasks)).toEqual(["mcp-task-1"]);
    expect(memos.size).toBe(0);

    // The rerun finds it by the call, with no marker; a second start stores nothing new and writes the marker.
    const rerun = fakeApi(state, memos, false);

    expect(await recordOfCall(rerun, context, "call-1")).toMatchObject({
      handle: "mcp-task-1",
      taskId: SECRET,
    });

    const again = await startTask(take(rerun), started, draft);

    expect(again.handle).toBe("mcp-task-1");
    expect(Record.keys(state.tasks)).toEqual(["mcp-task-1"]);
    expect(state.next).toBe(2);
    expect(memos.get("mcp.task")).toBe("mcp-task-1");
  });
});

describe("what a server writes of its task", () => {
  it("is redacted of held Secrets before it is stored or shown, and the model never reads the server's id", async () => {
    const { session, everything } = await setup(
      200,
      TIMING,
      scripted((text) => (text === "list" ? call(["mcp_tasks", {}]) : undefined)),
      {
        host: { message: "Using key sk-live-123 for the report" },
        redact: async (text) => text.replaceAll("sk-live-123", "[redacted]"),
      },
    );

    await turn(session, "go");
    await turn(session, "list");

    expect((await recordNow(session, "mcp-task-1"))?.statusMessage).toBe(
      "Using key [redacted] for the report",
    );
    expect((await session.texts("toolResult")).join("\n")).toContain(
      "Using key [redacted] for the report",
    );
    expect(await everything()).not.toContain("sk-live-123");
    expect(await everything()).not.toContain(SECRET);
    await session.root.abort(context, { background: true });
  });
});

describe("a cancel", () => {
  it("is sent once, and not again after an answer that is not an acknowledgement", async () => {
    const { session, taskServer } = await setup(
      10_000,
      TIMING,
      scripted((text) =>
        text === "cancel" ? call(["mcp_task_cancel", { task: "mcp-task-1" }]) : undefined,
      ),
      {
        host: {
          cancelAnswer: async () =>
            McpHostCallFailed.make({ error: ServerError.make({ message: "no", code: -32000 }) }),
        },
      },
    );

    await turn(session, "go");
    await turn(session, "cancel");

    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
    expect((await session.texts("toolResult")).at(-1)).toContain("could not be delivered");
    await session.root.abort(context, { background: true });
  });
});

describe("a task the owner stopped everything for", () => {
  it("is cancelled at the server, ended, and the agent is told in a notice that starts no Run", async () => {
    const { session, taskServer, written, submitted, storage } = await setup(10_000);

    await turn(session, "go");
    await session.root.abort(context, { background: true });
    await session.until(ended(session), "the task to end");

    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
    expect(await recordNow(session, "mcp-task-1")).toMatchObject({
      status: "cancelled",
      end: { status: "cancelled", by: "stop" },
      delivery: "none",
    });
    expect(written).toEqual([
      expect.objectContaining({
        requestId: "mcp-task-notice:mcp-task-1",
        kind: MCP_TASK_NOTICE_KIND,
        text: expect.stringContaining("cancelled by the owner"),
      }),
    ]);
    expect(submitted).toEqual([]);
    expect(await toldOfEnd(session)).toBe(false);
    // The words kept for the agent that asks are cloudpid's: the task was cancelled.
    expect(JSON.stringify(resultPool(storage).get("mcp-task-1", Date.now()))).toContain(
      "was cancelled",
    );
  });

  it("does not send a second `tasks/cancel` for a task whose cancel the agent sent", async () => {
    const { session, taskServer } = await setup(
      10_000,
      { ...TIMING, cancelGraceMs: 60_000 },
      scripted((text) =>
        text === "cancel" ? call(["mcp_task_cancel", { task: "mcp-task-1" }]) : undefined,
      ),
      // The server takes the cancel and goes on working, as one that ignores it does.
      { host: { cancelAnswer: async () => McpHostTaskAck.make({}) } },
    );

    await turn(session, "go");
    await turn(session, "cancel");
    expect((await recordNow(session, "mcp-task-1"))?.cancel).toMatchObject({
      by: "agent",
      sent: "sent",
    });

    await session.root.abort(context, { background: true });
    await session.until(ended(session), "the task to end");

    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
    expect((await recordNow(session, "mcp-task-1"))?.end).toMatchObject({
      status: "cancelled",
      by: "stop",
    });
  });

  it("sends a `tasks/cancel` at Stop all for a `sending` mark another instance left, however fresh", async () => {
    const { session, taskServer } = await setup(10_000, TIMING, scripted());

    await turn(session, "go");
    // The agent's cancel was being sent by an instance a code update replaced: nothing says it went.
    await session.harness.commit(async (tx) => {
      const record = (await tx.doc(McpTasksDoc)).tasks["mcp-task-1"];

      if (record !== undefined) record.cancel = { at: Date.now(), by: "agent", sent: "sending" };
    }, context);

    await session.root.abort(context, { background: true });
    await session.until(ended(session), "the task to end");

    // An orphan is worse than a duplicate: the cancel goes out once by this instance.
    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
    expect((await recordNow(session, "mcp-task-1"))?.end).toMatchObject({
      status: "cancelled",
      by: "stop",
    });
  });

  it("ends the task within two seconds of Stop all though the server never answers the cancel", async () => {
    const { session, taskServer, written } = await setup(10_000, TIMING, scripted(), {
      host: { cancelAnswer: () => new Promise(() => undefined) },
    });

    await turn(session, "go");

    const started = Date.now();

    await session.root.abort(context, { background: true });
    await session.until(ended(session), "the task to end");

    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(Date.now() - started).toBeLessThan(4500);
    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
    expect((await recordNow(session, "mcp-task-1"))?.end).toMatchObject({
      status: "cancelled",
      by: "stop",
    });
    // The agent is told in a notice all the same.
    expect(written).toHaveLength(1);
  });

  it("stops an inline call within two seconds though the server never answers the cancel", async () => {
    const { session, taskServer, client } = await setup(
      10_000,
      { ...TIMING, windowMs: 60_000 },
      scripted(),
      {
        host: { cancelAnswer: () => new Promise(() => undefined) },
      },
    );

    const running = session.root
      .submit({ type: "input", content: "go" }, context)
      .then((submission) => submission.wait(context));

    await vi.waitFor(async () => expect(await recordNow(session, "mcp-task-1")).toBeDefined());

    const started = Date.now();

    await session.root.abort(context);
    await running;
    expect(Date.now() - started).toBeLessThan(4500);

    // The call's invocation ended with the Stop, so the sweep ends the record, and sends no second cancel.
    expect(
      await sweepTasks({ harness: session.harness, client, origin: {}, now: () => 9000 }),
    ).toBe(1);
    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
    expect((await recordNow(session, "mcp-task-1"))?.end).toMatchObject({ by: "stop" });
  });

  it("drops a result held for a busy conversation, and says so in a notice", async () => {
    const busy = gate();

    const { session, written, submitted, storage } = await setup(30, TIMING, (request) =>
      request.text === "slow" ? busy.promise.then(() => answer("slow done")) : scripted()(request),
    );

    await turn(session, "go");

    // A turn that stays busy while the task ends: the result is held for the idle conversation.
    const slow = await session.root.submit({ type: "input", content: "slow" }, context);

    await session.until(ended(session), "the task to end");
    expect(resultPool(storage).get("mcp-task-1", Date.now())).toBeDefined();
    expect((await recordNow(session, "mcp-task-1"))?.delivery).toBe("pending");

    // The model is still answering: it lets go as the Run is aborted.
    const stopping = session.root.abort(context, { background: true });

    busy.resolve();
    await stopping;
    await slow.wait(context).catch(() => undefined);
    await session.until(
      async () => (await recordNow(session, "mcp-task-1"))?.delivery === "none",
      "the result to be dropped",
    );

    expect(resultPool(storage).get("mcp-task-1", Date.now())).toBeUndefined();
    expect(written).toEqual([
      expect.objectContaining({
        requestId: "mcp-task-notice:mcp-task-1",
        text: expect.stringContaining("its result was dropped when the owner stopped everything"),
      }),
    ]);
    expect(submitted).toEqual([]);
    expect(await toldOfEnd(session)).toBe(false);
  });
});

describe("a -32602 from the server", () => {
  const gone = async () =>
    McpHostCallFailed.make({ error: NotFound.make({ message: "gone", code: -32602 }) });

  it("is followed on when the task is known again within the grace", async () => {
    const { session, toolCalls } = await setup(12, { ...TIMING, unknownGraceMs: 500 }, scripted(), {
      host: { getAnswer: (n) => (n >= 3 && n <= 6 ? gone() : undefined) },
    });

    await turn(session, "go");
    await session.until(() => toldOfEnd(session), "the end");
    await session.settle();

    const text = (await session.texts("user")).find((each) => each.startsWith("[MCP task ended"));

    expect(text).toContain("status=completed");
    expect(toolCalls()).toHaveLength(1);
  });

  it("is unknown only once the grace has passed", async () => {
    const seen: number[] = [];

    const { session } = await setup(10_000, { ...TIMING, unknownGraceMs: 150 }, scripted(), {
      host: {
        getAnswer: (n) => {
          if (n < 3) return undefined;

          seen.push(Date.now());

          return gone();
        },
      },
    });

    await turn(session, "go");
    await session.until(ended(session), "the end");

    expect((await recordNow(session, "mcp-task-1"))?.end).toMatchObject({
      status: "unknown",
      by: "cloudpid",
    });
    expect(Date.now() - (seen[0] ?? 0)).toBeGreaterThanOrEqual(150);
    expect(seen.length).toBeGreaterThan(2);
    await session.settle();
  });
});

describe("a host or engine deploy while the Session lives", () => {
  const lost = async () => HostLost.make({ message: "the host went away" });

  it("is retried: the polls that found the host lost are sent again, and nothing else is", async () => {
    const { session, taskServer, toolCalls } = await setup(12, TIMING, scripted(), {
      host: { getAnswer: (n) => (n >= 3 && n <= 7 ? lost() : undefined) },
    });

    await turn(session, "go");
    await session.until(() => toldOfEnd(session), "the end");
    await session.settle();

    // The task was followed to its end through the outage: one `tools/call`, and no cancel.
    expect(toolCalls()).toHaveLength(1);
    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toEqual([]);
    expect((await recordNow(session, "mcp-task-1"))?.end).toMatchObject({ status: "completed" });
  });

  it("is retried inside the window too, and the call returns the task's result", async () => {
    const { session, toolCalls } = await setup(6, { ...TIMING, windowMs: 5000 }, scripted(), {
      host: { getAnswer: (n) => (n >= 2 && n <= 4 ? lost() : undefined) },
    });

    await turn(session, "go");

    expect(await session.texts("toolResult")).toEqual([expect.stringContaining("the report")]);
    expect(toolCalls()).toHaveLength(1);
  });
});

describe("the owner steering a call that waits for its task", () => {
  it("detaches it at once, and the Run goes on", async () => {
    const { session, toolCalls } = await setup(10_000, { ...TIMING, windowMs: 60_000 });

    const first = await session.root.submit({ type: "input", content: "go" }, context);

    await session.until(
      async () => (await recordNow(session, "mcp-task-1")) !== undefined,
      "the task",
    );
    await session.root.submit({ type: "input", content: "hurry", whenBusy: "steer" }, context);
    await first.wait(context);

    expect((await session.texts("toolResult"))[0]).toContain("runs as MCP task mcp-task-1");
    expect(await recordNow(session, "mcp-task-1")).toMatchObject({ background: true });
    expect(toolCalls()).toHaveLength(1);
    await session.root.abort(context, { background: true });
  });
});

describe("mcp_task_wait", () => {
  it("returns where the task stands when its time runs out", async () => {
    const { session } = await setup(
      10_000,
      TIMING,
      scripted((text) =>
        text === "wait" ? call(["mcp_task_wait", { task: "mcp-task-1", timeout_s: 1 }]) : undefined,
      ),
    );

    await turn(session, "go");
    await turn(session, "wait");

    expect((await session.texts("toolResult")).at(-1)).toContain(
      "MCP task mcp-task-1 is still working after 1s",
    );
    await session.root.abort(context, { background: true });
  });

  it("returns where the task stands when the owner sends a message", async () => {
    const { session } = await setup(
      10_000,
      TIMING,
      scripted((text) =>
        text === "wait"
          ? call(["mcp_task_wait", { task: "mcp-task-1", timeout_s: 600 }])
          : undefined,
      ),
    );

    await turn(session, "go");

    const waiting = await session.root.submit({ type: "input", content: "wait" }, context);

    await session.until(
      async () => (await recordNow(session, "mcp-task-1"))?.waiter !== undefined,
      "the wait",
    );
    await session.root.submit({ type: "input", content: "hurry", whenBusy: "steer" }, context);
    await waiting.wait(context);

    expect((await session.texts("toolResult")).at(-1)).toContain("a message arrived");
    expect((await recordNow(session, "mcp-task-1"))?.waiter).toBeUndefined();
    await session.root.abort(context, { background: true });
  });

  it("is one open wait at a time per task: the second is told so", async () => {
    const { session } = await setup(
      10_000,
      TIMING,
      scripted((text) =>
        text === "wait"
          ? call(
              ["mcp_task_wait", { task: "mcp-task-1", timeout_s: 1 }],
              ["mcp_task_wait", { task: "mcp-task-1", timeout_s: 1 }],
            )
          : undefined,
      ),
    );

    await turn(session, "go");
    await turn(session, "wait");

    const results = (await session.texts("toolResult")).slice(-2);

    expect(results.filter((text) => text.includes("Another call is already waiting"))).toHaveLength(
      1,
    );
    expect(results.filter((text) => text.includes("still working after 1s"))).toHaveLength(1);
    await session.root.abort(context, { background: true });
  });
});

describe("which calls are offered a task", () => {
  const OTHER: FakeMcpServer = { ...SERVER, name: "other" };
  const THIRD: FakeMcpServer = { ...SERVER, name: "third" };

  const several = scripted((text) => {
    if (text === "other") return call(["mcp__other__report", {}]);

    return text === "third" ? call(["mcp__third__report", {}]) : undefined;
  });

  it("is offered one in the root conversation, and not once 8 are live on the server or 16 in the Session", async () => {
    const { session, taskServer } = await setup(100_000, TIMING, several, {
      servers: [SERVER, OTHER, THIRD],
    });

    for (let n = 0; n < 8; n += 1) await turn(session, "go");

    // The 9th call to the same server goes out without the declaration.
    await turn(session, "go");

    for (let n = 0; n < 8; n += 1) await turn(session, "other");

    // 16 are live in the Session now: another server's call goes out without it either.
    await turn(session, "third");

    expect(offers(taskServer)).toEqual([
      ...Array.from({ length: 8 }, () => true),
      false,
      ...Array.from({ length: 8 }, () => true),
      false,
    ]);
    await session.root.abort(context, { background: true });
  });
});

describe("a Session a code update replaced", () => {
  const started = McpHostTaskStarted.make({
    task: { ...CREATED, status: "working" },
    conn: "conn-docs",
  });

  const draft = {
    server: "docs",
    tool: "report",
    modelTool: "mcp__docs__report",
    windowMs: 60_000,
  };

  /** A tool API whose storage refuses every write, as a replaced instance's does. */
  const refusing = () => {
    const api = {
      callId: "call-1",
      // SAFETY: the call's task, which the sweep never reads here.
      taskId: 7 as TaskId,
      conversationId: ROOT_CONVERSATION_ID,
      now: () => 5000,
      commit: async () => {
        throw new Error("This Durable Object was replaced");
      },
      memo: async () => "",
      snapshot: async () => undefined,
    };

    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: a partial fake of the tool API: `startTask` reads only these members.
    return api as unknown as ToolExecutionApi;
  };

  /** What `startTask` reads of a call: its API, context, client and origin. */
  const replaced = (client: McpHostClientService): Parameters<typeof startTask>[0] =>
    // SAFETY: `startTask` reads only the call's `api`, `context`, `client` and `origin`.
    ({ api: refusing(), context, client, origin: {} }) as Parameters<typeof startTask>[0];

  it("sends one best-effort `tasks/cancel` for a task it cannot record, and fails the call as before", async () => {
    const host = fakeMcpHost([SERVER]);
    const server = taskHost(10);

    host.answer(server.answerOf);

    const call = replaced(host.client);

    await expect(startTask(call, started, draft)).rejects.toThrow("replaced");

    const cancels = server.sent.filter((input) => input.op === "tasks/cancel");

    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({
      params: { taskId: SECRET, tool: "report", conn: "conn-docs" },
    });
  });

  it("fails the call with the storage's error when the cancel fails too", async () => {
    const host = fakeMcpHost([SERVER]);

    const server = taskHost(10, {
      cancelAnswer: async () =>
        McpHostCallFailed.make({ error: ServerError.make({ message: "down", code: -32000 }) }),
    });

    host.answer(server.answerOf);

    const call = replaced(host.client);

    await expect(startTask(call, started, draft)).rejects.toThrow("replaced");
    expect(server.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
  });
});

describe("the sweep at a wake", () => {
  /** Add the records of a call to the Session's document, as a call that was cut off left them. */
  const leave = async (
    session: Awaited<ReturnType<typeof setup>>["session"],
    more: ReadonlyArray<{
      readonly background?: boolean;
      readonly ended?: boolean;
      /** A record from before the call's task was kept. */
      readonly anonymous?: boolean;
    }>,
  ) => {
    await session.harness.commit(async (tx) => {
      const doc = await tx.doc(McpTasksDoc);

      for (const [index, each] of more.entries()) {
        const record = addTask(doc, {
          taskId: `${SECRET}-${index}`,
          server: "docs",
          tool: "report",
          modelTool: "mcp__docs__report",
          conn: "conn-docs",
          transport: "http",
          conversation: ROOT_CONVERSATION_ID,
          agent: "root",
          callId: `call-${index}`,
          // SAFETY: a task that is not live: the call that held it is gone.
          callTask: (900 + index) as TaskId,
          windowMs: 60_000,
          createdAt: 1000,
          ttlMs: null,
          status: "working",
        });

        const stored = doc.tasks[record.handle];

        if (stored === undefined) continue;

        stored.background = each.background === true;

        if (each.anonymous === true) delete stored.callTask;

        if (each.ended === true) {
          stored.end = { status: "completed", by: "server", at: 2000 };
          stored.status = "completed";
        }
      }
    }, context);
  };

  it("cancels an inline task whose call is gone and ends its record, once, leaving the others", async () => {
    const { session, taskServer, client } = await setup(1000);

    await leave(session, [{}, { background: true }, { ended: true }]);

    expect(
      await sweepTasks({ harness: session.harness, client, origin: {}, now: () => 9000 }),
    ).toBe(1);

    const doc = await session.harness.snapshot(McpTasksDoc, context);

    expect(doc?.tasks["mcp-task-1"]).toMatchObject({
      status: "cancelled",
      end: { status: "cancelled", by: "stop" },
      delivery: "none",
    });
    expect(doc?.tasks["mcp-task-2"]?.end).toBeUndefined();
    expect(doc?.tasks["mcp-task-3"]?.end?.status).toBe("completed");

    const cancels = taskServer.sent.filter((input) => input.op === "tasks/cancel");

    expect(cancels).toHaveLength(1);
    expect(cancels[0]).toMatchObject({ params: { taskId: `${SECRET}-0` } });

    // A second sweep finds nothing to do.
    expect(
      await sweepTasks({ harness: session.harness, client, origin: {}, now: () => 9000 }),
    ).toBe(0);
    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
  });

  it("sends the cancels of several orphans together, so a server that never answers holds it for 2 s, not 2 s each", async () => {
    const { session, taskServer, client } = await setup(1000, TIMING, scripted(), {
      host: { cancelAnswer: () => new Promise(() => undefined) },
    });

    await leave(session, [{}, {}, {}]);

    const started = Date.now();

    expect(
      await sweepTasks({ harness: session.harness, client, origin: {}, now: () => 9000 }),
    ).toBe(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    expect(Date.now() - started).toBeLessThan(3500);
    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(3);
  });

  it("leaves an inline task whose call is still live", async () => {
    const { session, taskServer, client } = await setup(1000, { ...TIMING, windowMs: 5000 });

    const running = session.root
      .submit({ type: "input", content: "go" }, context)
      .then((submission) => submission.wait(context));

    await vi.waitFor(async () => expect(await recordNow(session, "mcp-task-1")).toBeDefined());

    expect(
      await sweepTasks({ harness: session.harness, client, origin: {}, now: () => 9000 }),
    ).toBe(0);
    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(0);
    expect((await recordNow(session, "mcp-task-1"))?.end).toBeUndefined();

    await session.root.abort(context);
    await running;
  });

  it("leaves a record from before the call's task was kept, which it cannot tell from a live call's", async () => {
    const { session, taskServer, client } = await setup(1000);

    await leave(session, [{ anonymous: true }]);

    expect(
      await sweepTasks({ harness: session.harness, client, origin: {}, now: () => 9000 }),
    ).toBe(0);
    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(0);
    expect((await recordNow(session, "mcp-task-1"))?.end).toBeUndefined();
  });

  it("ends the record even when the server cannot be asked", async () => {
    const { session, client } = await setup(1000, TIMING, scripted(), {
      host: {
        cancelAnswer: async () =>
          McpHostCallFailed.make({ error: ServerError.make({ message: "down", code: -32000 }) }),
      },
    });

    await leave(session, [{}]);
    expect(
      await sweepTasks({ harness: session.harness, client, origin: {}, now: () => 9000 }),
    ).toBe(1);
    expect(
      (await session.harness.snapshot(McpTasksDoc, context))?.tasks["mcp-task-1"]?.end,
    ).toMatchObject({
      status: "cancelled",
      by: "stop",
    });
  });
});
