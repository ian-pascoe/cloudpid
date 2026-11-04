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
  McpHostCompleted,
  McpHostTaskAck,
  McpHostTaskStarted,
  McpHostTaskState,
  type McpHostRequestInput,
  type McpTaskSnapshot,
  NotFound,
} from "@cloudpid/mcp/types";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import * as Record from "effect/Record";
import { describe, expect, it } from "vitest";
import { open } from "./mcp.fixture.ts";
import {
  makeMcpTools,
  memoryMcpToolsStore,
  MCP_TASK_ENDED_KIND,
  MCP_TASK_NOTICE_KIND,
} from "./mcp.ts";
import { type FakeMcpAnswer, type FakeMcpServer, fakeMcpHost } from "./mcp.testing.ts";
import { recordOfCall, startTask } from "./mcp/task-inline.ts";
import { McpTasksDoc, type McpTasksState } from "./mcp/task-state.ts";
import { answer, call, context } from "./subagents/harness.fixture.ts";

const SECRET = "srv-secret-7";

const SERVER: FakeMcpServer = {
  name: "docs",
  exposure: "direct",
  tools: [{ name: "report", description: "Make a report" }],
};

const CREATED = {
  taskId: SECRET,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUpdatedAt: "2026-01-01T00:00:00.000Z",
  ttlMs: 60_000,
};

type Sent = McpHostRequestInput;

/** A task the host's server runs: it ends once it was polled `polls` times, unless it was cancelled. */
const taskHost = (polls: number) => {
  const sent: Sent[] = [];
  let gets = 0;
  let cancelled = false;

  const snapshot = (status: McpTaskSnapshot["status"]): McpTaskSnapshot =>
    // SAFETY: only the statuses that carry no more than the common fields are made here.
    ({ ...CREATED, status, statusMessage: "Making the report" }) as McpTaskSnapshot;

  const answerOf: FakeMcpAnswer = async (input) => {
    sent.push(input);

    switch (input.op) {
      case "tools/call":
        return McpHostTaskStarted.make({ task: snapshot("working"), conn: "conn-docs" });
      case "tasks/get": {
        gets += 1;

        if (cancelled) return McpHostTaskState.make({ task: snapshot("cancelled") });

        return gets >= polls
          ? McpHostTaskState.make({
              task: snapshot("completed"),
              result: {
                kind: "inline",
                value: { content: [{ type: "text", text: "the report" }] },
              },
            })
          : McpHostTaskState.make({ task: snapshot("working") });
      }

      case "tasks/cancel":
        cancelled = true;

        return McpHostTaskAck.make({});
      default:
        return McpHostCompleted.make({
          result: { kind: "inline", value: { content: [{ type: "text", text: "other" }] } },
        });
    }
  };

  return { answerOf, sent, gets: () => gets };
};

/** The pool's storage, and what a Session would give the tools. */
const memory = () => {
  const map = new Map<string, unknown>();

  return {
    map,
    // SAFETY: the pool reads back only what it wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => {
      map.set(key, value);
    },
    delete: (key: string) => map.delete(key),
  };
};

const TIMING = { windowMs: 40, pollMs: 4, graceMs: 20, backoffMs: 5, cancelGraceMs: 40 };

/** A script: "go" calls the tool; an ended entry is answered in words; `extra` answers the rest it knows. */
const scripted =
  (extra: (text: string) => ReturnType<typeof call> | undefined = () => undefined) =>
  (request: { readonly text: string }) => {
    const { text } = request;
    const more = extra(text);

    if (more !== undefined) return more;

    if (text === "go") return call(["mcp__docs__report", {}]);

    return answer(text.startsWith("[MCP task ended") ? "noted the end" : "ok");
  };

const setup = async (polls: number, timing = TIMING, script = scripted()) => {
  const host = fakeMcpHost([SERVER]);
  const taskServer = taskHost(polls);
  const storage = memory();
  const submitted: unknown[] = [];
  const written: Array<{ readonly requestId: string; readonly kind: string }> = [];

  host.answer(taskServer.answerOf);

  const tools = makeMcpTools(host.client, memoryMcpToolsStore(), {
    slackMs: 0,
    tasks: {
      storage,
      timing,
      submitted: (id) => {
        submitted.push(id);
      },
      write: async (_conversation, note) => {
        written.push({ requestId: note.requestId, kind: note.entry.kind });
      },
    },
  });

  const session = await open(script);

  await session.start(tools);

  const toolCalls = () => taskServer.sent.filter((input) => input.op === "tools/call");
  const everything = async () => JSON.stringify(await session.entries());

  return { session, taskServer, storage, submitted, written, toolCalls, everything };
};

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
      { requestId: "mcp-task-notice:mcp-task-1", kind: MCP_TASK_NOTICE_KIND },
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
