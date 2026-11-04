// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- plain Promise code over pi-durable's commits.
// What the owner does with the Session's MCP tasks from a client (`docs/architecture/mcp-server-requests.md` → MCP tasks,
// Cancellation): the list the socket sends (`mcp_tasks`, never carrying the server's task id), a cancel the owner asks for,
// which is the agent's `mcp_task_cancel` with the owner as the canceller, and Keep the Container of a stdio server's task.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { McpTask } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import type { Mutable } from "effect/Types";
import type { McpHostClientService } from "./client.ts";
import type { McpCallOrigin } from "./exchange.ts";
import { markCancelSent } from "./task-end.ts";
import { sendCancel } from "./task-host.ts";
import {
  type McpTaskBy,
  McpTasksDoc,
  type McpTaskRecord,
  type McpTasksState,
} from "./task-state.ts";

const context = BACKGROUND_CONTEXT;

/** What a commit of the Session's Harness is given to write. */
type OwnerWrite = Parameters<Harness["commit"]>[0];

/** What the owner's cancel and Keep read and write of the Session's Harness. */
export type TaskOwnerHarness = Pick<Harness, "snapshot" | "commit">;

/** The list a client is sent of `state`: every record, oldest first, as the protocol has it. Never the server's task id. */
export const viewOfTasks = (state: McpTasksState | undefined | null): ReadonlyArray<McpTask> =>
  Arr.map(
    Arr.sort(
      Record.values(state?.tasks ?? {}),
      Order.mapInput(Order.Number, (record: McpTaskRecord) => record.createdAt),
    ),
    (record): McpTask => {
      const view: Mutable<McpTask> = {
        task: record.handle,
        server: record.server,
        tool: record.modelTool,
        status: record.end?.status ?? record.status,
        background: record.background,
        callId: record.callId,
        conversationId: record.conversation,
        startedAt: record.createdAt,
      };

      if (record.statusMessage !== undefined) view.statusMessage = record.statusMessage;

      if (record.transport === "stdio") view.stdio = true;

      if (record.agent !== "root") view.agent = record.agent;

      if (record.end !== undefined) {
        view.endedAt = record.end.at;
        const end: Mutable<NonNullable<McpTask["end"]>> = { by: record.end.by };

        if (record.end.reason !== undefined) end.reason = record.end.reason;

        view.end = end;
      } else {
        if (record.ttlMs !== null) view.keptUntil = record.createdAt + record.ttlMs;

        if (record.status === "input_required") view.waitingFor = "owner";

        if (record.cancel !== undefined)
          view.cancel = { by: record.cancel.by, at: record.cancel.at };
      }

      return view;
    },
  );

/** What a cancel the owner asked for came to. */
export type OwnerCancel = "sent" | "already_sent" | "failed" | "ended" | "unknown";

/**
 * Ask the server to cancel the live task `handle`, as `by` (the agent's tool, or the owner): marked before it is sent, so a
 * restart that cut the send sends it once more, and not at all when one was asked for already. The task then ends as the
 * server answers its polls: `cancelled` by `by`, or what it finished as first.
 */
export const requestCancel = async (
  deps: {
    readonly commit: (write: OwnerWrite) => Promise<void>;
    readonly client: McpHostClientService;
    readonly origin: McpCallOrigin;
    readonly now: () => number;
  },
  record: McpTaskRecord,
  by: McpTaskBy,
): Promise<OwnerCancel> => {
  if (record.end !== undefined) return "ended";

  if (record.cancel !== undefined) return "already_sent";

  await deps.commit(async (tx) => {
    const current = (await tx.doc(McpTasksDoc)).tasks[record.handle];

    if (current !== undefined && current.end === undefined && current.cancel === undefined) {
      current.cancel = { at: deps.now(), by, sent: "sending" };
    }
  });

  const took = await sendCancel(deps.client, record, deps.origin);

  await deps.commit(async (tx) => {
    markCancelSent((await tx.doc(McpTasksDoc)).tasks[record.handle], took);
  });

  return took ? "sent" : "failed";
};

/** The owner's cancel of the task `handle` of the Session (`mcp_task_cancel`). */
export const cancelAsOwner = async (
  deps: {
    readonly harness: TaskOwnerHarness;
    readonly client: McpHostClientService;
    readonly origin: McpCallOrigin;
    readonly now: () => number;
  },
  handle: string,
): Promise<OwnerCancel> => {
  const record = (await deps.harness.snapshot(McpTasksDoc, context))?.tasks[handle];

  if (record === undefined) return "unknown";

  return requestCancel(
    {
      commit: async (write) => {
        await deps.harness.commit(write, context);
      },
      client: deps.client,
      origin: deps.origin,
      now: deps.now,
    },
    record,
    "owner",
  );
};

/** What Keep the Container came to. */
export type OwnerKeep = "kept" | "not_stdio" | "ended" | "unknown" | "failed";

/**
 * Keep the Container of the stdio server's live task `handle`: `touch` notes owner activity in the Workspace its record
 * names (`noteSessionActivity`), which resets the hour the Container is held for a task that nothing else keeps awake.
 */
export const keepContainer = async (
  deps: {
    readonly harness: Pick<Harness, "snapshot">;
    readonly touch: (workspace: string) => Promise<void>;
  },
  handle: string,
): Promise<OwnerKeep> => {
  const record = (await deps.harness.snapshot(McpTasksDoc, context))?.tasks[handle];

  if (record === undefined) return "unknown";

  if (record.end !== undefined) return "ended";

  if (record.transport !== "stdio" || record.workspace === undefined) return "not_stdio";

  try {
    await deps.touch(record.workspace);

    return "kept";
  } catch {
    return "failed";
  }
};
