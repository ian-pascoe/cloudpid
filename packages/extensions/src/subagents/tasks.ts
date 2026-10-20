// The durable tasks under the subagent tools, after pi-durable's example 23 (`test/examples/23-subagent-background.ts`).
// pi-durable's task phases stay native Promise code (ADR-0003), so this file is too.
//
// - An anchor owns each child's conversation. It is a background task of the parent's conversation that finishes at
//   once, so the parent's abort (Esc) and idle waits never reach the child, but the child's work keeps it completing.
// - A reporter carries one turn: it submits an input to a child, waits for the answer, and then either hands the result
//   to a `subagent_wait` blocked on that turn or reports it to the parent once the parent is idle; until then a
//   `subagent_wait` may still claim it. Request IDs keep a restart from submitting or reporting twice.
// - A wait task is what `subagent_wait` blocks on. It ends when a commit gives its waiter a result, when a steer is
//   queued for the caller, or at its deadline, which it sleeps until.
// @effect-diagnostics asyncFunction:off newPromise:off preferEffectArray:off missingPipeableSignature:off
import type { Draft } from "@earendil-works/chord";
import { type Context, withAbortSignal } from "@earendil-works/chord/context";
import {
  type ConversationId,
  defineTask,
  InboxDoc,
  LiveDoc,
  type NextTaskState,
  ROOT_CONVERSATION_ID,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Option from "effect/Option";
import { ROOT_AGENT } from "./ids.ts";
import {
  addTurn,
  answerText,
  conversationOf,
  EMPTY_STATE,
  type SubagentsState,
  SubagentsDoc,
  type TurnStatus,
  type WaitEvent,
  waitEvent,
} from "./state.ts";

/** The entry kind of an input a child or a parent receives from another agent; its model message is the input. */
export const AGENT_INPUT_KIND = "cloudpid.agent-input";

const completed = <S, R>(result: R): NextTaskState<S, R> => ({
  status: "terminal",
  outcome: { status: "completed", result },
});

const aborted = <S, R>(): NextTaskState<S, R> => ({
  status: "terminal",
  outcome: { status: "aborted" },
});

/** Owns one child's conversation; finishes at once. */
export const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "cloudpid.subagent-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_anchor, runtime, context) => runtime.commit(() => completed(null), context),
  },
  abort: (_anchor, runtime, context) => runtime.commit(() => aborted(), context),
});

/** One input to an agent, and who it is from. */
export type ReporterInput = {
  agentId: string;
  turnId: string;
  content: string;
  /** While the agent is busy: join its run (`steer`), or wait for its answer (`followUp`). */
  whenBusy: "steer" | "followUp";
  /** The agent the input is from. */
  from: string;
};

type ReporterState =
  | { phase: "deliver" }
  /** Hold `report` until the parent is idle; `round` counts the times it was found busy again. */
  | { phase: "report"; parent: string; report: string | null; round: number }
  | { phase: "post"; report: string };

/** The model-visible header of a message from another agent, as pi-minimal-subagents frames it. */
export const envelope = (
  kind: "result" | "message",
  agentId: string,
  turnId: string,
  status?: string,
): string =>
  `[Subagent ${kind} | agent=${agentId} | turn=${turnId}${status === undefined ? "" : ` | status=${status}`}]`;

/**
 * Start turn `input` on agent `agentId`: a reporter task in the conversation of the agent's parent, which receives the
 * result. Returns the turn's ID, or `undefined` when the agent is gone.
 */
export const startTurn = async (
  tx: Tx,
  state: Draft<SubagentsState>,
  input: Omit<ReporterInput, "turnId">,
  now: number,
): Promise<string | undefined> => {
  const agent = state.agents[input.agentId];
  const owner = agent === undefined ? undefined : conversationOf(state, agent.parent);

  if (agent === undefined || owner === undefined) return undefined;

  const turnId = `turn-${agent.nextTurn}`;

  agent.nextTurn += 1;

  const reporter = await tx.createTask(
    Reporter,
    { ...input, turnId },
    { ownership: { kind: "conversation" }, conversationId: owner, background: true },
  );

  addTurn(agent, {
    id: turnId,
    reporter,
    status: "running",
    startedAt: now,
    endedAt: null,
    answer: null,
    error: null,
    delivery: null,
  });

  return turnId;
};

/** Delivers one turn's input to an agent and its result to the agent's parent. */
export const Reporter = defineTask<ReporterInput, ReporterState, null>({
  name: "cloudpid.subagent-reporter",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (reporter, runtime, context) => {
      const { agentId, turnId, content, whenBusy, from } = reporter.input;
      const state = (await runtime.snapshot(SubagentsDoc, context)) ?? EMPTY_STATE;
      const agent = state.agents[agentId];

      const conversation =
        agent === undefined ? undefined : await runtime.conversation(agent.conversationId, context);

      // Deleted before its input was delivered.
      if (conversation === undefined) {
        await runtime.commit(() => completed(null), context);

        return;
      }

      const submission = await conversation.submit(
        {
          type: "input",
          content,
          whenBusy,
          requestId: `subagent-turn:${reporter.id}`,
          entry: { kind: AGENT_INPUT_KIND, data: { from, agent_id: agentId, turn_id: turnId } },
        },
        context,
      );

      const settled = await submission.wait(context);

      // One commit settles the turn and decides its delivery, so a restart never decides again.
      await runtime.commit(async (tx) => {
        // Table reads come before the commit's writes.
        const answer =
          settled.status === "done" && settled.type === "input" ? settled.answer : null;

        const text = answer === null ? "" : await answerText(tx, answer);
        const doc = await tx.doc(SubagentsDoc);
        const record = doc.agents[agentId];

        const settledTurn =
          record === undefined
            ? undefined
            : Option.getOrUndefined(Arr.findFirst(record.turns, (each) => each.id === turnId));

        if (record === undefined || settledTurn === undefined) return completed(null);

        const status: TurnStatus =
          answer !== null ? "completed" : settled.reason === "aborted" ? "aborted" : "failed";

        const error = status === "failed" ? (settled.reason ?? "failed") : null;
        const now = runtime.now();

        settledTurn.status = status;
        settledTurn.answer = answer;
        settledTurn.error = error;
        settledTurn.endedAt = now;

        const next = (report: string | null): NextTaskState<ReporterState, null> => ({
          status: "running",
          checkpoint: { phase: "report", parent: record.parent, report, round: 0 },
        });

        // A wait blocked on this turn claims its result.
        const waiting = Option.getOrUndefined(
          Arr.findFirst(
            Record.values(doc.waiters),
            (waiter) =>
              waiter.caller === record.parent &&
              waiter.target === agentId &&
              waiter.turnId === turnId &&
              waiter.result === null,
          ),
        );

        if (waiting !== undefined) {
          waiting.result = waitEvent("turn", agentId, {
            turn_id: turnId,
            status,
            output: text,
            error,
            elapsed_ms: now - waiting.startedAt,
          });
          settledTurn.delivery = "wait";

          return next(null);
        }

        // Several inputs steered into one run end in one answer, which is reported once.
        const duplicate =
          answer !== null &&
          Arr.some(record.turns, (each) => each.id !== turnId && each.answer === answer);

        if (duplicate) {
          settledTurn.delivery = "duplicate";

          return next(null);
        }

        // Stopped, or withdrawn while queued: nothing to report.
        if (status === "aborted") {
          settledTurn.delivery = "none";

          return next(null);
        }

        // Reported once the parent is idle; a wait may claim it until then.
        settledTurn.delivery = "pending";

        return next(
          `${envelope("result", agentId, turnId, status)}\n${status === "completed" ? text : `The turn failed: ${error ?? "unknown error"}`}`,
        );
      }, context);
    },
    // Hold the report while the parent is busy, so a `subagent_wait` in its run can still claim the result instead
    // of being told it was delivered while it sits queued. Once the parent is idle, report it: as an input to the
    // root (`post`), or as a new turn of a parent that is itself a subagent, so that turn's answer is reported further
    // up.
    report: async (reporter, runtime, context) => {
      const { parent, report, round } = reporter.state.checkpoint;
      const { agentId, turnId } = reporter.input;

      if (report === null) {
        await runtime.commit(() => completed(null), context);

        return;
      }

      const owner = conversationOf(
        (await runtime.snapshot(SubagentsDoc, context)) ?? EMPTY_STATE,
        parent,
      );

      if (owner !== undefined) await whenIdle(runtime, owner, context);

      await runtime.commit(async (tx): Promise<NextTaskState<ReporterState, null>> => {
        const doc = await tx.doc(SubagentsDoc);

        const turn = Option.getOrUndefined(
          Arr.findFirst(doc.agents[agentId]?.turns ?? [], (each) => each.id === turnId),
        );

        // Claimed by a wait meanwhile, or deleted.
        if (turn?.delivery !== "pending") return completed(null);

        const conversation = conversationOf(doc, parent);

        if (conversation === undefined) {
          turn.delivery = "none";

          return completed(null);
        }

        if ((await tx.doc(LiveDoc, conversation)).run !== undefined) {
          return {
            status: "running",
            checkpoint: { phase: "report", parent, report, round: round + 1 },
          };
        }

        turn.delivery = "auto";

        if (parent === ROOT_AGENT) {
          return { status: "running", checkpoint: { phase: "post", report } };
        }

        await startTurn(
          tx,
          doc,
          { agentId: parent, content: report, whenBusy: "followUp", from: agentId },
          runtime.now(),
        );

        return completed(null);
      }, context);
    },
    // The root has no reporter of its own: the report is submitted to it, once, by its request ID.
    post: async (reporter, runtime, context) => {
      const { report } = reporter.state.checkpoint;
      const { agentId, turnId } = reporter.input;
      const root = await runtime.conversation(ROOT_CONVERSATION_ID, context);

      await root?.submit(
        {
          type: "input",
          content: report,
          whenBusy: "followUp",
          requestId: `subagent-report:${reporter.id}`,
          entry: {
            kind: AGENT_INPUT_KIND,
            data: { from: agentId, agent_id: agentId, turn_id: turnId },
          },
        },
        context,
      );

      await runtime.commit(() => completed(null), context);
    },
  },
  // Aborted with its conversation's background work, as when its parent is deleted: the turn ends unreported.
  abort: (reporter, runtime, context) =>
    runtime.commit(async (tx) => {
      const doc = await tx.doc(SubagentsDoc);

      const turn = Option.getOrUndefined(
        Arr.findFirst(
          doc.agents[reporter.input.agentId]?.turns ?? [],
          (each) => each.id === reporter.input.turnId,
        ),
      );

      if (turn?.status === "running") {
        turn.status = "aborted";
        turn.delivery = "none";
        turn.endedAt = runtime.now();
      }

      return aborted();
    }, context),
});

/** What a wait task blocks on. */
export type WaitInput = {
  caller: string;
  callerConversation: ConversationId;
  target: string;
  turnId: string;
  startedAt: number;
  /** When it ends with `timeout`; `null` waits until something happens. */
  deadline: number | null;
};

type WaitRuntime = TaskRuntime<WaitInput, { phase: "wait" }, WaitEvent, object>;

/** Whether a steer is queued for a conversation: the caller's own turn has input to take. */
const steerQueued = (
  inbox: { readonly items: ReadonlyArray<{ readonly mode: string }> } | null | undefined,
) => Arr.some(inbox?.items ?? [], (item) => item.mode === "steer");

/** End the wait with its result, or with what ended it early, and remove its waiter. */
const endWait = async (tx: Tx, key: string, input: WaitInput, now: number) => {
  const doc = await tx.doc(SubagentsDoc);
  const waiter = doc.waiters[key];
  const elapsed = now - input.startedAt;

  delete doc.waiters[key];

  if (waiter?.result != null)
    return completed<{ phase: "wait" }, WaitEvent>({ ...waiter.result, elapsed_ms: elapsed });

  const target = doc.agents[input.target];

  if (waiter === undefined || target === undefined) {
    return completed<{ phase: "wait" }, WaitEvent>(
      waitEvent("turn", input.target, {
        turn_id: input.turnId,
        status: "deleted",
        elapsed_ms: elapsed,
      }),
    );
  }

  const busy = (await tx.doc(LiveDoc, target.conversationId)).run !== undefined;
  const steered = steerQueued(await tx.doc(InboxDoc, input.callerConversation));

  return completed<{ phase: "wait" }, WaitEvent>(
    waitEvent(steered ? "steered" : "timeout", input.target, {
      turn_id: input.turnId,
      status: busy ? "running" : "idle",
      elapsed_ms: elapsed,
    }),
  );
};

/** What a task needs of its runtime to block on changes. */
type Watcher = Pick<WaitRuntime, "signal" | "sleep">;

/** Rejects with the reason when `runtime`'s invocation is signalled; its listener goes when `until` aborts. */
const signalled = (runtime: Watcher, until: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    const reject_ = () => reject(runtime.signal.reason);

    if (runtime.signal.aborted) reject_();
    else runtime.signal.addEventListener("abort", reject_, { once: true, signal: until });
  });

/** Block until the Subagents document or the caller's inbox changes, or `deadline`. */
const nextChange = async (
  runtime: Watcher,
  watches: ReadonlyArray<{ start(listener: () => Promise<void>): void } | undefined>,
  deadline: number | null,
  context: Context,
) => {
  const controller = new AbortController();

  const changed = new Promise<void>((resolve) => {
    for (const watch of watches) {
      watch?.start(() => {
        resolve();

        return Promise.resolve();
      });
    }
  });

  try {
    await Promise.race([
      changed,
      signalled(runtime, controller.signal),
      ...(deadline === null
        ? []
        : [runtime.sleep(deadline, withAbortSignal(controller.signal, context))]),
    ]);
  } finally {
    controller.abort();
  }
};

/** Block until conversation `id` has no run in progress. */
const whenIdle = async (
  runtime: Watcher & Pick<WaitRuntime, "watchDoc">,
  id: ConversationId,
  context: Context,
) => {
  for (;;) {
    const live = await runtime.watchDoc(LiveDoc, id, context);

    try {
      if (live?.value?.run === undefined) return;

      await nextChange(runtime, [live], null, context);
    } finally {
      await live?.stop();
    }
  }
};

/** What `subagent_wait` blocks on; its result is the wait's event. */
export const WaitTask = defineTask<WaitInput, { phase: "wait" }, WaitEvent>({
  name: "cloudpid.subagent-wait",
  version: 1,
  initial: () => ({ phase: "wait" }),
  phases: {
    wait: async (task, runtime, context) => {
      const key = String(task.id);
      const { deadline, callerConversation } = task.input;

      for (;;) {
        const doc = await runtime.watchDoc(SubagentsDoc, context);
        const inbox = await runtime.watchDoc(InboxDoc, callerConversation, context);

        try {
          const waiter = (doc?.value ?? EMPTY_STATE).waiters[key];

          const done =
            waiter === undefined ||
            waiter.result !== null ||
            steerQueued(inbox?.value) ||
            (deadline !== null && runtime.now() >= deadline);

          if (done) {
            await runtime.commit((tx) => endWait(tx, key, task.input, runtime.now()), context);

            return;
          }

          await nextChange(runtime, [doc, inbox], deadline, context);
        } finally {
          await doc?.stop();
          await inbox?.stop();
        }
      }
    },
  },
  abort: (task, runtime, context) =>
    runtime.commit(async (tx) => {
      const doc = await tx.doc(SubagentsDoc);

      delete doc.waiters[String(task.id)];

      return aborted();
    }, context),
});
