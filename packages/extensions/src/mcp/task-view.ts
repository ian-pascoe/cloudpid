// @effect-diagnostics missingPipeableSignature:off asyncFunction:off newPromise:off globalTimers:off globalDate:off globalRandom:off -- plain Promise code over the host's task requests.
// An App View's call that the server answered with an MCP task (`docs/architecture/mcp-server-requests.md` → MCP tasks, App
// View calls; `docs/architecture/mcp-apps.md` → Server requests from an App View's calls): the Session polls it, in
// memory, for as long as the View's request is in flight (the View is mounted), at most `MCP_APP_TASK_WINDOW_MS` from the
// task's creation. A View that goes (its teardown, its cancel, its socket) or the bound ends it with `tasks/cancel`. It is
// never in the Session's `cloudpid.mcp-tasks` document, so never in `mcp_tasks`, caps or the agent's tools; the sweep's
// own small record (`./task-view-store.ts`) is all that outlives the request.
import type {
  McpEngineValue,
  McpHostRequestContext,
  McpHostTaskStarted,
} from "@cloudpid/mcp/types";
import * as Effect from "effect/Effect";
import type { McpHostClientService } from "./client.ts";
import { cancelTook, decide, taskCancel, taskGet, applyDecision } from "./task-poll.ts";
import { MCP_TASK_STOP_CANCEL_MS, pollDelayMs, readPoll, type PollOutcome } from "./task-policy.ts";
import { abortedBy, type McpTasksTiming } from "./task-port.ts";
import type { McpTaskRecord } from "./task-state.ts";
import type { ConversationId } from "@earendil-works/pi-durable";

/** The longest a View's request waits for its MCP task: 15 minutes from the task's creation. */
export const MCP_APP_TASK_WINDOW_MS = 15 * 60 * 1000;

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
  /** The View went: `tasks/cancel` was sent. */
  | { readonly kind: "stopped" }
  /** The bound passed: `tasks/cancel` was sent. */
  | { readonly kind: "bound" };

/** `tasks/cancel` of the task, once, waiting no longer than `MCP_TASK_STOP_CANCEL_MS` for the answer; never fails. */
export const cancelViewTask = async (
  client: McpHostClientService,
  task: Pick<McpTaskRecord, "server" | "taskId" | "tool" | "conn">,
  ctx: McpHostRequestContext,
): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const bound = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), MCP_TASK_STOP_CANCEL_MS);
  });

  try {
    return await Promise.race([
      Effect.runPromise(client.request(taskCancel(task, ctx), {})).then(cancelTook),
      bound,
    ]).catch(() => false);
  } finally {
    clearTimeout(timer);
  }
};

/** Wait `ms`, or until `stop` aborts. */
const sleepUntil = (ms: number, stop: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));

    void abortedBy([stop]).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });

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
 * Follow `task` until it ends, the View goes or the bound passes. Polls on the cadence a task has inline (the server's
 * `pollIntervalMs`, else 2 s and then 5 s), decided as the agent's are (`decide`, the Failures table). Never fails.
 */
export const followViewTask = async (task: ViewTask): Promise<ViewTaskEnd> => {
  const { client, signal, ctx } = task;
  const timing = task.timing ?? {};
  const bound = timing.viewWindowMs ?? MCP_APP_TASK_WINDOW_MS;
  const record = recordOf(task, Date.now());
  const deadline = record.createdAt + bound;

  const cancel = () => cancelViewTask(client, record, ctx);

  for (;;) {
    if (signal.aborted) {
      await cancel();

      return { kind: "stopped" };
    }

    if (Date.now() >= deadline) {
      await cancel();

      return { kind: "bound" };
    }

    const answer = await Effect.runPromise(
      client.request(taskGet(record, ctx), { untilAborted: () => abortedBy([signal]) }),
    );

    if (signal.aborted) {
      await cancel();

      return { kind: "stopped" };
    }

    const outcome: PollOutcome = readPoll(answer, record);
    const decision = decide(record, outcome, Date.now(), timing);

    if (decision.cancel === true) await cancel();

    if (decision.end !== undefined) {
      const { status, reason, code } = decision.end;

      if (
        status === "completed" &&
        outcome.kind === "state" &&
        outcome.result.result !== undefined
      ) {
        return { kind: "completed", result: outcome.result.result };
      }

      return status === "completed"
        ? { kind: "ended", status: "failed", reason: "the server's task completed with no result" }
        : { kind: "ended", status, reason, code };
    }

    applyDecision(record, decision);

    const delay =
      decision.retryInMs ??
      timing.pollMs ??
      pollDelayMs({
        ageMs: Date.now() - record.createdAt,
        pollIntervalMs: record.pollIntervalMs,
        background: false,
        ownerOnly: record.status === "input_required",
        stdio: record.transport === "stdio",
        jitter: Math.random(),
      });

    await sleepUntil(Math.min(delay, Math.max(0, deadline - Date.now())), signal);
  }
};
