// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- helpers for pi-durable commit callbacks.
// The Session's MCP tasks, as one Session document, `cloudpid.mcp-tasks` (`docs/architecture/mcp-server-requests.md` →
// MCP tasks, The record): every live MCP task a root conversation's agent started and the last few that ended. The inline
// window and the follower write it in the commits that move a task along, so the record is the source of truth for
// where a task stands, and the markers (`mcp.task`, `mcp.detached`) only mirror it. The server's `taskId` lives here and
// in the follower's input, never in anything a model, a client, a log or a span is given: only the handle
// (`mcp-task-<n>`, cloudpid's own) leaves this file.
import type { JsonValue } from "@earendil-works/chord/json";
import {
  type ConversationId,
  defineDoc,
  type JsonObject,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

/** The Session document's kind. */
export const MCP_TASKS_KIND = "cloudpid.mcp-tasks";

/** The follower task's name: one per MCP task that went on in the background. */
export const MCP_TASK_FOLLOWER = "cloudpid.mcp-task";

/** The entry that says a background MCP task ended; it carries cloudpid's header only, never the server's text. */
export const MCP_TASK_ENDED_KIND = "cloudpid.mcp-task-ended";

/** The model-visible note that an end the owner caused happened; it starts no Run. */
export const MCP_TASK_NOTICE_KIND = "cloudpid.mcp-task-notice";

/** The tools that act on a conversation's MCP tasks, deferred until its first detach. */
export const MCP_TASK_TOOL_NAMES = ["mcp_tasks", "mcp_task_wait", "mcp_task_cancel"] as const;

/** The most live MCP tasks a Session follows, and the most one server has in it. */
export const MCP_TASKS_PER_SESSION = 16;
export const MCP_TASKS_PER_SERVER = 8;

/** How many ended records the document keeps. */
export const MCP_TASKS_RETAINED = 50;

/**
 * Where a task stands. The server's own five, and two cloudpid adds when it can no longer follow: `unknown` (the server
 * does not know it, or cannot be reached any more) and `stopped` (cloudpid stopped following: the server's identity
 * changed, or it was 7 days).
 */
export type McpTaskState =
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown"
  | "stopped";

/** Whether a state is an end. */
export const isEnded = (status: McpTaskState): boolean =>
  status !== "working" && status !== "input_required";

/** Who ended a task or asked for it to end. */
export type McpTaskBy = "server" | "owner" | "agent" | "stop" | "cloudpid";

/** How a task ended: when, in which state, who caused it and, for an end cloudpid reports, why. */
export type McpTaskEnd = {
  at: number;
  status: McpTaskState;
  by: McpTaskBy;
  /** cloudpid's reason for `unknown` and `stopped`, and the server's `error.message` for `failed` (redacted, bounded). */
  reason?: string;
  /** The server's error code of a `failed` task. */
  code?: number;
  /** The `details.error` the task's result carries instead of the status's own: `sampling_refused` for a refused Sampling request. */
  error?: "sampling_refused";
};

/** A `tasks/cancel` asked for, and whether it reached the server. */
export type McpTaskCancel = {
  at: number;
  by: McpTaskBy;
  sent: "sending" | "sent" | "failed";
  /** Why cloudpid cancelled (`by: "cloudpid"`): a refused Sampling request, a question it could not take. Becomes the end's reason. */
  reason?: string;
  /** The `details.error` the end carries (`McpTaskEnd.error`). */
  error?: "sampling_refused";
};

/** Where one question of a task stands, by the server's key: its answer is on its way to the server, or was taken. */
export type McpTaskQuestionState = "sending" | "sent";

/**
 * What a task's questions have come to (`docs/architecture/mcp-server-requests.md` → MCP tasks, Questions in a task): the
 * rounds asked, what was asked toward the caps, and each key whose answer was sent (or is being). A key that is here is
 * never asked again; the waiting questions themselves are in the Session's question storage, under the task's key
 * (`taskOwner`).
 */
export type McpTaskQuestions = {
  /** The rounds of questions the task has asked. */
  round: number;
  /** Forms and pages asked toward the cap of `MCP_ELICITATIONS_PER_CALL`, and Sampling requests toward `MCP_SAMPLINGS_PER_CALL`. */
  count: number;
  sampled: number;
  /** The newest `MCP_TASK_QUESTION_KEYS` keys, with when the answer was sent. */
  keys: { [key: string]: { state: McpTaskQuestionState; at: number } };
  /** The server kept the task waiting on a key whose answer was sent for 10 minutes: its status says so. */
  stuck?: boolean;
  /** How many times the update being sent has been sent: it is sent again once (`MCP_TASK_UPDATE_SENDS`), then the task ends. */
  tries?: number;
  /**
   * What cloudpid answered itself (Roots, a form declined unseen, a request past a cap, an allowed Sampling reply) and is
   * sending with no round stored, so a send that is lost can be sent again. Never the owner's content: that stays sealed in
   * its round until the server took it.
   */
  pending?: { [key: string]: { [name: string]: JsonValue } };
};

/** The most keys a task's record remembers; the oldest go first. */
export const MCP_TASK_QUESTION_KEYS = 200;

/** What the result pool holds of a task's result: the key, and what the ended entry's header says of it. */
export type McpTaskResultNote = {
  key: string;
  bytes: number;
  images: number;
};

/**
 * How a held result reached the agent: claimed by a waiting `mcp_task_wait`, posted by the follower, or not at all (an
 * end the owner caused). `pending` is a result held until the conversation is idle, which a wait may still claim.
 */
export type McpTaskDelivery = "pending" | "wait" | "auto" | "none";

/** One MCP task. */
export type McpTaskRecord = {
  handle: string;
  /** The server's id for it (at most 1 KiB): a bearer token, so never shown, logged or put in a span. */
  taskId: string;
  server: string;
  /** The server's own name for the tool, which `tasks/get` checks a result against. */
  tool: string;
  /** The model-facing name of the tool (`mcp__<server>__<tool>`). */
  modelTool: string;
  /** The connection key the task was started on, re-pinned when only headers or OAuth changed. */
  conn: string;
  identity?: string;
  source?: { kind: string; slug?: string };
  transport: "http" | "stdio";
  /**
   * A stdio server's task: the Workspace (`ws:<id>`) whose Container runs its process, which `tasks/*` requests go to
   * (never the Session's), and the process's spawn id when the task started: another one is a process that ended.
   */
  workspace?: string;
  spawn?: string;
  /** Made by a `codemode` script's nested call: its end is delivered to the script's conversation like any other. */
  nested?: boolean;
  /** The MCP sign-in id of the token the task was started with. */
  signIn?: string;
  conversation: ConversationId;
  agent: string;
  /** The tool call's id, which the record is looked up by. */
  callId: string;
  /**
   * The pi-durable task of that call, which the sweep asks whether it is live (`./task-sweep.ts`). Absent in a record
   * written before it was kept, which the sweep never touches.
   */
  callTask?: TaskId;
  /**
   * The call was of an App tool (`docs/architecture/mcp-apps.md` → Results): the arguments and parent call its App record is
   * made from when the task completes, so its View gets the result whenever it arrives, in the background too.
   */
  app?: { arguments: JsonObject; parentCall?: string; viewHash?: string };
  /** The server's `timeout` in effect at the call, in ms: the inline window is the smaller of it and 10 minutes. */
  windowMs: number;
  createdAt: number;
  ttlMs: number | null;
  pollIntervalMs?: number;
  status: McpTaskState;
  statusMessage?: string;
  lastPolledAt?: number;
  nextPollAt?: number;
  polls: number;
  /** Failures in a row: how many, since when, and when the `-32602` grace began. */
  failures: { count: number; since?: number; unknownSince?: number };
  /** Pinned to a new connection key after `ServerChanged`: a `-32602` or a 401 from then on is `unknown` at once. */
  repinned?: boolean;
  /**
   * An `mcp_task_wait` that waits for the task now (its call's pi-durable task), which claims the result when it ends; at
   * most one.
   */
  waiter?: TaskId;
  background: boolean;
  detachedAt?: number;
  /** The follower, once there is one. */
  follower?: TaskId;
  delivery: McpTaskDelivery | null;
  /** When the agent was told of the end: its `mcp_task_wait` claimed the result, or the follower posted the end. */
  toldAt?: number;
  cancel?: McpTaskCancel;
  end?: McpTaskEnd;
  result?: McpTaskResultNote;
  /** What its questions have come to, once it asked any. */
  questions?: McpTaskQuestions;
};

export type McpTasksState = {
  next: number;
  tasks: Record<string, McpTaskRecord>;
  /** The handles of ended tasks, oldest first. */
  recent: string[];
};

export const McpTasksDoc = defineDoc<McpTasksState>({
  kind: MCP_TASKS_KIND,
  version: 1,
  scope: "session",
  initial: () => ({ next: 1, tasks: {}, recent: [] }),
  checkpointWhen: () => false,
});

/** The state as read outside a commit: the initial one until the first task. */
export const EMPTY_TASKS: McpTasksState = McpTasksDoc.definition.initial();

/** A handle for task number `n`. */
export const handleOf = (n: number): string => `mcp-task-${n}`;

/**
 * What a record's status line says: the server's own, or, once it kept a task waiting 10 minutes after the answers were
 * sent, that it is slow to take them (`McpTaskQuestions.stuck`).
 */
export const shownStatusMessage = (record: McpTaskRecord): string | undefined =>
  record.questions?.stuck === true && record.status === "input_required" && record.end === undefined
    ? `waiting for ${record.server} to take your answer`
    : record.statusMessage;

/**
 * How a task that has not ended stands, for the agent: working, waiting for the owner's answer to its questions, or, once
 * the answer was sent and the server kept it waiting, waiting for the server to take it (`McpTaskQuestions.stuck`).
 */
export const standingOf = (record: McpTaskRecord): string =>
  record.status !== "input_required"
    ? "working"
    : record.questions?.stuck === true
      ? `waiting for ${record.server} to take the owner's answer`
      : "waiting for the owner";

/** The live records, oldest first. */
export const liveTasks = (state: McpTasksState): ReadonlyArray<McpTaskRecord> =>
  Arr.filter(Record.values(state.tasks), (task) => task.end === undefined);

/** The record the call `callId` made, if one was written. */
export const taskOfCall = (state: McpTasksState, callId: string): McpTaskRecord | undefined =>
  Option.getOrUndefined(
    Arr.findFirst(Record.values(state.tasks), (task) => task.callId === callId),
  );

/** The server of each live task, one entry each: what the caps are counted over. */
export const serversOfLive = (state: McpTasksState): ReadonlyArray<string> =>
  Arr.map(liveTasks(state), (task) => task.server);

/** Whether live tasks of `servers` (one entry each) are at a cap for a new one of `server`: 16 in all, 8 of the one. */
export const atCapOf = (servers: ReadonlyArray<string>, server: string): boolean =>
  servers.length >= MCP_TASKS_PER_SESSION ||
  Arr.filter(servers, (each) => each === server).length >= MCP_TASKS_PER_SERVER;

/** Why a call goes out without offering a task: the Session or the server is at its cap (the agent's tasks alone). */
export const atCap = (state: McpTasksState, server: string): boolean =>
  atCapOf(serversOfLive(state), server);

/** What a record starts from, as the call that got the task writes it. */
export type McpTaskDraft = Omit<
  McpTaskRecord,
  "handle" | "status" | "polls" | "failures" | "background" | "delivery"
> & { status: McpTaskState };

/**
 * Add a record for a task the call got, in the commit that stores it: numbered from the document's counter, so a handle is
 * never given out twice. Returns the record as stored.
 */
export const addTask = (doc: McpTasksState, draft: McpTaskDraft): McpTaskRecord => {
  const handle = handleOf(doc.next);

  doc.next += 1;

  const record: McpTaskRecord = {
    ...draft,
    handle,
    polls: 0,
    failures: { count: 0 },
    background: false,
    delivery: null,
  };

  doc.tasks[handle] = record;

  return record;
};

/** Mark `handle` ended, keeping only the newest `MCP_TASKS_RETAINED` ended records. A second end changes nothing. */
export const endTask = (
  doc: McpTasksState,
  handle: string,
  end: McpTaskEnd,
): McpTaskRecord | undefined => {
  const record = doc.tasks[handle];

  if (record === undefined || record.end !== undefined) return undefined;

  record.end = end;
  record.status = end.status;
  delete record.nextPollAt;
  doc.recent.push(handle);

  const surplus = doc.recent.length - MCP_TASKS_RETAINED;

  if (surplus > 0) {
    for (const old of doc.recent.splice(0, surplus)) delete doc.tasks[old];
  }

  return record;
};

/** The document as a commit writes it. */
export const tasksDoc = (tx: Tx) => tx.doc(McpTasksDoc);
