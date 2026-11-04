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
import { spillTo } from "./spill.ts";
import { pollOnce, sendCancel, taskSpan } from "./task-host.ts";
import { applyDecision, decide, type Decision } from "./task-poll.ts";
import { endedText, pollDelayMs, type PollOutcome } from "./task-policy.ts";
import type { McpTasksOptions } from "./task-port.ts";
import {
  completedResult,
  endedResult,
  type McpResultPool,
  type StoredResult,
} from "./task-results.ts";
import {
  endTask,
  MCP_TASK_ENDED_KIND,
  MCP_TASK_CANCEL_GRACE_MS,
  MCP_TASK_CANCEL_SENDING_MS,
  MCP_TASK_FOLLOW_MS,
  MCP_TASK_FOLLOWER,
  MCP_TASK_NOTICE_KIND,
  McpTasksDoc,
  type McpTaskEnd,
  type McpTaskRecord,
} from "./task-state.ts";

/** What a follower is created with: the handle of its task, whose record has the rest. */
export type FollowerInput = { handle: string };

/** `poll` looks at the task; `deliver` holds its result for an idle conversation; `post` and `notice` tell the agent. */
export type FollowerState =
  | { phase: "poll" }
  | { phase: "deliver"; round: number }
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

/** The follower task over the Session's host client, origin, options and result pool. */
export const taskFollower = (deps: FollowerDeps): McpTaskFollower => {
  const { client, origin, tasks, pool } = deps;
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
        { spill: spillTo(env, context), signal: runtime.signal },
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

    const ended: McpTaskRecord = {
      ...structuredClone(record),
      end: { ...end, at: now },
      status: end.status,
    };

    if (decision.cancel === true) await sendCancel(client, record, origin);

    const result = await resultOf(ended, outcome, runtime, context);
    const note = pool.put(record.handle, result, now);

    const next = await runtime.commit(async (tx): Promise<Next> => {
      const doc = await tx.doc(McpTasksDoc);
      const current = doc.tasks[record.handle];

      if (current === undefined) return done;

      applyDecision(current, decision);

      if (note !== undefined) current.result = note;

      // A waiting `mcp_task_wait` claims the result, while its call lives.
      const waiter = current.waiter === undefined ? undefined : await tx.task(current.waiter);
      const waiting = waiter !== undefined && isLive(waiter.state.status);
      const owner = causedByYou(end);

      current.delivery = waiting ? "wait" : owner ? "none" : "pending";
      endTask(doc, record.handle, { ...end, at: now });

      return waiting
        ? done
        : {
            status: "running",
            checkpoint: owner ? { phase: "notice" } : { phase: "deliver", round: 0 },
          };
    }, context);

    await taskSpan(ended);

    return next;
  };

  const definition: McpTaskFollower = defineTask<FollowerInput, FollowerState, null>({
    name: MCP_TASK_FOLLOWER,
    version: 1,
    initial: () => ({ phase: "poll" }),
    phases: {
      poll: async (task, runtime, context) => {
        const { handle } = task.input;
        const doc = await runtime.snapshot(McpTasksDoc, context);
        let record = doc?.tasks[handle];

        if (record === undefined) {
          await runtime.commit(() => done, context);

          return;
        }

        // Ended while this follower slept (a wait or an abort ended it): only the delivery is left.
        if (record.end !== undefined) {
          await runtime.commit(
            () =>
              record?.delivery === "pending"
                ? { status: "running", checkpoint: { phase: "deliver", round: 0 } }
                : done,
            context,
          );

          return;
        }

        const now = runtime.now();

        // A cancel that was being sent when the object stopped is sent once more (one still being sent by the call that
        // asked for it is left to finish), and an ignored one is given up on.
        if (
          record.cancel?.sent === "sending" &&
          now - record.cancel.at >= MCP_TASK_CANCEL_SENDING_MS
        ) {
          const took = await sendCancel(client, record, origin);

          await runtime.commit(async (tx) => {
            const current = (await tx.doc(McpTasksDoc)).tasks[handle];

            if (current?.cancel !== undefined) current.cancel.sent = took ? "sent" : "failed";
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

        const outcome = await pollOnce(client, origin, record, runtime.signal);
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

        const delay =
          decision.retryInMs ??
          timing.pollMs ??
          pollDelayMs({
            ageMs: runtime.now() - record.createdAt,
            pollIntervalMs: record.pollIntervalMs,
            background: true,
            ownerOnly: record.status === "input_required",
            jitter: Math.random(),
          });

        // A cancel waits for the server's answer, but not past the grace it is given.
        const graceEnd = record.cancel === undefined ? undefined : record.cancel.at + cancelGrace;
        const sooner = graceEnd === undefined ? delay : Math.max(1000, graceEnd - runtime.now());
        const until = runtime.now() + Math.min(delay, sooner);

        await runtime.sleepUntil(until, { phase: "poll" }, context);
      },

      deliver: async (task, runtime, context) => {
        const { handle } = task.input;
        const { round } = task.state.checkpoint;
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
            return { status: "running", checkpoint: { phase: "deliver", round: round + 1 } };
          }

          current.delivery = "auto";

          return { status: "running", checkpoint: { phase: "post" } };
        }, context);
      },

      // The root conversation has no reporter of its own: the entry is submitted to it, once, by its request ID.
      post: async (task, runtime, context) => {
        const { handle } = task.input;
        const record = (await runtime.snapshot(McpTasksDoc, context))?.tasks[handle];

        const conversation =
          record === undefined
            ? undefined
            : await runtime.conversation(record.conversation, context);

        if (record !== undefined && conversation !== undefined) {
          const submission = await conversation.submit(
            {
              type: "input",
              content: endedText(
                record,
                runtime.now(),
                pool.keptUntil(handle) ?? (record.end?.at ?? runtime.now()) + 7 * 24 * 3600 * 1000,
              ),
              whenBusy: "followUp",
              requestId: `mcp-task:${handle}`,
              entry: {
                kind: MCP_TASK_ENDED_KIND,
                data: {
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
        }

        await runtime.commit(() => done, context);
      },

      // An end the owner or the agent caused: the agent is told, and nothing runs.
      notice: async (task, runtime, context) => {
        const { handle } = task.input;
        const record = (await runtime.snapshot(McpTasksDoc, context))?.tasks[handle];

        if (record !== undefined) {
          const status = record.end?.status ?? record.status;
          const by = record.end?.by ?? "owner";

          const entry: EntryDraft = {
            kind: MCP_TASK_NOTICE_KIND,
            model: [
              {
                role: "user",
                content: `[MCP task notice | task=${handle} | server=${record.server} | status=${status} | by=${by === "agent" ? "you" : "the owner"}]\nMCP task ${handle} ended: ${status === "cancelled" ? "it was cancelled" : "it was stopped"}${by === "agent" ? " at your request" : " by the owner"}.`,
                timestamp: runtime.now(),
              },
            ],
            data: { task: handle, status, by },
          };

          await tasks.write?.(record.conversation, {
            requestId: `mcp-task-notice:${handle}`,
            entry,
          });
        }

        await runtime.commit(() => done, context);
      },
    },

    // Aborted with its conversation's background work (Stop all, Archive, a deleted conversation): the task is
    // cancelled on the server, and the held result is dropped.
    abort: async (task, runtime, context) => {
      const { handle } = task.input;
      const record = (await runtime.snapshot(McpTasksDoc, context))?.tasks[handle];

      if (record !== undefined && record.end === undefined) {
        await sendCancel(client, record, origin);

        const now = runtime.now();

        const ended: McpTaskRecord = {
          ...structuredClone(record),
          end: { status: "cancelled", by: "stop", at: now },
          status: "cancelled",
        };

        const note = pool.put(handle, endedResult(ended, true), now);

        await runtime.commit(async (tx): Promise<Next> => {
          const doc = await tx.doc(McpTasksDoc);
          const current = doc.tasks[handle];

          if (current !== undefined) {
            if (note !== undefined) current.result = note;

            current.delivery = "none";
            endTask(doc, handle, { status: "cancelled", by: "stop", at: now });
          }

          return aborted;
        }, context);

        await taskSpan(ended);

        return;
      }

      await runtime.commit(async (tx): Promise<Next> => {
        const current = (await tx.doc(McpTasksDoc)).tasks[handle];

        // Stopped while its result was held for an idle conversation: the owner stopped everything, so nothing is told.
        if (current?.delivery === "pending") current.delivery = "none";

        return aborted;
      }, context);
    },
  });

  return definition;
};

/** Whether a task status is one of a task still running or waiting. */
const isLive = (status: string): boolean => status !== "terminal";
