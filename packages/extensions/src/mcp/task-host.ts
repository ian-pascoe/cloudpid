// @effect-diagnostics missingPipeableSignature:off asyncFunction:off newPromise:off globalTimers:off -- pi-durable's task seam is Promise-based.
// What the inline window and the follower ask the host of an MCP task (`docs/architecture/mcp-server-requests.md` → MCP
// tasks): one `tasks/get`, one `tasks/cancel` (sent once: the wire resends a cut), and the Session-side `mcp.task` span
// of a task that ended: its server, tool, origin, where it ended, polls counted at each written change, failures, who
// cancelled, outcome and duration; never the server's `taskId`, its `statusMessage` or a result.
import * as Effect from "effect/Effect";
import type { McpTaskSnapshot } from "@cloudpid/mcp/types";
import type { McpHostClientService } from "./client.ts";
import type { McpCallOrigin } from "./exchange.ts";
import { cancelTook, taskCancel, taskGet } from "./task-poll.ts";
import {
  MCP_TASK_CANCEL_SENDING_MS,
  MCP_TASK_STOP_CANCEL_MS,
  readPoll,
  type PollOutcome,
} from "./task-policy.ts";
import { abortedBy, type McpTasksOptions, taskContext } from "./task-port.ts";
import type { McpTaskRecord } from "./task-state.ts";

/**
 * One `tasks/get` of `record`, which `stop` ends: what it came to. A status line and a `failed` task's message are
 * redacted of the Session's held Secrets (`redact`) before anything stores or shows them.
 */
export const pollOnce = async (
  client: McpHostClientService,
  origin: McpCallOrigin,
  record: McpTaskRecord,
  stop: AbortSignal | undefined,
  redact: McpTasksOptions["redact"],
): Promise<PollOutcome> => {
  const request = taskGet(record, taskContext(origin, record));

  const answer = await Effect.runPromise(
    client.request(request, { untilAborted: () => abortedBy(stop === undefined ? [] : [stop]) }),
  );

  const outcome = readPoll(answer);

  return outcome.kind === "state" && redact !== undefined
    ? { ...outcome, snapshot: await redactedSnapshot(outcome.snapshot, redact) }
    : outcome;
};

/** `snapshot` with the text the server wrote in it passed through `redact`. */
const redactedSnapshot = async (
  snapshot: McpTaskSnapshot,
  redact: NonNullable<McpTasksOptions["redact"]>,
): Promise<McpTaskSnapshot> => {
  const message =
    snapshot.statusMessage === undefined ? undefined : await redact(snapshot.statusMessage);

  const shown = message === undefined ? snapshot : { ...snapshot, statusMessage: message };

  return shown.status === "failed"
    ? { ...shown, error: { ...shown.error, message: await redact(shown.error.message) } }
    : shown;
};

/** What a `tasks/cancel` is made of: a record, or what a call holds of a task it could not record. */
export type CancelTarget = Pick<
  McpTaskRecord,
  "handle" | "taskId" | "server" | "tool" | "conn" | "callId" | "conversation"
>;

/**
 * `tasks/cancel` of `record`, sent once: whether the server took it. The wire sends it once more itself when it was cut
 * (`docs/architecture/mcp-connections.md` → Requests and Legacy sessions), and any other answer (an error, a refusal) is
 * not asked again.
 */
export const sendCancel = async (
  client: McpHostClientService,
  record: CancelTarget,
  origin: McpCallOrigin,
): Promise<boolean> => {
  attemptsOf(client).add(record.handle);

  return cancelTook(
    await Effect.runPromise(client.request(taskCancel(record, taskContext(origin, record)), {})),
  );
};

/**
 * The handles whose `tasks/cancel` a Session's client has sent, or is sending: it is never sent twice by one instance,
 * whether the first is still out or its call has gone. Kept by the client, so another Session's handles, which repeat
 * (`mcp-task-1`), are never mistaken for these. The rule is therefore once per instance (`cancelDue`).
 */
const attempts = new WeakMap<McpHostClientService, Set<string>>();

const attemptsOf = (client: McpHostClientService): Set<string> => {
  const held = attempts.get(client);

  if (held !== undefined) return held;

  const made = new Set<string>();

  attempts.set(client, made);

  return made;
};

/** Whether `client`'s Session has sent, or is sending, `record`'s `tasks/cancel`. */
export const cancelAttempted = (
  client: McpHostClientService,
  record: Pick<McpTaskRecord, "handle">,
): boolean => attemptsOf(client).has(record.handle);

/**
 * Whether Stop all, Archive, Delete or the sweep still has to send `record`'s `tasks/cancel`. Once per instance: not when
 * one went (`sent`, or `failed`, which is not asked again), nor when this Session's instance has sent one. Another
 * instance's `sending` mark, however fresh, does not stop it: that instance may be gone (a code update replaced it), and a
 * second cancel of a task is harmless where a task nobody cancels runs on for its TTL. After an eviction the new instance
 * may therefore send a cancel the old one had sent.
 */
export const cancelDue = (client: McpHostClientService, record: McpTaskRecord): boolean =>
  !cancelAttempted(client, record) &&
  (record.cancel === undefined || record.cancel.sent === "sending");

/**
 * Whether the follower, left to itself, sends `record`'s cancel again: another instance marked it `sending` and the
 * mark is older than any send of a call that is alive (`MCP_TASK_CANCEL_SENDING_MS`), so the send went with its instance.
 */
export const cancelStale = (
  client: McpHostClientService,
  record: McpTaskRecord,
  now: number,
): boolean =>
  record.cancel?.sent === "sending" &&
  now - record.cancel.at >= MCP_TASK_CANCEL_SENDING_MS &&
  !cancelAttempted(client, record);

/**
 * `sendCancel`, waiting no longer than `ms` for the answer (`MCP_TASK_STOP_CANCEL_MS`): whether the server took it in time.
 * The request is not cut at the bound, only no longer waited for; it never fails.
 */
export const sendCancelWithin = async (
  client: McpHostClientService,
  record: CancelTarget,
  origin: McpCallOrigin,
  ms: number = MCP_TASK_STOP_CANCEL_MS,
): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const bound = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });

  try {
    return await Promise.race([sendCancel(client, record, origin).catch(() => false), bound]);
  } finally {
    clearTimeout(timer);
  }
};

/** What the `mcp.task` span says of a task that ended: never its `taskId`, `statusMessage` or a result. */
export const taskAttributes = (record: McpTaskRecord) => ({
  "mcp.server": record.server,
  "mcp.tool": record.modelTool,
  "mcp.origin": "agent",
  "mcp.task.mode": record.background ? "background" : "inline",
  "mcp.task.polls": record.polls,
  "mcp.task.failures": record.failures.count,
  // Only a cancel has a canceller: a task the server cancelled itself names the server, one that completed, none.
  "mcp.task.cancelled_by":
    record.cancel?.by ?? (record.end?.status === "cancelled" ? record.end.by : "none"),
  "mcp.task.outcome": record.end?.status ?? record.status,
  "mcp.task.duration_ms": (record.end?.at ?? record.createdAt) - record.createdAt,
});

/** The span of a task that ended, emitted once with what it came to. */
export const taskSpan = (record: McpTaskRecord): Promise<void> =>
  Effect.runPromise(
    Effect.void.pipe(Effect.withSpan("mcp.task", { attributes: taskAttributes(record) })),
  );
