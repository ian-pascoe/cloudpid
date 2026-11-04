// @effect-diagnostics missingPipeableSignature:off asyncFunction:off newPromise:off preferEffectArray:off globalDate:off -- builders over plain values, and pi-durable's Promise-based tool seam.
// The agent's tools for MCP tasks (`docs/architecture/mcp-server-requests.md` → MCP tasks, The agent's tools): `mcp_tasks`
// lists the conversation's own, `mcp_task_wait` waits for one and reads its result, `mcp_task_cancel` stops one. They are
// in the `mcp` extension, deferred, loaded into a conversation at its first detach (the detach result's
// `control.addTools`), callable by the model and by tools, `replay: "safe"`; each conversation acts on its own MCP tasks
// only, and no result here holds the server's task id, only the handle. A wait is the one in-memory wait on an MCP task
// besides the inline window: at most 30 minutes, one open wait per task, its deadline kept in a memo so a rerun after a
// restart waits for what is left; a result it returns is claimed, and the follower never posts it.
import type { JsonObject } from "@cloudpid/mcp/types";
import type { JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TSchema } from "@earendil-works/pi-ai";
import type {
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Record from "effect/Record";
import type { McpHostClientService } from "./client.ts";
import type { McpDetails } from "./details.ts";
import type { McpCallOrigin } from "./exchange.ts";
import { failedWith } from "./result.ts";
import { scriptSchemaOf } from "./schema.ts";
import { requestCancel } from "./task-owner.ts";
import { durationText, MCP_TASK_RESULT_KEPT_MS } from "./task-policy.ts";
import { sleepUntilWoken } from "./task-port.ts";
import { type McpResultPool, type StoredResult } from "./task-results.ts";
import { EMPTY_TASKS, McpTasksDoc, type McpTaskRecord, type McpTasksState } from "./task-state.ts";

/** How long `mcp_task_wait` waits when it is not told: 5 minutes; at most 30. */
const DEFAULT_WAIT_S = 300;
const MAX_WAIT_S = 1800;

const mcpTasksName = "mcp_tasks";
const waitName = "mcp_task_wait";
const cancelName = "mcp_task_cancel";

// SAFETY: object JSON Schemas, which pi-ai's `TSchema` describes (TypeBox's are JSON Schema too).
const LIST_PARAMETERS = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["working", "input_required", "completed", "failed", "cancelled", "unknown", "stopped"],
      description: "Only the MCP tasks in this state.",
    },
  },
  additionalProperties: false,
} as TSchema;

// SAFETY: as `LIST_PARAMETERS`, an object JSON Schema.
const WAIT_PARAMETERS = {
  type: "object",
  properties: {
    task: { type: "string", description: 'The handle, such as "mcp-task-3".' },
    timeout_s: {
      type: "integer",
      minimum: 1,
      maximum: MAX_WAIT_S,
      description: `How long to wait for it to end, in seconds (default ${DEFAULT_WAIT_S}, at most ${MAX_WAIT_S}).`,
    },
  },
  required: ["task"],
  additionalProperties: false,
} as TSchema;

// SAFETY: as `LIST_PARAMETERS`, an object JSON Schema.
const CANCEL_PARAMETERS = {
  type: "object",
  properties: { task: { type: "string", description: 'The handle, such as "mcp-task-3".' } },
  required: ["task"],
  additionalProperties: false,
} as TSchema;

const LIST_OUTPUT = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          task: { type: "string" },
          server: { type: "string" },
          tool: { type: "string" },
          status: { type: "string" },
          status_message: { type: ["string", "null"] },
          started_at: { type: "string" },
          background: { type: "boolean" },
          delivery: { type: ["string", "null"] },
          waiting_for: { type: ["string", "null"] },
          result_kept_until: { type: ["string", "null"] },
        },
        required: ["task", "server", "tool", "status", "started_at", "background"],
      },
    },
  },
  required: ["tasks"],
  additionalProperties: false,
} as const;

const CANCEL_OUTPUT = {
  type: "object",
  properties: { task: { type: "string" }, cancel: { type: "string" } },
  required: ["task", "cancel"],
  additionalProperties: false,
} as const;

const text = (line: string) => [{ type: "text" as const, text: line }];

const detailsFor = (tool: string, record?: McpTaskRecord): McpDetails =>
  record === undefined
    ? { server: "", tool }
    : {
        server: record.server,
        tool,
        mcp_task: { task: record.handle, status: record.end?.status ?? record.status },
      };

/** The records of `conversation` in `state`, oldest first. */
const mineOf = (
  state: McpTasksState | undefined,
  conversation: number,
): ReadonlyArray<McpTaskRecord> =>
  Arr.filter(
    Record.values((state ?? EMPTY_TASKS).tasks),
    (task) => task.conversation === conversation,
  );

/** The record `handle` of `conversation`, if it has one. */
const namedOf = (
  state: McpTasksState | undefined,
  conversation: number,
  handle: string,
): McpTaskRecord | undefined =>
  Option.getOrUndefined(
    Arr.findFirst(mineOf(state, conversation), (each) => each.handle === handle),
  );

/** What a record says of itself in a list. */
const listed = (record: McpTaskRecord, pool: McpResultPool) => {
  const kept = record.result === undefined ? undefined : pool.keptUntil(record.handle);

  return {
    task: record.handle,
    server: record.server,
    tool: record.modelTool,
    status: record.end?.status ?? record.status,
    status_message: record.statusMessage ?? null,
    started_at: new Date(record.createdAt).toISOString(),
    background: record.background,
    delivery: record.delivery,
    waiting_for: record.status === "input_required" && record.end === undefined ? "owner" : null,
    result_kept_until: kept === undefined ? null : new Date(kept).toISOString(),
  };
};

/** The one line of a listed task. */
const lineOf = (task: ReturnType<typeof listed>, now: number): string =>
  `${task.task} · ${task.server} · ${task.tool} · ${task.status}${
    task.status_message === null ? "" : ` (${task.status_message})`
  } · ${durationText(now - Date.parse(task.started_at))} ago${task.waiting_for === null ? "" : " · waiting for the owner"}${
    task.result_kept_until === null
      ? ""
      : ` · result kept until ${task.result_kept_until.slice(0, 10)}`
  }`;

const Args = Schema.Struct({
  task: Schema.optionalKey(Schema.String),
  timeout_s: Schema.optionalKey(Schema.Finite),
  status: Schema.optionalKey(Schema.String),
});

const decodeArgs = Schema.decodeUnknownOption(Args);

/** The call's arguments, as far as they are readable: pi-durable has checked them against the tool's parameters. */
const argsOf = (args: JsonObject): typeof Args.Type =>
  Option.getOrElse(decodeArgs(args), () => ({}));

/** The tools, over the Session's host client, origin, options and pool. */
export const taskTools = (
  client: McpHostClientService,
  origin: McpCallOrigin,
  pool: McpResultPool,
): ReadonlyArray<ToolRegistration> => {
  const unknown = (tool: string, handle: string): ToolExecutionResult<JsonValue> =>
    failedWith(
      `You have no MCP task ${handle === "" ? "of that name" : `"${handle}"`}. mcp_tasks lists yours.`,
      detailsFor(tool),
    );

  const lister: ToolRegistration = {
    name: mcpTasksName,
    description:
      "List your MCP tasks: the background work an MCP server's tool went on with after its call returned, with each one's state, when it started and when its result is kept until. Pass status to list only the ones in that state.",
    parameters: LIST_PARAMETERS,
    structuredOutputSchema: LIST_OUTPUT,
    replay: "safe",
    deferred: true,
    execute: async (args, api, context) => {
      const state = await api.snapshot(McpTasksDoc, context);
      // SAFETY: the arguments pi-durable validated against the tool's parameters, an object.
      const input = argsOf(args as JsonObject);
      const status = input.status;
      const now = api.now();

      const found = Arr.map(
        Arr.filter(
          mineOf(state, api.conversationId),
          (record) => status === undefined || (record.end?.status ?? record.status) === status,
        ),
        (record) => listed(record, pool),
      );

      return {
        output: text(
          found.length === 0
            ? "You have no MCP tasks."
            : Arr.join(
                Arr.map(found, (task) => lineOf(task, now)),
                "\n",
              ),
        ),
        details: detailsFor(mcpTasksName),
        structuredOutput: { tasks: found },
      };
    },
  };

  /** Stop the wait's claim on the task, whatever ended it. */
  const release = (api: ToolExecutionApi, handle: string) =>
    api
      .commit(async (tx) => {
        const current = (await tx.doc(McpTasksDoc)).tasks[handle];

        if (current?.waiter === api.taskId) delete current.waiter;
      }, BACKGROUND_CONTEXT)
      .catch(() => undefined);

  /** The result of an ended task, claimed so the follower never posts it. */
  const claimed = async (
    api: ToolExecutionApi,
    context: ToolContext,
    record: McpTaskRecord,
  ): Promise<ToolExecutionResult<JsonValue>> => {
    await api.commit(async (tx) => {
      const current = (await tx.doc(McpTasksDoc)).tasks[record.handle];

      if (current?.delivery === "pending") {
        current.delivery = "wait";
        current.toldAt = api.now();
      }

      if (current?.waiter === api.taskId) delete current.waiter;
    }, context);

    return (
      pool.get(record.handle, api.now()) ??
      failedWith(
        `${record.server}'s MCP task ${record.handle} ended (${record.end?.status ?? record.status}), but its result is no longer kept: results are kept ${durationText(MCP_TASK_RESULT_KEPT_MS)} after the end, within 16 MiB.`,
        detailsFor(waitName, record),
      )
    );
  };

  /**
   * Take the one open wait of `handle` for this call: `busy` while another call's wait lives, `ended` when the task has
   * ended meanwhile (its result is read at once), else `waiting`.
   */
  const takeWait = (api: ToolExecutionApi, context: ToolContext, handle: string) =>
    api.commit(async (tx) => {
      const current = (await tx.doc(McpTasksDoc)).tasks[handle];

      if (current === undefined || current.end !== undefined) return "ended" as const;

      const other =
        current.waiter === undefined || current.waiter === api.taskId
          ? undefined
          : await tx.task(current.waiter);

      // One open wait per task: another call's, while it lives.
      if (other !== undefined && other.state.status !== "terminal") return "busy" as const;

      current.waiter = api.taskId;

      return "waiting" as const;
    }, context);

  /** How a task that has not ended stands, for a wait that stopped before it did. */
  const standing = (record: McpTaskRecord) =>
    record.status === "input_required" ? "waiting for input" : "working";

  /**
   * Wait for `handle` to end, until `until`: its result when it ends, where it stands when the time runs out or the owner
   * sends a message, an error when the wait is stopped.
   */
  const awaitEnd = async (
    api: ToolExecutionApi,
    context: ToolContext,
    handle: string,
    until: number,
    seconds: number,
  ): Promise<ToolExecutionResult<JsonValue>> => {
    for (;;) {
      const fresh = (await api.snapshot(McpTasksDoc, context))?.tasks[handle];

      if (fresh === undefined) return unknown(waitName, handle);

      if (fresh.end !== undefined) return claimed(api, context, fresh);

      const left = until - api.now();

      if (left <= 0) {
        return {
          output: text(
            `MCP task ${handle} is still ${standing(fresh)} after ${durationText(seconds * 1000)}. Wait again with mcp_task_wait, or stop it with mcp_task_cancel.`,
          ),
          details: detailsFor(waitName, fresh),
          structuredOutput: { content: [] },
        };
      }

      const watch = await api.watchDoc(McpTasksDoc, context);
      let woke;

      try {
        woke = await sleepUntilWoken(
          api,
          api.conversationId,
          context,
          left,
          context.abortSignal,
          new Promise<void>((resolve) => {
            watch?.start(() => {
              if (watch.value?.tasks[handle]?.end !== undefined) resolve();

              return Promise.resolve();
            });
          }),
        );
      } finally {
        await watch?.stop();
      }

      if (woke === "steered") {
        return {
          output: text(
            `Stopped waiting for MCP task ${handle}: a message arrived. It is still ${standing(fresh)}; wait again with mcp_task_wait when you want.`,
          ),
          details: detailsFor(waitName, fresh),
          structuredOutput: { content: [] },
        };
      }

      if (woke === "stopped")
        return failedWith("The wait was stopped", detailsFor(waitName, fresh));
    }
  };

  const waiter: ToolRegistration = {
    name: waitName,
    description:
      "Wait for an MCP task to end and read its result, as the result of the call that started it would have been. An ended task returns at once, as often as you ask while its result is kept. A task still going when the time runs out, or when the owner sends you a message, returns where it stands; ask again or use mcp_task_cancel. One wait at a time per task.",
    parameters: WAIT_PARAMETERS,
    structuredOutputSchema: scriptSchemaOf(undefined),
    replay: "safe",
    deferred: true,
    execute: async (args, api, context) => {
      // SAFETY: the arguments pi-durable validated against the tool's parameters, an object.
      const input = argsOf(args as JsonObject);
      const handle = (input.task ?? "").trim();
      const record = namedOf(await api.snapshot(McpTasksDoc, context), api.conversationId, handle);

      if (record === undefined) return unknown(waitName, handle);

      if (record.end !== undefined) return claimed(api, context, record);

      const seconds =
        input.timeout_s === undefined
          ? DEFAULT_WAIT_S
          : Math.min(Math.max(Math.floor(input.timeout_s), 1), MAX_WAIT_S);

      // The deadline is kept, so a rerun after a restart waits for what is left.
      const until = await api.memo<number>("mcp.wait.until", api.now() + seconds * 1000, context);

      if ((await takeWait(api, context, handle)) === "busy") {
        return failedWith(
          `Another call is already waiting for MCP task ${handle}. One wait at a time per task.`,
          detailsFor(waitName, record),
        );
      }

      try {
        return await awaitEnd(api, context, handle, until, seconds);
      } finally {
        await release(api, handle);
      }
    },
  };

  const canceller: ToolRegistration = {
    name: cancelName,
    description:
      "Stop an MCP task: cloudpid asks its server to cancel it. The server may finish it first, in which case its result is kept; mcp_tasks and the entry that tells you it ended say how it ended.",
    parameters: CANCEL_PARAMETERS,
    structuredOutputSchema: CANCEL_OUTPUT,
    replay: "safe",
    deferred: true,
    execute: async (args, api, context) => {
      // SAFETY: the arguments pi-durable validated against the tool's parameters, an object.
      const input = argsOf(args as JsonObject);
      const handle = (input.task ?? "").trim();
      const state = await api.snapshot(McpTasksDoc, context);
      const record = namedOf(state, api.conversationId, handle);

      if (record === undefined) return unknown(cancelName, handle);

      const done = (cancel: string, line: string): ToolExecutionResult<JsonValue> => ({
        output: text(line),
        details: detailsFor(cancelName, record),
        structuredOutput: { task: handle, cancel },
      });

      if (record.end !== undefined) {
        return done(
          "ended",
          `MCP task ${handle} had already ended (${record.end.status}); its result is read with mcp_task_wait.`,
        );
      }

      if (record.cancel !== undefined) {
        return done("already_sent", `A cancel for MCP task ${handle} was already sent.`);
      }

      // Marked before it is sent, so a restart that cut the send sends it once more (the follower's first look).
      const took =
        (await requestCancel(
          {
            commit: async (write) => {
              await api.commit(write, context);
            },
            client,
            origin,
            now: () => api.now(),
          },
          record,
          "agent",
        )) !== "failed";

      return took
        ? done(
            "sent",
            `Cancel sent for MCP task ${handle}. You are told how it ended; mcp_task_wait reads it.`,
          )
        : failedWith(
            `The cancel for MCP task ${handle} could not be delivered to ${record.server}. It is still running there; cloudpid stops following it in a few minutes.`,
            detailsFor(cancelName, record),
          );
    },
  };

  return [lister, waiter, canceller];
};

/** What a tool's context is. */
type ToolContext = Parameters<ToolRegistration["execute"]>[2];

export type { StoredResult };
