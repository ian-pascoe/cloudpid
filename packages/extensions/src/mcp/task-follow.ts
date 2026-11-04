// @effect-diagnostics asyncFunction:off newPromise:off preferEffectArray:off missingPipeableSignature:off globalTimers:off globalRandom:off globalDate:off -- pi-durable's task phases stay native Promise code (ADR-0003).
// The follower of an MCP task that went on in the background (`docs/architecture/mcp-server-requests.md` → MCP tasks, The
// follower): one `cloudpid.mcp-task` pi-durable task, owned by the conversation that started it and `background`, so
// Stop never reaches it. Its phases poll → sleep → poll until the task ends, and then deliver: the result, already
// converted and pooled, is claimed by a waiting `mcp_task_wait`, or held until the conversation is idle and posted as one
// `cloudpid.mcp-task-ended` entry that carries cloudpid's header only, never the server's text. An end the owner caused
// leaves a model-visible `cloudpid.mcp-task-notice` and starts no Run. Every sleep commit resets pi-durable's restart
// count, so evictions and deploys never end it; the abort sends `tasks/cancel`. It never runs in `McpHost`, which has
// no alarm.
import type { Context } from "@earendil-works/chord";
import {
  type ConversationId,
  defineTask,
  LiveDoc,
  type NextTaskState,
  type EntryDraft,
  type Task,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import type { McpHostClientService } from "./client.ts";
import type { McpCallOrigin } from "./exchange.ts";
import { reporterToCreate, startTurn } from "../subagents/tasks.ts";
import { ROOT_AGENT } from "../subagents/ids.ts";
import { runs, SubagentsDoc } from "../subagents/state.ts";
import { spillTo } from "./spill.ts";
import {
  cancelDue,
  cancelStale,
  pollOnce,
  sendCancel,
  sendCancelWithin,
  taskSpan,
} from "./task-host.ts";
import { applyDecision, decide, type Decision } from "./task-poll.ts";
import {
  closeQuestions,
  observeQuestions,
  type TaskAsking,
  taskStoreOf,
} from "./task-questions.ts";
import { endedRecord, endInDoc, markCancelSent } from "./task-end.ts";
import {
  endedText,
  MCP_TASK_CANCEL_GRACE_MS,
  MCP_TASK_FOLLOW_MS,
  MCP_TASK_RESULT_KEPT_MS,
  pollDelayMs,
  type PollOutcome,
} from "./task-policy.ts";
import type { McpTasksOptions } from "./task-port.ts";
import { appRecorderOf } from "./apps.ts";
import {
  completedResult,
  endedResult,
  type McpResultPool,
  type StoredResult,
} from "./task-results.ts";
import {
  MCP_TASK_ENDED_KIND,
  MCP_TASK_FOLLOWER,
  MCP_TASK_NOTICE_KIND,
  McpTasksDoc,
  type McpTaskEnd,
  type McpTaskRecord,
  type McpTasksState,
} from "./task-state.ts";

/** What a follower is created with: the handle of its task, whose record has the rest. */
export type FollowerInput = { handle: string };

/** `poll` looks at the task; `deliver` holds its result for an idle conversation; `post` and `notice` tell the agent. */
export type FollowerState =
  | { phase: "poll" }
  | { phase: "deliver" }
  | { phase: "post" }
  | { phase: "notice" };

export type McpTaskFollower = Task<FollowerInput, FollowerState, null, object>;

type Runtime = TaskRuntime<FollowerInput, FollowerState, null, object>;

type Next = NextTaskState<FollowerState, null>;

const done: Next = { status: "terminal", outcome: { status: "completed", result: null } };

const aborted: Next = { status: "terminal", outcome: { status: "aborted" } };

/** What the follower needs from the Session. */
export type FollowerDeps = {
  readonly client: McpHostClientService;
  readonly origin: McpCallOrigin;
  readonly tasks: McpTasksOptions;
  readonly pool: McpResultPool;
  /** What the task's questions are asked and answered with; absent, a task that asks is only polled. */
  readonly asking?: TaskAsking | undefined;
};

/** Whether an end is one the owner or the agent caused: it leaves a notice and starts no Run. */
const causedByYou = (end: Pick<McpTaskEnd, "by"> | undefined): boolean =>
  end?.by === "owner" || end?.by === "agent" || end?.by === "stop";

/** Block until conversation `id` has no Run, watching its live document. */
const whenIdle = async (runtime: Runtime, id: ConversationId, context: Context) => {
  for (;;) {
    const live = await runtime.watchDoc(LiveDoc, id, context);

    try {
      if (live?.value?.run === undefined) return;

      await new Promise<void>((resolve, reject) => {
        const reason = () => reject(runtime.signal.reason);

        if (runtime.signal.aborted) return reason();

        runtime.signal.addEventListener("abort", reason, { once: true });
        live.start(() => {
          resolve();

          return Promise.resolve();
        });
      });
    } finally {
      await live?.stop();
    }
  }
};

/** Note, in the commit that tells the agent, when it was told: the first time, a restart that posts again keeps it. */
const markTold = (doc: McpTasksState, handle: string, now: number): void => {
  const current = doc.tasks[handle];

  if (current !== undefined) current.toldAt ??= now;
};

/** The title of a task's entry in the owner's transcript (`data.notice`): where it stands, or that it ended. */
const noticeTitle = (handle: string, status: string): string => `MCP task ${handle}: ${status}`;

/** The title of the entry that tells the agent a task ended. */
const endedTitle = (handle: string, status: string): string =>
  `MCP task ${handle} ended: ${status}`;

/** The follower task over the Session's host client, origin, options and result pool. */
export const taskFollower = (deps: FollowerDeps): McpTaskFollower => {
  const { client, origin, tasks, pool, asking } = deps;
  const reporter = reporterToCreate();
  const timing = tasks.timing ?? {};
  const cancelGrace = timing.cancelGraceMs ?? MCP_TASK_CANCEL_GRACE_MS;

  /** What a record's result is as the agent reads it: the pooled one, or what its end says. */
  const resultOf = async (
    record: McpTaskRecord,
    outcome: PollOutcome | undefined,
    runtime: Runtime,
    context: Context,
  ): Promise<StoredResult> => {
    if (record.end?.status === "completed" && outcome?.kind === "state") {
      const env = await runtime.env(context);

      return completedResult(
        record,
        outcome.result,
        {
          spill: spillTo(env, context),
          signal: runtime.signal,
          onValue: appRecorderOf(tasks, record),
        },
        true,
      );
    }

    return endedResult(record, true);
  };

  /**
   * End the task: convert and pool its result first, then commit the end, the claim on delivery and where the follower
   * goes next, together. A waiting `mcp_task_wait` claims the result; an end the owner caused leaves a notice; else it is
   * held for an idle conversation.
   */
  const finish = async (
    runtime: Runtime,
    context: Context,
    record: McpTaskRecord,
    end: Omit<McpTaskEnd, "at">,
    outcome: PollOutcome | undefined,
    decision: Decision,
  ) => {
    const now = runtime.now();
    const closed: McpTaskEnd = { ...end, at: now };
    const ended = endedRecord(record, closed, { decision });

    if (decision.cancel === true) await sendCancel(client, record, origin);

    const result = await resultOf(ended, outcome, runtime, context);
    const note = pool.put(record.handle, result, now);

    const next = await runtime.commit(async (tx): Promise<Next> => {
      const doc = await tx.doc(McpTasksDoc);
      const current = doc.tasks[record.handle];

      if (current === undefined || current.end !== undefined) return done;

      // A waiting `mcp_task_wait` claims the result, while its call lives.
      const waiter = current.waiter === undefined ? undefined : await tx.task(current.waiter);
      const waiting = waiter !== undefined && isLive(waiter.state.status);
      const owner = causedByYou(end);

      endInDoc(doc, record.handle, closed, {
        decision,
        note,
        delivery: waiting ? "wait" : owner ? "none" : "pending",
      });

      return waiting
        ? done
        : { status: "running", checkpoint: owner ? { phase: "notice" } : { phase: "deliver" } };
    }, context);

    await taskSpan(ended);
    await closeQuestions(asking, record.handle);

    return next;
  };

  /** What the agent is told of the end of `record`: with the day its result is kept until. */
  const endedBody = (record: McpTaskRecord, now: number): string =>
    endedText(
      record,
      now,
      pool.keptUntil(record.handle) ?? (record.end?.at ?? now) + MCP_TASK_RESULT_KEPT_MS,
    );

  /**
   * Leave the agent a model-visible note of `record` (`cloudpid.mcp-task-notice`): cloudpid's words only, written once for
   * the task, never starting a Run. It is best effort: a conversation that was archived or deleted takes none.
   */
  const leaveNotice = async (record: McpTaskRecord, now: number, text: string) => {
    const status = record.end?.status ?? record.status;
    const by = record.end?.by ?? "owner";

    const entry: EntryDraft = {
      kind: MCP_TASK_NOTICE_KIND,
      model: [
        {
          role: "user",
          content: `[MCP task notice | task=${record.handle} | server=${record.server} | status=${status} | by=${by === "agent" ? "you" : "the owner"}]\nMCP task ${record.handle} ${text}`,
          timestamp: now,
        },
      ],
      data: { task: record.handle, status, by, notice: noticeTitle(record.handle, status) },
    };

    try {
      await tasks.write?.(record.conversation, {
        requestId: `mcp-task-notice:${record.handle}`,
        entry,
      });
    } catch {
      // The note is a courtesy: the end stands without it.
    }
  };

  /**
   * Run a phase, then tell the Session its followers changed (`McpTasksOptions.changed`): it may have ended, or gone to
   * sleep until another time, which the alarm and the Registry's count follow.
   */
  const noting =
    <A extends ReadonlyArray<unknown>>(phase: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      try {
        await phase(...args);
      } finally {
        tasks.changed?.();
      }
    };

  const definition: McpTaskFollower = defineTask<FollowerInput, FollowerState, null>({
    name: MCP_TASK_FOLLOWER,
    version: 1,
    initial: () => ({ phase: "poll" }),
    phases: {
      poll: noting(async (task, runtime, context) => {
        const { handle } = task.input;
        const doc = await runtime.snapshot(McpTasksDoc, context);
        let record = doc?.tasks[handle];

        if (record === undefined) {
          await runtime.commit(() => done, context);

          return;
        }

        // Ended while this follower slept (a wait or an abort ended it): only the delivery is left.
        if (record.end !== undefined) {
          await closeQuestions(asking, handle);

          await runtime.commit(
            () =>
              record?.delivery === "pending"
                ? { status: "running", checkpoint: { phase: "deliver" } }
                : done,
            context,
          );

          return;
        }

        const now = runtime.now();

        // A cancel that was being sent when the object stopped is sent once more (one still being sent by the call that
        // asked for it is left to finish), and an ignored one is given up on.
        if (cancelStale(client, record, now)) {
          const took = await sendCancel(client, record, origin);

          await runtime.commit(async (tx) => {
            const current = (await tx.doc(McpTasksDoc)).tasks[handle];

            markCancelSent(current, took);
          }, context);
        }

        if (now - record.createdAt >= MCP_TASK_FOLLOW_MS) {
          await sendCancel(client, record, origin);

          await finish(
            runtime,
            context,
            record,
            { status: "stopped", by: "cloudpid", reason: "cloudpid follows a task for 7 days" },
            undefined,
            { patch: {}, failures: record.failures, changed: true },
          );

          return;
        }

        const outcome = await pollOnce(client, origin, record, runtime.signal, tasks.redact);

        // A cancel is committed before it is sent, so one that made the server answer `cancelled` is on the record by now,
        // though not on the copy this poll began with: without it the end would read as the server's own and start a Run.
        const cancel = (await runtime.snapshot(McpTasksDoc, context))?.tasks[handle]?.cancel;

        if (cancel !== undefined) record = { ...record, cancel };

        const decision = decide(record, outcome, runtime.now(), timing);

        if (decision.end !== undefined) {
          await finish(runtime, context, record, decision.end, outcome, decision);

          return;
        }

        // A cancel the server ignored: it still runs past the grace after the cancel was sent.
        if (record.cancel !== undefined && runtime.now() >= record.cancel.at + cancelGrace) {
          await finish(
            runtime,
            context,
            record,
            {
              status: "stopped",
              by: record.cancel.by,
              reason: `cancel sent; ${record.server} did not stop it, and cloudpid stopped following`,
            },
            undefined,
            decision,
          );

          return;
        }

        if (decision.changed || decision.failures.count !== record.failures.count) {
          await runtime.commit(async (tx) => {
            const current = (await tx.doc(McpTasksDoc)).tasks[handle];

            if (current !== undefined && current.end === undefined)
              applyDecision(current, decision);
          }, context);
        }

        record = { ...structuredClone(record), ...decision.patch, failures: decision.failures };

        // A task that waits on questions: the ones not asked are asked, and answers the owner gave are sent.
        if (
          asking !== undefined &&
          outcome.kind === "state" &&
          outcome.snapshot.status === "input_required"
        ) {
          const fresh = (await runtime.snapshot(McpTasksDoc, context))?.tasks[handle] ?? record;

          await observeQuestions(
            {
              asking,
              client,
              origin,
              store: taskStoreOf(
                {
                  snapshot: (token, at) => runtime.snapshot(token, at),
                  // The follower's commit also settles its own state: an answer's write leaves that as it is.
                  commit: (write, at) =>
                    runtime.commit(async (tx) => {
                      await write(tx);

                      return undefined;
                    }, at),
                },
                context,
              ),
              now: () => runtime.now(),
              slowMs: timing.answerSlowMs,
              signal: runtime.signal,
            },
            fresh,
            outcome.snapshot,
          );
        }

        const delay =
          decision.retryInMs ??
          timing.pollMs ??
          pollDelayMs({
            ageMs: runtime.now() - record.createdAt,
            pollIntervalMs: record.pollIntervalMs,
            background: true,
            ownerOnly: record.status === "input_required",
            stdio: record.transport === "stdio",
            jitter: Math.random(),
          });

        // A cancel waits for the server's answer, but not past the grace it is given.
        const graceEnd = record.cancel === undefined ? undefined : record.cancel.at + cancelGrace;
        const sooner = graceEnd === undefined ? delay : Math.max(1000, graceEnd - runtime.now());
        const until = runtime.now() + Math.min(delay, sooner);

        await runtime.sleepUntil(until, { phase: "poll" }, context);
      }),

      deliver: noting(async (task, runtime, context) => {
        const { handle } = task.input;
        const state = await runtime.snapshot(McpTasksDoc, context);
        const record = state?.tasks[handle];

        if (record === undefined || record.delivery !== "pending") {
          await runtime.commit(() => done, context);

          return;
        }

        await whenIdle(runtime, record.conversation, context);

        await runtime.commit(async (tx): Promise<Next> => {
          const current = (await tx.doc(McpTasksDoc)).tasks[handle];

          // Claimed by a wait meanwhile, or gone.
          if (current === undefined || current.delivery !== "pending") return done;

          // Busy again: held for the next idle.
          if ((await tx.doc(LiveDoc, current.conversation)).run !== undefined) {
            return { status: "running", checkpoint: { phase: "deliver" } };
          }

          current.delivery = "auto";

          return { status: "running", checkpoint: { phase: "post" } };
        }, context);
      }),

      // The root conversation has no reporter of its own: the entry is submitted to it, once, by its request ID. A
      // subagent's is a turn of its own, started in the commit that ends this phase, so a restart starts it once.
      post: noting(async (task, runtime, context) => {
        const { handle } = task.input;
        const record = (await runtime.snapshot(McpTasksDoc, context))?.tasks[handle];

        if (record !== undefined && record.agent !== ROOT_AGENT) {
          await runtime.commit(async (tx): Promise<Next> => {
            const doc = await tx.doc(SubagentsDoc);

            // Deleted since, or its ID taken by another agent (ADR-0040): the turn would not be the agent that started it.
            if (!runs(doc, record.agent, record.conversation)) return done;

            await startTurn(
              tx,
              doc,
              {
                agentId: record.agent,
                content: endedBody(record, runtime.now()),
                whenBusy: "followUp",
                from: handle,
              },
              runtime.now(),
              reporter,
            );
            // The agent is told by this very commit.
            markTold(await tx.doc(McpTasksDoc), handle, runtime.now());

            return done;
          }, context);

          return;
        }

        const conversation =
          record === undefined
            ? undefined
            : await runtime.conversation(record.conversation, context);

        if (record !== undefined && conversation !== undefined) {
          const submission = await conversation.submit(
            {
              type: "input",
              content: endedBody(record, runtime.now()),
              whenBusy: "followUp",
              requestId: `mcp-task:${handle}`,
              entry: {
                kind: MCP_TASK_ENDED_KIND,
                data: {
                  // Its title in the owner's transcript, where it shows as a notice (the text is the agent's).
                  notice: endedTitle(handle, record.end?.status ?? record.status),
                  task: handle,
                  server: record.server,
                  tool: record.modelTool,
                  status: record.end?.status ?? record.status,
                  after_ms: (record.end?.at ?? runtime.now()) - record.createdAt,
                },
              },
            },
            context,
          );

          // The Run it starts pushes `finished` or `failed` to the owner.
          tasks.submitted?.(submission.id);

          await runtime.commit(async (tx): Promise<Next> => {
            markTold(await tx.doc(McpTasksDoc), handle, runtime.now());

            return done;
          }, context);

          return;
        }

        // No conversation to tell (archived or deleted): nobody was.
        await runtime.commit(() => done, context);
      }),

      // An end the owner or the agent caused: the agent is told, and nothing runs.
      notice: noting(async (task, runtime, context) => {
        const { handle } = task.input;
        const record = (await runtime.snapshot(McpTasksDoc, context))?.tasks[handle];

        if (record !== undefined) {
          const status = record.end?.status ?? record.status;
          const by = record.end?.by ?? "owner";

          await leaveNotice(
            record,
            runtime.now(),
            `ended: ${status === "cancelled" ? "it was cancelled" : "it was stopped"}${by === "agent" ? " at your request" : " by the owner"}.`,
          );
        }

        await runtime.commit(() => done, context);
      }),
    },

    // Aborted with its conversation's background work (Stop all, Archive, a deleted conversation): the task is
    // cancelled on the server, the held result is dropped, and the agent is told in a notice that starts no Run.
    abort: noting(async (task, runtime, context) => {
      const { handle } = task.input;
      const record = (await runtime.snapshot(McpTasksDoc, context))?.tasks[handle];

      if (record === undefined) {
        await runtime.commit(() => aborted, context);

        return;
      }

      const now = runtime.now();

      if (record.end === undefined) {
        // Once, and not for longer than the bound: one already sent (the agent's, say) is not sent again, and a server that
        // does not answer does not hold Stop all, Archive or Delete back: the record ends all the same.
        if (cancelDue(client, record)) await sendCancelWithin(client, record, origin);

        const closed: McpTaskEnd = { status: "cancelled", by: "stop", at: now };
        const ended = endedRecord(record, closed, {});
        const note = pool.put(handle, endedResult(ended, true), now);

        await runtime.commit(async (tx): Promise<Next> => {
          endInDoc(await tx.doc(McpTasksDoc), handle, closed, { note, delivery: "none" });

          return aborted;
        }, context);

        await taskSpan(ended);
        await closeQuestions(asking, handle);
        await leaveNotice(ended, now, "ended: it was cancelled by the owner.");

        return;
      }

      // Ended, with its result held for an idle conversation: the owner stopped everything, so the result is dropped
      // and the agent is told so; a result already claimed or posted is the agent's and stays.
      const held = record.delivery === "pending";

      if (held) pool.drop(handle);

      await runtime.commit(async (tx): Promise<Next> => {
        const current = (await tx.doc(McpTasksDoc)).tasks[handle];

        if (current?.delivery === "pending") {
          current.delivery = "none";
          delete current.result;
        }

        return aborted;
      }, context);

      if (held) {
        await leaveNotice(
          record,
          now,
          `ended (${record.end.status}), and its result was dropped when the owner stopped everything.`,
        );
      }
    }),
  });

  return definition;
};

/** Whether a task status is one of a task still running or waiting. */
const isLive = (status: string): boolean => status !== "terminal";
