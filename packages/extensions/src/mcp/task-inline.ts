// @effect-diagnostics missingPipeableSignature:off asyncFunction:off globalRandom:off -- pi-durable's tool seam is Promise-based.
// An agent's call that the server answered with an MCP task (`docs/architecture/mcp-server-requests.md` → MCP tasks, The
// inline window): the call waits for the task, polling in memory, for `min(timeout, 10 min)` from its creation, then
// returns the result as a synchronous call would; a task still going at the window's end, or when the owner steers, is
// detached: the call returns a handle, and a follower goes on (`./task-follow.ts`). The record (`./task-state.ts`) is the
// source of truth for where the task stands, written in the commit that makes each move: a rerun after a restart finds
// it by the call's id, and the markers `mcp.task` and `mcp.detached` mirror it. A `tools/call` is never sent again.
import type { McpHostTaskStarted } from "@cloudpid/mcp/types";
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import type { McpHostClientService } from "./client.ts";
import type { McpDetails } from "./details.ts";
import type { Caller, McpCallOrigin } from "./exchange.ts";
import { failedWith } from "./result.ts";
import { spillTo } from "./spill.ts";
import type { McpTaskFollower } from "./task-follow.ts";
import { cancelDue, pollOnce, sendCancel, sendCancelWithin, taskSpan } from "./task-host.ts";
import { applyDecision, decide, type Decision } from "./task-poll.ts";
import { detachedText, pollDelayMs, type PollOutcome } from "./task-policy.ts";
import { type McpTasksOptions, sleepUntilWoken } from "./task-port.ts";
import { endedRecord, endInDoc } from "./task-end.ts";
import {
  completedResult,
  endedResult,
  type McpResultPool,
  type StoredResult,
  taskDetails,
} from "./task-results.ts";
import {
  addTask,
  MCP_TASK_TOOL_NAMES,
  McpTasksDoc,
  type McpTaskDraft,
  type McpTaskEnd,
  type McpTaskRecord,
  taskOfCall,
} from "./task-state.ts";

/** What a call that got a task needs to follow it. */
export type TaskCall = {
  readonly api: ToolExecutionApi;
  readonly context: Context;
  readonly client: McpHostClientService;
  readonly tasks: McpTasksOptions;
  readonly origin: McpCallOrigin;
  readonly follower: McpTaskFollower;
  readonly pool: McpResultPool;
  /** The tool's `details` as every end of its calls starts from. */
  readonly base: McpDetails;
  /** Who the call is for: a script's (`codemode`) gets its value whole, and no handle loaded with it. */
  readonly caller: Caller;
  /** The agent that made the call: `root`, or a subagent's id. */
  readonly agent: string;
};

/** The marker that mirrors the record's creation, and the one that mirrors its detach. */
const TASK = "mcp.task";
const DETACHED = "mcp.detached";

/** The record of `callId`, as the document holds it now. */
export const recordOfCall = async (
  api: ToolExecutionApi,
  context: Context,
  callId: string,
): Promise<McpTaskRecord | undefined> => {
  const doc = await api.snapshot(McpTasksDoc, context);

  return doc === undefined ? undefined : taskOfCall(doc, callId);
};

/** The record `handle` as the document holds it now. */
const reread = async (call: TaskCall, handle: string): Promise<McpTaskRecord | undefined> =>
  (await call.api.snapshot(McpTasksDoc, call.context))?.tasks[handle];

/** What the server told of the task its `tools/call` started, and the call's own facts, as the record's first state. */
export type TaskStart = {
  readonly server: string;
  readonly tool: string;
  readonly modelTool: string;
  readonly windowMs: number;
  readonly source?: McpTaskDraft["source"];
  /** `stdio`, with the Workspace whose Container runs the server; absent for an HTTP server's. */
  readonly transport?: "stdio";
  readonly workspace?: string;
};

/**
 * Store the record of the task `started` made, in one commit keyed by the call, so a rerun finds the one it wrote, then
 * mirror it in `mcp.task`. A call that already has a record keeps it.
 */
export const startTask = async (
  call: TaskCall,
  started: McpHostTaskStarted,
  start: TaskStart,
): Promise<McpTaskRecord> => {
  const { api, context } = call;
  const { task } = started;

  const draft: McpTaskDraft = {
    taskId: task.taskId,
    server: start.server,
    tool: start.tool,
    modelTool: start.modelTool,
    conn: started.conn,
    transport: start.transport ?? "http",
    conversation: api.conversationId,
    agent: call.agent,
    callId: api.callId,
    callTask: api.taskId,
    windowMs: start.windowMs,
    createdAt: api.now(),
    ttlMs: task.ttlMs,
    status: task.status,
  };

  if (call.caller === "script") draft.nested = true;

  if (start.workspace !== undefined) draft.workspace = start.workspace;

  if (started.spawn !== undefined) draft.spawn = started.spawn;

  if (started.identity !== undefined) draft.identity = started.identity;

  if (started.signIn !== undefined) draft.signIn = started.signIn;

  if (start.source !== undefined) draft.source = start.source;

  if (task.pollIntervalMs !== undefined) draft.pollIntervalMs = task.pollIntervalMs;

  if (task.statusMessage !== undefined) draft.statusMessage = task.statusMessage;

  let handle: string;

  try {
    handle = await api.commit(async (tx) => {
      const doc = await tx.doc(McpTasksDoc);

      return taskOfCall(doc, api.callId)?.handle ?? addTask(doc, draft).handle;
    }, context);
  } catch (error) {
    // A Session a code update replaced cannot store the record (`docs/architecture/mcp-server-requests.md` → MCP tasks, A
    // replaced Session): nothing will follow the task, so it is cancelled with the id this call holds in memory, once and
    // best effort. If that fails too, the server's TTL ends it.
    await cancelUnrecorded(call, draft);

    throw error;
  }

  await api.memo(TASK, handle, context);

  const record = await reread(call, handle);

  if (record === undefined) throw new Error("The MCP task's record was not stored");

  return record;
};

/** `tasks/cancel` of a task whose record could not be stored, with what the call holds of it; never fails. */
const cancelUnrecorded = async (call: TaskCall, draft: McpTaskDraft): Promise<void> => {
  try {
    await sendCancelWithin(call.client, { ...draft, handle: draft.callId }, call.origin);
  } catch {
    // Best effort: the task is orphaned until the server's TTL.
  }
};

/** What the model reads when the call goes on without waiting: the handle and the three tools, loaded with it. */
export const detachedResult = (record: McpTaskRecord, base: McpDetails): StoredResult => {
  const text = detachedText(record);
  const details = taskDetails(record, base, true);

  // A script's call gets an error value that names the handle (it resolves, as an MCP tool's `isError` result does), and
  // pi-durable applies no `control` of a nested call.
  if (record.nested === true) {
    return {
      output: [{ type: "text", text }],
      isError: true,
      details: { ...details, error: "mcp_task_background" },
      structuredOutput: { content: [{ type: "text", text }], isError: true },
    };
  }

  return {
    output: [{ type: "text", text }],
    details,
    structuredOutput: { content: [] },
    control: { addTools: [...MCP_TASK_TOOL_NAMES] },
  };
};

/** Move the call's task to the background: the record, and the follower that owns the rest, in one commit. */
const detach = async (call: TaskCall, record: McpTaskRecord): Promise<StoredResult> => {
  const { api, context } = call;

  await api.commit(async (tx) => {
    const doc = await tx.doc(McpTasksDoc);
    const current = doc.tasks[record.handle];

    if (current === undefined || current.end !== undefined || current.background) return;

    current.background = true;
    current.detachedAt = api.now();
    current.nextPollAt = api.now();
    current.follower = await tx.createTask(
      call.follower,
      { handle: record.handle },
      { ownership: { kind: "conversation" }, conversationId: api.conversationId, background: true },
    );
  }, context);

  await api.memo(DETACHED, record.handle, context);

  const detached = (await reread(call, record.handle)) ?? record;

  return detachedResult(detached, call.base);
};

/** Commit `decision` to the record, or only to the copy in memory when nothing it holds changed. */
const settle = async (
  call: TaskCall,
  record: McpTaskRecord,
  decision: Decision,
): Promise<McpTaskRecord> => {
  const same = record.failures.count === decision.failures.count;

  if (!decision.changed && same) {
    const copy = structuredClone(record);

    applyDecision(copy, decision);

    return copy;
  }

  await call.api.commit(async (tx) => {
    const doc = await tx.doc(McpTasksDoc);
    const current = doc.tasks[record.handle];

    if (current !== undefined && current.end === undefined) applyDecision(current, decision);
  }, call.context);

  return (await reread(call, record.handle)) ?? record;
};

/**
 * End the task inline: the result is converted and pooled before the record is, so a rerun that finds the record ended
 * finds the result too, and the call returns it as a synchronous call would.
 */
const finish = async (
  call: TaskCall,
  record: McpTaskRecord,
  end: NonNullable<Decision["end"]>,
  outcome: PollOutcome | undefined,
  decision: Decision,
): Promise<StoredResult> => {
  const { api, context } = call;
  const now = api.now();
  const closed: McpTaskEnd = { ...end, at: now };
  const ended = endedRecord(record, closed, { decision });

  if (decision.cancel === true) await sendCancel(call.client, record, call.origin);

  const result =
    end.status === "completed" && outcome?.kind === "state"
      ? await completedResult(
          ended,
          outcome.result,
          {
            spill: spillTo(api.env, context),
            signal: context.abortSignal,
            script: call.caller === "script",
          },
          false,
          call.base,
        )
      : endedResult(ended, false, call.base);

  const note = call.pool.put(record.handle, result, now);

  await api.commit(async (tx) => {
    endInDoc(await tx.doc(McpTasksDoc), record.handle, closed, {
      decision,
      note,
      delivery: "none",
    });
  }, context);

  await taskSpan(ended);

  return result;
};

/**
 * Stop ended the call: the record says Stop did it, and the task is cancelled. The cancel is sent once and not waited for
 * longer than the bound (`sendCancelWithin`), so a server that never answers holds nothing back; the end is written beside
 * it, and a Stop that ended the call's invocation first leaves the record to the sweep (`./task-sweep.ts`), which does not
 * send the cancel again.
 */
const stopped = async (call: TaskCall, record: McpTaskRecord): Promise<StoredResult> => {
  const decision: Decision = { patch: {}, failures: record.failures, changed: true };

  const sending = cancelDue(call.client, record)
    ? sendCancelWithin(call.client, record, call.origin)
    : Promise.resolve(false);

  try {
    await finish(call, record, { status: "cancelled", by: "stop" }, undefined, decision);
  } catch {
    // The invocation ended with the Stop: nothing can be written by it, and the sweep ends the record.
  }

  await sending;

  return failedWith(
    `The call was stopped, and its MCP task ${record.handle} was cancelled.`,
    taskDetails(record, call.base, false),
  );
};

/**
 * Wait for the task the call started: poll until it ends or the window's end (`record.windowMs` from its creation) or the
 * owner steers, then detach. A record that was already detached, or ended, by an earlier instance of the call answers as
 * it left it.
 */
export const followInline = async (call: TaskCall, first: McpTaskRecord): Promise<StoredResult> => {
  const { api, context } = call;
  const timing = call.tasks.timing ?? {};
  const stop = context.abortSignal;
  let record = first;
  const stoppedNow = () => stop?.aborted === true;

  if (record.background) return detachedResult(record, call.base);

  if (record.end !== undefined) {
    return (
      call.pool.get(record.handle, api.now()) ??
      failedWith(
        `${record.server}'s MCP task ${record.handle} ended while the call was interrupted, and its result was not kept.`,
        taskDetails(record, call.base, false),
      )
    );
  }

  const deadline = record.createdAt + record.windowMs;

  for (;;) {
    if (stoppedNow()) return stopped(call, record);

    if (api.now() >= deadline) return detach(call, record);

    const outcome = await pollOnce(call.client, call.origin, record, stop, call.tasks.redact);

    if (stoppedNow()) return stopped(call, record);

    const decision = decide(record, outcome, api.now(), timing);

    if (decision.end !== undefined) return finish(call, record, decision.end, outcome, decision);

    record = await settle(call, record, decision);

    const delay =
      decision.retryInMs ??
      timing.pollMs ??
      pollDelayMs({
        ageMs: api.now() - record.createdAt,
        pollIntervalMs: record.pollIntervalMs,
        background: false,
        ownerOnly: record.status === "input_required",
        stdio: record.transport === "stdio",
        jitter: Math.random(),
      });

    const woke = await sleepUntilWoken(
      api,
      api.conversationId,
      context,
      Math.min(delay, Math.max(0, deadline - api.now())),
      stop,
    );

    if (woke === "steered") return detach(call, record);
  }
};
