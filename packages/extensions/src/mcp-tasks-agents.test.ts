// An MCP task a subagent's call or a `codemode` script's nested call started (`docs/architecture/mcp-server-requests.md` →
// MCP tasks, Delivery, The inline window): both are offered a task; a subagent's end reaches it as a turn of its own
// (`from: "mcp-task-<n>"`), answered to its parent; a script's call that outlasts its window gets an error value that names
// the handle (`mcp_task_background`) and the follower delivers to the script's conversation; Stop, Stop all and a deleted
// subagent end them as they end a root call's. A scripted model on a Harness over an in-memory host.
// pi-durable's Harness is Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off preferEffectArray:off newPromise:off globalTimers:off globalDate:off
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { MCP_TASK_NOTICE_KIND } from "./mcp.ts";
import type { FakeMcpServer } from "./mcp.testing.ts";
import {
  ended,
  offers,
  recordNow,
  scripted,
  SERVER,
  setup,
  TIMING,
  toldOfEnd,
  turn,
} from "./mcp-tasks.fixture.ts";
import { AGENT_INPUT_KIND } from "./subagents.ts";
import { sweepTasks } from "./mcp/task-sweep.ts";
import { stopConversation } from "./subagents/owner.ts";
import { SubagentsDoc } from "./subagents/state.ts";
import { answer, call, context } from "./subagents/harness.fixture.ts";

type Opened = Awaited<ReturnType<typeof setup>>;

/** A root that spawns `worker` on "go", deletes it on "delete", and a worker that calls the tool and answers what it is told. */
const script: Parameters<typeof setup>[2] = (request) => {
  if (request.agent === "root") {
    if (request.text === "go") return call(["subagent", { task: "Report", agent_id: "worker" }]);

    if (request.text === "delete") return call(["subagent_delete", { agent_id: "worker" }]);

    return answer("root noted");
  }

  if (request.text.startsWith("[MCP task ended")) return answer("worker noted the end");

  if (request.text.includes("runs as MCP task")) return answer("worker waits");

  return call(["mcp__docs__report", {}]);
};

const SUBAGENTS = { offered: ["subagent*", "read"] };

/** The conversation of the subagent `worker`. */
const workerOf = async (session: Opened["session"]) => {
  const state = await session.harness.snapshot(SubagentsDoc, context);
  const conversation = state?.agents["worker"]?.conversationId;

  if (conversation === undefined) throw new Error("worker has no conversation");

  return conversation;
};

/** Spawn `worker`, and wait until its call has detached an MCP task. */
const spawned = async (opened: Opened) => {
  await turn(opened.session, "go");
  await opened.session.until(
    async () => (await recordNow(opened.session, "mcp-task-1"))?.background === true,
    "the worker's task to detach",
  );
};

describe("a subagent's MCP task", () => {
  it("is offered a task, and its end is a turn of the agent, from the task, answered to its parent", async () => {
    const opened = await setup(30, TIMING, script, SUBAGENTS);
    const { session, toolCalls, taskServer, submitted } = opened;

    await turn(session, "go");
    await session.until(async () => await toldOfEndInWorker(opened), "the worker to be told");
    await session.settle();

    expect(offers(taskServer)).toEqual([true]);
    expect(toolCalls()).toHaveLength(1);

    const record = await recordNow(session, "mcp-task-1");

    expect(record).toMatchObject({ agent: "worker", background: true, delivery: "auto" });
    expect(record?.toldAt).toBeTypeOf("number");
    expect(record?.end?.status).toBe("completed");

    // The turn is the worker's own, from the task; it is answered to its parent, the root.
    const worker = await session.entries(await workerOf(session));

    const input = worker.find(
      (entry) => entry.kind === AGENT_INPUT_KIND && JSON.stringify(entry).includes("mcp-task-1"),
    );

    expect(JSON.stringify(input)).toContain('"from":"mcp-task-1"');
    expect(JSON.stringify(worker)).toContain("worker noted the end");

    const reports = (await session.texts("user")).filter((text) =>
      text.startsWith("[Subagent result | agent=worker"),
    );

    expect(reports.at(-1)).toContain("worker noted the end");

    // The root's Run notifications are for the root's own, and a subagent's delivery starts none (left for later).
    expect(submitted).toEqual([]);
    expect(await toldOfEnd(session)).toBe(false);
  });

  it("is never delivered to an agent that was deleted, whose follower is cancelled with it", async () => {
    const opened = await setup(10_000, TIMING, script, SUBAGENTS);
    const { session, taskServer, written } = opened;

    await spawned(opened);
    await turn(session, "delete");
    await session.until(ended(session), "the task to end");

    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
    expect(await recordNow(session, "mcp-task-1")).toMatchObject({
      status: "cancelled",
      end: { status: "cancelled", by: "stop" },
      delivery: "none",
    });
    expect(written.map((note) => note.kind)).toEqual([MCP_TASK_NOTICE_KIND]);
    expect(await toldInWorkerSoFar(session)).toBe(false);
  });

  it("is not delivered to a new agent that took the deleted agent's ID (ADR-0040), though the task ended", async () => {
    const opened = await setup(60, TIMING, script, SUBAGENTS);
    const { session } = opened;

    await spawned(opened);

    // The agent was deleted and its ID taken by another, whose conversation is not the one that started the task.
    await session.harness.commit(async (tx) => {
      const doc = await tx.doc(SubagentsDoc);
      const worker = doc.agents["worker"];

      // SAFETY: a conversation ID no conversation has, as another agent's would be.
      // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion
      if (worker !== undefined) worker.conversationId = 9_999 as typeof worker.conversationId;
    }, context);
    await session.until(ended(session), "the task to end");
    await session.settle();

    expect(await recordNow(session, "mcp-task-1")).toMatchObject({
      status: "completed",
      agent: "worker",
    });
    // Nobody was told, so the record does not say they were.
    expect((await recordNow(session, "mcp-task-1"))?.toldAt).toBeUndefined();
    // Nobody was told: the post phase finds the ID is not the agent that started it and ends without a turn (the
    // agent's record holds only the turn that spawned it).
    expect(
      (await session.harness.snapshot(SubagentsDoc, context))?.agents["worker"]?.turns,
    ).toHaveLength(1);
    expect(session.requests.some((request) => request.text.startsWith("[MCP task ended"))).toBe(
      false,
    );
    expect(
      (await session.texts("user")).some((text) => text.includes("worker noted the end")),
    ).toBe(false);
  });

  it("is cancelled by the stop of the active branch and its subagents that Archive and Delete run", async () => {
    const opened = await setup(10_000, TIMING, script, SUBAGENTS);
    const { session, taskServer, written, submitted } = opened;

    await spawned(opened);

    // What `stopEverything` (Archive and Delete) runs for the active branch: `stopConversation` with its subagents. The
    // other branches it stops beside it are plain background aborts, which the root test above covers.
    await stopConversation(
      session.harness,
      ROOT_CONVERSATION_ID,
      { subagents: true },
      context,
      async () => undefined,
    );
    await session.until(ended(session), "the task to end");

    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
    expect(await recordNow(session, "mcp-task-1")).toMatchObject({
      agent: "worker",
      end: { status: "cancelled", by: "stop" },
      delivery: "none",
    });
    expect(written.map((note) => note.kind)).toEqual([MCP_TASK_NOTICE_KIND]);
    expect(submitted).toEqual([]);
    expect(await toldInWorkerSoFar(session)).toBe(false);
  });

  it("is cancelled by Stop all, within the bound, with a notice and no turn", async () => {
    const opened = await setup(10_000, TIMING, script, SUBAGENTS);
    const { session, taskServer, written, submitted } = opened;

    await spawned(opened);
    await stopConversation(
      session.harness,
      ROOT_CONVERSATION_ID,
      { subagents: true },
      context,
      async () => undefined,
    );
    await session.until(ended(session), "the task to end");

    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
    expect(await recordNow(session, "mcp-task-1")).toMatchObject({
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
    expect(await toldInWorkerSoFar(session)).toBe(false);
  });

  it("is stopped with its call: Stop of the worker cancels an inline task", async () => {
    const opened = await setup(10_000, { ...TIMING, windowMs: 5000 }, script, SUBAGENTS);
    const { session, taskServer, client } = opened;

    const running = session.root
      .submit({ type: "input", content: "go" }, context)
      .then((submission) => submission.wait(context));

    await session.until(
      async () => (await recordNow(session, "mcp-task-1")) !== undefined,
      "the task to start",
    );

    const conversation = await workerOf(session);

    await (await session.harness.conversation(conversation, context))?.abort(context);
    await running;
    await sweepTasks({ harness: session.harness, client, origin: {}, now: () => Date.now() });

    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
    expect(await recordNow(session, "mcp-task-1")).toMatchObject({
      agent: "worker",
      end: { status: "cancelled", by: "stop" },
    });
  });
});

/** Whether an entry of the worker's conversation told it a task ended. */
const toldInWorkerSoFar = async (session: Opened["session"]) =>
  session.requests.some(
    (request) => request.agent === "worker" && request.text.startsWith("[MCP task ended"),
  );

const toldOfEndInWorker = async (opened: Opened) => toldInWorkerSoFar(opened.session);

const CODEMODE: FakeMcpServer = { ...SERVER, exposure: "codemode" };

const inScript = (code: string) =>
  scripted((text) => (text === "go" ? call(["codemode", { code }]) : undefined));

const CODE = "console.log(JSON.stringify(await tools.mcp__docs__report({})))";

describe("an MCP task a codemode script's call started", () => {
  const scriptServer = { servers: [CODEMODE], offered: ["codemode"] };

  it("is offered a task, and a call that ends inside the window gives the script its value whole", async () => {
    const { session, taskServer } = await setup(
      3,
      { ...TIMING, windowMs: 5000 },
      inScript("const r = await tools.mcp__docs__report({}); console.log(r.content[0].text)"),
      scriptServer,
    );

    await turn(session, "go");

    expect(offers(taskServer)).toEqual([true]);
    expect(await session.texts("toolResult")).toEqual([expect.stringContaining("the report")]);
    expect(await recordNow(session, "mcp-task-1")).toMatchObject({
      nested: true,
      end: { status: "completed" },
    });
  });

  it("gives the script an error value that names the handle at the window's end, and the end is delivered to the conversation", async () => {
    const { session, taskServer, toolCalls, submitted } = await setup(
      30,
      TIMING,
      inScript(CODE),
      scriptServer,
    );

    await turn(session, "go");

    // The script's call resolved, as an MCP tool's `isError` result does, with the handle in its text.
    const [first] = await session.texts("toolResult");

    expect(first).toContain("mcp-task-1");
    expect(first).toContain('"isError":true');
    expect(first).toContain("returns without its result");
    expect(await recordNow(session, "mcp-task-1")).toMatchObject({
      nested: true,
      background: true,
      agent: "root",
    });

    await session.until(async () => await toldOfEnd(session), "the end to be delivered");
    await session.settle();

    expect(toolCalls()).toHaveLength(1);
    expect(taskServer.gets()).toBe(30);
    expect(submitted).toHaveLength(1);
    expect(await session.texts("assistant")).toContain("noted the end");
  });

  it("is cancelled when Stop ends the script's call", async () => {
    const { session, taskServer, client } = await setup(
      10_000,
      { ...TIMING, windowMs: 5000 },
      inScript(CODE),
      scriptServer,
    );

    const running = session.root
      .submit({ type: "input", content: "go" }, context)
      .then((submission) => submission.wait(context));

    await session.until(
      async () => (await recordNow(session, "mcp-task-1")) !== undefined,
      "the task to start",
    );
    await session.root.abort(context);
    await running;

    // The call's invocation may end with the Stop before it writes the end: the sweep ends the record, sending no second cancel.
    await sweepTasks({ harness: session.harness, client, origin: {}, now: () => Date.now() });

    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
    expect(await recordNow(session, "mcp-task-1")).toMatchObject({
      nested: true,
      end: { status: "cancelled", by: "stop" },
    });
  });

  it("is cancelled by Stop all once it went on in the background", async () => {
    const { session, taskServer, written } = await setup(
      10_000,
      TIMING,
      inScript(CODE),
      scriptServer,
    );

    await turn(session, "go");
    await session.root.abort(context, { background: true });
    await session.until(ended(session), "the task to end");

    expect(taskServer.sent.filter((input) => input.op === "tasks/cancel")).toHaveLength(1);
    expect(written).toEqual([expect.objectContaining({ kind: MCP_TASK_NOTICE_KIND })]);
  });
});
