// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- pi-durable's task seam is Promise-based.
// What the inline window and the follower ask the host of an MCP task (`docs/architecture/mcp-server-requests.md` → MCP
// tasks): one `tasks/get`, one `tasks/cancel` (sent again once when it did not take), and the Session-side `mcp.task` span
// of a task that ended: its server, tool, origin, where it ended, polls counted at each written change, failures, who
// cancelled, outcome and duration; never the server's `taskId`, its `statusMessage` or a result.
import * as Effect from "effect/Effect";
import type { McpHostClientService } from "./client.ts";
import type { McpCallOrigin } from "./exchange.ts";
import { cancelTook, taskCancel, taskGet } from "./task-poll.ts";
import { readPoll, type PollOutcome } from "./task-policy.ts";
import { abortedBy, taskContext } from "./task-port.ts";
import type { McpTaskRecord } from "./task-state.ts";

/** One `tasks/get` of `record`, which `stop` ends: what it came to. */
export const pollOnce = async (
  client: McpHostClientService,
  origin: McpCallOrigin,
  record: McpTaskRecord,
  stop: AbortSignal | undefined,
): Promise<PollOutcome> => {
  const request = taskGet(record, taskContext(origin, record));

  const answer = await Effect.runPromise(
    client.request(request, { untilAborted: () => abortedBy(stop === undefined ? [] : [stop]) }),
  );

  return readPoll(answer);
};

/** `tasks/cancel` of `record`, once and once more when it did not take: whether the server took it. */
export const sendCancel = async (
  client: McpHostClientService,
  record: McpTaskRecord,
  origin: McpCallOrigin,
): Promise<boolean> => {
  const request = taskCancel(record, taskContext(origin, record));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const answer = await Effect.runPromise(client.request(request, {}));

    if (cancelTook(answer)) return true;
  }

  return false;
};

/** The span of a task that ended, emitted once with what it came to. */
export const taskSpan = (record: McpTaskRecord): Promise<void> =>
  Effect.runPromise(
    Effect.void.pipe(
      Effect.withSpan("mcp.task", {
        attributes: {
          "mcp.server": record.server,
          "mcp.tool": record.modelTool,
          "mcp.origin": "agent",
          "mcp.task.mode": record.background ? "background" : "inline",
          "mcp.task.polls": record.polls,
          "mcp.task.failures": record.failures.count,
          "mcp.task.cancelled_by": record.cancel?.by ?? record.end?.by ?? "none",
          "mcp.task.outcome": record.end?.status ?? record.status,
          "mcp.task.duration_ms": (record.end?.at ?? record.createdAt) - record.createdAt,
        },
      }),
    ),
  );
