// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain values over the host's task requests.
// An App View's call that the server answered with an MCP task (`docs/architecture/mcp-server-requests.md` → MCP tasks, App
// View calls; `docs/architecture/mcp-apps.md` → Server requests from an App View's calls): the Session polls it, in
// memory, for as long as the View's request is in flight (the View is mounted), at most `MCP_APP_TASK_WINDOW_MS` from the
// task's creation. A View that goes (its teardown, its cancel, its socket) or the bound ends it with `tasks/cancel`. It is
// never in the Session's `cloudpid.mcp-tasks` document, so never in `mcp_tasks` or the agent's tools; the sweep's own small
// entry (`./task-view-store.ts`) is all that outlives the request, and it counts toward the same caps.
//
// A task that waits for input (`input_required`) is asked live, as the call itself would have been (`./app-asking.ts`): a
// form or a Sampling request waits on its card, the answers go with `tasks/update`, and a refusal (a form cloudpid cannot
// take, a Sampling request refused, a question of another kind) ends the task with `tasks/cancel`. Nothing is kept for
// later: a View's task lives as long as its request.
import {
  isJsonObject,
  type JsonObject,
  type McpAnswers,
  type McpEngineValue,
  type McpHostRequestContext,
  type McpHostRequestHooks,
  type McpHostRequestResult,
  type McpHostTaskStarted,
  type McpHostTaskUpdate,
} from "@cloudpid/mcp/types";
import type { ConversationId } from "@earendil-works/pi-durable";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Random from "effect/Random";
import * as Record from "effect/Record";
import type { HostLost, McpHostClientService } from "./client.ts";
import { cancelTook, decide, taskCancel, taskGet, applyDecision } from "./task-poll.ts";
import { MCP_TASK_STOP_CANCEL_MS, pollDelayMs, readPoll, type PollOutcome } from "./task-policy.ts";
import { abortedBy, type McpTasksTiming } from "./task-port.ts";
import type { McpTaskRecord } from "./task-state.ts";

/** The longest a View's request waits for its MCP task: 15 minutes from the task's creation. */
export const MCP_APP_TASK_WINDOW_MS = 15 * 60 * 1000;

/** What a View's task asks its questions with: the call's own hooks (`./app-asking.ts`), and what it said it could answer. */
export type ViewTaskQuestions = {
  readonly answers: McpAnswers;
  readonly hooks: Pick<McpHostRequestHooks, "onInput" | "onInputEnded">;
  /** The bound passed: every card the task's questions wait on is withdrawn. */
  readonly expire: () => void;
};

/** What a View's task is followed with. */
export type ViewTask = {
  readonly client: McpHostClientService;
  readonly started: McpHostTaskStarted;
  readonly server: string;
  /** The server's own name for the tool, which `tasks/get` checks a completed result against. */
  readonly tool: string;
  readonly modelTool: string;
  /** The context of the View's request: its `tasks/*` follow it, as an `app` request. */
  readonly ctx: McpHostRequestContext;
  readonly conversation: ConversationId;
  readonly transport: "http" | "stdio";
  /** Aborts when the View's request is cancelled, its View is torn down or its socket goes. */
  readonly signal: AbortSignal;
  readonly timing?: McpTasksTiming | undefined;
  /** Absent: a task that asks is not answered, and goes on polling until the bound. */
  readonly questions?: ViewTaskQuestions | undefined;
};

/** How a View's task ended. */
export type ViewTaskEnd =
  /** `completed`: the task's result, as a `tools/call` would have returned it. */
  | { readonly kind: "completed"; readonly result: McpEngineValue }
  /** The task ended another way (`failed`, `cancelled` by the server, or one cloudpid cannot follow). */
  | {
      readonly kind: "ended";
      readonly status: McpTaskRecord["status"];
      readonly reason?: string | undefined;
      readonly code?: number | undefined;
    }
  /** A question of the task was refused (or could not be answered): `tasks/cancel` was sent. */
  | { readonly kind: "refused"; readonly message: string }
  /** The View went: `tasks/cancel` was sent. */
  | { readonly kind: "stopped" }
  /** The bound passed: `tasks/cancel` was sent. */
  | { readonly kind: "bound" };

/** `tasks/cancel` of the task, once, waiting no longer than `MCP_TASK_STOP_CANCEL_MS` for the answer; never fails. */
export const cancelViewTask = (
  client: McpHostClientService,
  task: Pick<McpTaskRecord, "server" | "taskId" | "tool" | "conn">,
  ctx: McpHostRequestContext,
): Effect.Effect<boolean> =>
  client.request(taskCancel(task, ctx), {}).pipe(
    Effect.map(cancelTook),
    Effect.timeoutOption(MCP_TASK_STOP_CANCEL_MS),
    Effect.map(Option.getOrElse(() => false)),
    Effect.catchCause(() => Effect.succeed(false)),
  );

/** The record `decide` and `readPoll` work from: in memory only, never stored. */
const recordOf = (task: ViewTask, now: number): McpTaskRecord => {
  const { started } = task;

  const record: McpTaskRecord = {
    handle: "app-view",
    taskId: started.task.taskId,
    server: task.server,
    tool: task.tool,
    modelTool: task.modelTool,
    conn: started.conn,
    transport: task.transport,
    conversation: task.conversation,
    agent: "app",
    callId: task.ctx.callId ?? "",
    windowMs: MCP_APP_TASK_WINDOW_MS,
    createdAt: now,
    ttlMs: started.task.ttlMs,
    status: started.task.status,
    polls: 0,
    failures: { count: 0 },
    background: false,
    delivery: null,
  };

  if (started.identity !== undefined) record.identity = started.identity;

  if (started.spawn !== undefined) record.spawn = started.spawn;

  if (started.signIn !== undefined) record.signIn = started.signIn;

  if (started.task.pollIntervalMs !== undefined)
    record.pollIntervalMs = started.task.pollIntervalMs;

  if (task.ctx.workspace !== undefined) record.workspace = task.ctx.workspace;

  return record;
};

/**
 * The question of one `inputRequests` entry, as the call's `onInput` reads it; none for a method the View's call said it
 * cannot answer (`roots/list` among them: a View's task has no roots to give).
 */
const questionOf = (key: string, entry: JsonObject, answers: McpAnswers) => {
  const method = entry["method"];
  const params = isJsonObject(entry["params"]) ? entry["params"] : {};

  if (method === "elicitation/create" && answers.elicitation === true) {
    return { key, kind: "elicitation", params, mode: "live", era: "modern" } as const;
  }

  if (method === "sampling/createMessage" && answers.sampling === true) {
    return { key, kind: "sampling", params, mode: "live", era: "modern" } as const;
  }

  return undefined;
};

/** The `tasks/update` of `record` with the answers of the questions it asked, by key. */
const taskUpdate = (
  record: McpTaskRecord,
  inputResponses: McpHostTaskUpdate["params"]["inputResponses"],
  ctx: McpHostRequestContext,
): McpHostTaskUpdate => ({
  op: "tasks/update",
  server: record.server,
  params: { taskId: record.taskId, tool: record.tool, conn: record.conn, inputResponses },
  ctx,
});

/** What answering a task's questions came to: the answers to send, or why the task ends. */
type Answered =
  | { readonly kind: "answers"; readonly responses: Record<string, JsonObject> }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "expired" };

/**
 * Follow `task` until it ends, the View goes or the bound passes. Polls on the cadence a task has inline (the server's
 * `pollIntervalMs`, else 2 s and then 5 s), decided as the agent's are (`decide`, the Failures table), and answers what
 * it asks (`task.questions`). Never fails.
 */
export const followViewTask = (task: ViewTask): Effect.Effect<ViewTaskEnd> =>
  Effect.gen(function* () {
    const { client, signal, ctx, questions } = task;
    const timing = task.timing ?? {};
    const bound = timing.viewWindowMs ?? MCP_APP_TASK_WINDOW_MS;
    const record = recordOf(task, yield* Clock.currentTimeMillis);
    const deadline = record.createdAt + bound;

    /** The keys of this round of the task's questions that were answered: a server slow to move on is not asked twice. */
    const answered = new Set<string>();

    const cancel = cancelViewTask(client, record, ctx);
    const stop = Effect.promise(() => abortedBy([signal]));

    /** Answer the questions `asked`, one at a time (a View has one waiting form), within the bound. */
    const answerAll = (asked: Record<string, JsonObject>) =>
      Effect.gen(function* () {
        const responses: Record<string, JsonObject> = {};

        for (const [key, entry] of Record.toEntries(asked)) {
          if (answered.has(key) || questions === undefined) continue;

          const question = questionOf(key, entry, questions.answers);

          if (question === undefined) {
            return {
              kind: "refused",
              message: `The server asked for ${Predicate.isString(entry["method"]) ? entry["method"] : "something"}, which cloudpid did not offer on this call`,
            } satisfies Answered;
          }

          const left = Math.max(0, deadline - (yield* Clock.currentTimeMillis));

          const reply = yield* Effect.promise(
            () => questions.hooks.onInput?.(question) ?? Promise.resolve(undefined),
          ).pipe(
            Effect.timeoutOption(left),
            Effect.map(Option.getOrElse(() => "expired" as const)),
          );

          if (reply === "expired") {
            questions.expire();

            return { kind: "expired" } satisfies Answered;
          }

          if (reply?.kind === "refused")
            return { kind: "refused", message: reply.message } satisfies Answered;

          answered.add(key);
          responses[key] =
            reply?.kind === "answered" || reply?.kind === "sampled"
              ? { ...reply.result }
              : { action: "cancel" };
        }

        return { kind: "answers", responses } satisfies Answered;
      });

    for (;;) {
      if (signal.aborted) {
        yield* cancel;

        return { kind: "stopped" } satisfies ViewTaskEnd;
      }

      if ((yield* Clock.currentTimeMillis) >= deadline) {
        yield* cancel;

        return { kind: "bound" } satisfies ViewTaskEnd;
      }

      const answer = yield* client.request(taskGet(record, ctx), {
        untilAborted: () => abortedBy([signal]),
      });

      if (signal.aborted) {
        yield* cancel;

        return { kind: "stopped" } satisfies ViewTaskEnd;
      }

      const outcome: PollOutcome = readPoll(answer, record);
      const decision = decide(record, outcome, yield* Clock.currentTimeMillis, timing);

      if (decision.cancel === true) yield* cancel;

      if (decision.end !== undefined) {
        const { status, reason, code } = decision.end;

        if (
          status === "completed" &&
          outcome.kind === "state" &&
          outcome.result.result !== undefined
        ) {
          return { kind: "completed", result: outcome.result.result } satisfies ViewTaskEnd;
        }

        return status === "completed"
          ? ({
              kind: "ended",
              status: "failed",
              reason: "the server's task completed with no result",
            } satisfies ViewTaskEnd)
          : ({ kind: "ended", status, reason, code } satisfies ViewTaskEnd);
      }

      applyDecision(record, decision);

      if (outcome.kind === "state" && outcome.snapshot.status === "input_required") {
        const done = yield* answerAll(outcome.snapshot.inputRequests);

        if (done.kind === "expired") {
          yield* cancel;

          return { kind: "bound" } satisfies ViewTaskEnd;
        }

        // The View went while the owner was asked: whatever the card said, the task is not answered.
        if (signal.aborted) {
          yield* cancel;

          return { kind: "stopped" } satisfies ViewTaskEnd;
        }

        if (done.kind === "refused") {
          yield* cancel;

          return { kind: "refused", message: done.message } satisfies ViewTaskEnd;
        }

        if (Record.size(done.responses) > 0) {
          const sent = yield* client
            .request(taskUpdate(record, done.responses, ctx), {
              untilAborted: () => abortedBy([signal]),
            })
            .pipe(Effect.race(stop.pipe(Effect.as(undefined))));

          if (sent !== undefined && !isTaken(sent)) {
            yield* cancel;

            return {
              kind: "ended",
              status: "failed",
              reason: "the server did not take the answers to its questions",
            } satisfies ViewTaskEnd;
          }
        }
      } else {
        answered.clear();
      }

      const jitter = yield* Random.next;

      const delay =
        decision.retryInMs ??
        timing.pollMs ??
        pollDelayMs({
          ageMs: (yield* Clock.currentTimeMillis) - record.createdAt,
          pollIntervalMs: record.pollIntervalMs,
          background: false,
          // The owner is asked here and now, so the task is not left for a minute between polls.
          ownerOnly: false,
          stdio: record.transport === "stdio",
          jitter,
        });

      // The wait for the next poll ends when the View goes.
      yield* stop.pipe(
        Effect.timeoutOption(
          Math.min(delay, Math.max(0, deadline - (yield* Clock.currentTimeMillis))),
        ),
        Effect.asVoid,
      );
    }
  });

/** Whether the server took a `tasks/update`. */
const isTaken = (answer: McpHostRequestResult | HostLost): boolean =>
  Predicate.isTagged(answer, "TaskAck");
