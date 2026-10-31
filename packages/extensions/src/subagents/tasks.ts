// The durable tasks under the subagent tools, after pi-durable's example 23 (`test/examples/23-subagent-background.ts`).
// pi-durable's task phases stay native Promise code (ADR-0003), so this file is too.
//
// - An anchor owns each child's conversation. It is a background task of the parent's conversation that finishes at
//   once, so the parent's abort (Esc) and idle waits never reach the child, but the child's work keeps it completing.
// - A reporter carries one turn: it submits an input to a child, waits for the answer, and then either hands the result
//   to a `subagent_wait` blocked on that turn or reports it to the parent once the parent is idle; until then a
//   `subagent_wait` may still claim it. Request IDs keep a restart from submitting or reporting twice.
// - A wait task is what `subagent_wait` blocks on. It ends when a commit gives its waiter a result, when a steer is
//   queued for the caller, or at its deadline, which a timer of its invocation marks.
// @effect-diagnostics asyncFunction:off newPromise:off preferEffectArray:off missingPipeableSignature:off
import type { Draft } from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import {
  type ConversationId,
  defineTask,
  InboxDoc,
  LiveDoc,
  type NextTaskState,
  ROOT_CONVERSATION_ID,
  type Task,
  type TaskId,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as EffectContext from "effect/Context";
import * as Record from "effect/Record";
import * as Option from "effect/Option";
import { ROOT_AGENT } from "./ids.ts";
import {
  type AgentRecord,
  addTurn,
  answerText,
  conversationOf,
  EMPTY_STATE,
  reportConversationOf,
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

/**
 * The line a settled turn's result ends with, for an agent with a Subagent Workspace of its own (`handBackLine`): its
 * branch and what it has not pushed, read as the turn settles. Never rejects.
 */
export type HandBack = (agent: AgentRecord, context: Context) => Promise<string | undefined>;

/** The reporter task the extension installs, for the tools that start turns. */
export class SubagentReporter extends EffectContext.Service<SubagentReporter, ReporterTask>()(
  "@cloudpid/extensions/subagents/tasks/SubagentReporter",
) {}

/** A turn's result with the hand-back line it ends with, if any. */
export const withHandBack = (text: string, handBack: string | undefined): string =>
  handBack === undefined ? text : text === "" ? handBack : `${text}\n\n${handBack}`;

/** The reporter task as the extension installs it (`reporterWith`). */
export type ReporterTask = Task<ReporterInput, ReporterState, null, object>;

type ReporterState =
  | { phase: "deliver" }
  /** Hold `report` until the parent is idle; `round` counts the times it was found busy again. */
  | { phase: "report"; parent: string; report: string | null; round: number }
  /** `conversation`: the Session branch the report goes to; the root conversation for one checkpointed without it. */
  | { phase: "post"; report: string; conversation?: ConversationId };

/**
 * The conversation agent `agentId`'s report goes to: its parent's, or the Session branch a child of the root was started
 * from. A deleted agent's falls back to its parent's.
 */
const reportTarget = (
  state: SubagentsState,
  agentId: string,
  parent: string,
): ConversationId | undefined =>
  reportConversationOf(state, agentId) ?? conversationOf(state, parent);

/**
 * The turn `turnId` among `turns` that `reporter` carries. A later agent that took a deleted agent's ID has turns of its
 * own (ADR-0040), which a reporter of the deleted one must neither deliver to nor settle.
 */
const carriedTurn = <T extends { readonly id: string; readonly reporter: TaskId }>(
  turns: ReadonlyArray<T> | undefined,
  turnId: string,
  reporter: TaskId,
): T | undefined =>
  Option.getOrUndefined(
    Arr.findFirst(turns ?? [], (each) => each.id === turnId && each.reporter === reporter),
  );

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
  reporter: ReporterTask,
): Promise<string | undefined> => {
  const agent = state.agents[input.agentId];
  const owner = agent === undefined ? undefined : conversationOf(state, agent.parent);

  if (agent === undefined || owner === undefined) return undefined;

  const turnId = `turn-${agent.nextTurn}`;

  agent.nextTurn += 1;

  const task = await tx.createTask(
    reporter,
    { ...input, turnId },
    { ownership: { kind: "conversation" }, conversationId: owner, background: true },
  );

  addTurn(agent, {
    id: turnId,
    reporter: task,
    status: "running",
    startedAt: now,
    endedAt: null,
    answer: null,
    error: null,
    delivery: null,
  });

  return turnId;
};

/**
 * Delivers one turn's input to an agent and its result to the agent's parent. A result of an agent with a Subagent
 * Workspace of its own ends with `handBack`'s line.
 */
export const reporterWith = (handBack: HandBack): ReporterTask => {
  const definition: ReporterTask = defineTask<ReporterInput, ReporterState, null>({
    name: "cloudpid.subagent-reporter",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (reporter, runtime, context) => {
        const { agentId, turnId, content, whenBusy, from } = reporter.input;
        const state = (await runtime.snapshot(SubagentsDoc, context)) ?? EMPTY_STATE;
        const found = state.agents[agentId];

        // Its agent, unless deleted, perhaps with a new agent taking the ID.
        const agent =
          carriedTurn(found?.turns, turnId, reporter.id) === undefined ? undefined : found;

        const conversation =
          agent === undefined
            ? undefined
            : await runtime.conversation(agent.conversationId, context);

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

        // Read before the commit, which holds the Session line: what the agent's own Workspace has not pushed.
        const handBackLine =
          agent?.workspace === undefined || settled.reason === "aborted"
            ? undefined
            : await handBack(agent, context);

        // One commit settles the turn and decides its delivery, so a restart never decides again.
        await runtime.commit(async (tx) => {
          // Table reads come before the commit's writes.
          const answer =
            settled.status === "done" && settled.type === "input" ? settled.answer : null;

          const text = answer === null ? "" : await answerText(tx, answer);
          const doc = await tx.doc(SubagentsDoc);
          const record = doc.agents[agentId];

          const settledTurn = carriedTurn(record?.turns, turnId, reporter.id);

          if (record === undefined || settledTurn === undefined) return completed(null);

          const status: TurnStatus =
            answer !== null ? "completed" : settled.reason === "aborted" ? "aborted" : "failed";

          const error = status === "failed" ? (settled.reason ?? "failed") : null;
          const now = runtime.now();

          settledTurn.status = status;
          settledTurn.answer = answer;
          settledTurn.error = error;
          settledTurn.endedAt = now;

          if (handBackLine !== undefined) settledTurn.handBack = handBackLine;

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

          // Several inputs steered into one run end in one answer, which reaches the parent once, whichever of their
          // turns settles first: the turn that carries it is `wait`, `pending`, or `auto`, and the others `duplicate`.
          const siblings =
            answer === null
              ? []
              : Arr.filter(record.turns, (each) => each.id !== turnId && each.answer === answer);

          const delivered = Arr.some(
            siblings,
            (each) => each.delivery === "wait" || each.delivery === "auto",
          );

          if (waiting !== undefined) {
            // A report still held for the same answer gives way to this wait.
            for (const each of siblings) {
              if (each.delivery === "pending") each.delivery = "duplicate";
            }

            const elapsed_ms = now - waiting.startedAt;

            waiting.result = waitEvent(
              "turn",
              agentId,
              delivered
                ? { turn_id: turnId, status, already_delivered: true, elapsed_ms }
                : {
                    turn_id: turnId,
                    status,
                    output: withHandBack(text, settledTurn.handBack),
                    error,
                    elapsed_ms,
                  },
            );
            settledTurn.delivery = delivered ? "duplicate" : "wait";

            return next(null);
          }

          if (siblings.length > 0) {
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
            `${envelope("result", agentId, turnId, status)}\n${withHandBack(
              status === "completed" ? text : `The turn failed: ${error ?? "unknown error"}`,
              settledTurn.handBack,
            )}`,
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

        const owner = reportTarget(
          (await runtime.snapshot(SubagentsDoc, context)) ?? EMPTY_STATE,
          agentId,
          parent,
        );

        if (owner !== undefined) await whenIdle(runtime, owner, context);

        await runtime.commit(async (tx): Promise<NextTaskState<ReporterState, null>> => {
          const doc = await tx.doc(SubagentsDoc);

          const turn = carriedTurn(doc.agents[agentId]?.turns, turnId, reporter.id);

          // Claimed by a wait meanwhile, or deleted.
          if (turn?.delivery !== "pending") return completed(null);

          const conversation = reportTarget(doc, agentId, parent);

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
            return { status: "running", checkpoint: { phase: "post", report, conversation } };
          }

          await startTurn(
            tx,
            doc,
            { agentId: parent, content: report, whenBusy: "followUp", from: agentId },
            runtime.now(),
            definition,
          );

          return completed(null);
        }, context);
      },
      // The root has no reporter of its own: the report is submitted to it, once, by its request ID.
      post: async (reporter, runtime, context) => {
        const { report, conversation = ROOT_CONVERSATION_ID } = reporter.state.checkpoint;
        const { agentId, turnId } = reporter.input;
        const root = await runtime.conversation(conversation, context);

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

        const turn = carriedTurn(
          doc.agents[reporter.input.agentId]?.turns,
          reporter.input.turnId,
          reporter.id,
        );

        if (turn?.status === "running") {
          turn.status = "aborted";
          turn.delivery = "none";
          turn.endedAt = runtime.now();
        }

        // Stopped while its report was held for an idle parent: the owner stopped everything, so nothing is reported.
        if (turn?.delivery === "pending") turn.delivery = "none";

        return aborted();
      }, context),
  });

  return definition;
};

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

  const turn = Arr.findFirst(target.turns, (each) => each.id === input.turnId).pipe(
    Option.getOrUndefined,
  );

  // Settled without a result for this wait: it reached the caller another way.
  if (turn?.status !== "running") {
    return completed<{ phase: "wait" }, WaitEvent>(
      waitEvent("turn", input.target, {
        turn_id: input.turnId,
        status: turn?.status ?? "completed",
        already_delivered: true,
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
type Watcher = Pick<WaitRuntime, "signal" | "setTimer" | "now">;

/** Rejects with the reason when `runtime`'s invocation is signalled; its listener goes when `until` aborts. */
const signalled = (runtime: Watcher, until: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    const reject_ = () => reject(runtime.signal.reason);

    if (runtime.signal.aborted) reject_();
    else runtime.signal.addEventListener("abort", reject_, { once: true, signal: until });
  });

/**
 * Resolves around `deadline` on the Harness clock, by a timer of `runtime`'s invocation, which `until` disarms. The
 * timer is not durable: the wait stays in its phase, where it can watch, and a phase run again after a restart arms
 * it again for what is left.
 */
const timedOut = (runtime: Watcher, deadline: number, until: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const disarm = runtime.setTimer(resolve, Math.max(0, deadline - runtime.now()));

    until.addEventListener("abort", disarm, { once: true });
  });

/**
 * Block until the Subagents document or the caller's inbox changes, or about `deadline`: the caller checks the clock
 * again.
 */
const nextChange = async (
  runtime: Watcher,
  watches: ReadonlyArray<{ start(listener: () => Promise<void>): void } | undefined>,
  deadline: number | null,
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
      ...(deadline === null ? [] : [timedOut(runtime, deadline, controller.signal)]),
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

      await nextChange(runtime, [live], null);
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
          const state = doc?.value ?? EMPTY_STATE;
          const waiter = state.waiters[key];

          const settled = !Arr.some(
            state.agents[task.input.target]?.turns ?? [],
            (each) => each.id === task.input.turnId && each.status === "running",
          );

          const done =
            waiter === undefined ||
            waiter.result !== null ||
            settled ||
            steerQueued(inbox?.value) ||
            (deadline !== null && runtime.now() >= deadline);

          if (done) {
            await runtime.commit((tx) => endWait(tx, key, task.input, runtime.now()), context);

            return;
          }

          await nextChange(runtime, [doc, inbox], deadline);
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
