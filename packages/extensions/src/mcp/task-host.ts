// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- pi-durable's task seam is Promise-based.
// What the inline window and the follower ask the host of an MCP task (`docs/architecture/mcp-server-requests.md` → MCP
// tasks): one `tasks/get`, one `tasks/cancel` (sent once: the wire resends a cut), and the Session-side `mcp.task` span
// of a task that ended: its server, tool, origin, where it ended, polls counted at each written change, failures, who
// cancelled, outcome and duration; never the server's `taskId`, its `statusMessage` or a result.
import * as Effect from "effect/Effect";
import type { McpTaskSnapshot } from "@cloudpid/mcp/types";
import type { McpHostClientService } from "./client.ts";
import type { McpCallOrigin } from "./exchange.ts";
import { cancelTook, taskCancel, taskGet } from "./task-poll.ts";
import { readPoll, type PollOutcome } from "./task-policy.ts";
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

/**
 * `tasks/cancel` of `record`, sent once: whether the server took it. The wire sends it once more itself when it was cut
 * (`docs/architecture/mcp-connections.md` → Requests and Legacy sessions), and any other answer (an error, a refusal) is
 * not asked again.
 */
export const sendCancel = async (
  client: McpHostClientService,
  record: McpTaskRecord,
  origin: McpCallOrigin,
): Promise<boolean> =>
  cancelTook(
    await Effect.runPromise(client.request(taskCancel(record, taskContext(origin, record)), {})),
  );

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
