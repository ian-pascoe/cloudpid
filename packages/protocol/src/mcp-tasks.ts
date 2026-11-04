// An MCP task as the owner's clients show it (`docs/architecture/mcp-server-requests.md` → MCP tasks, Cancellation; the
// call card, the Session details and the Session list): the work an MCP server's tool went on with after it answered
// the call. The Session sends them in `mcp_tasks`, in full, after `hello` on every connect (an empty list too) and to
// every client whenever one changes; the owner cancels one with `mcp_task_cancel` and, for a stdio server's, keeps its
// Container with `container_keep`. Nothing here is the server's task id: a task is its handle, `mcp-task-<n>`.
import * as Schema from "effect/Schema";
import { ConversationId } from "./conversation-id.ts";

/**
 * How long a Container may be kept running by holds and uses after the last owner or agent activity in its Workspace
 * (`docs/architecture/container.md` → Idle stop): the Workspace's hold cap, which ends a stdio server's task whose
 * Container nothing else keeps awake, and which Keep the Container resets. One constant, so what the Session tells the
 * agent, what the card tells the owner and what the Workspace enforces cannot drift.
 */
export const CONTAINER_HOLD_CAP_MS = 60 * 60_000;

/** The hold cap in the words of a sentence. */
export const holdCapText = (): string => "an hour";

/**
 * One MCP task of the Session. `status` is the server's, or cloudpid's own for one it ended (`unknown`, `stopped`), as a
 * string so a state a later build adds still reads. Times are epoch milliseconds.
 */
export const McpTask = Schema.Struct({
  /** What `mcp_task_cancel` names: `mcp-task-<n>`. */
  task: Schema.String,
  /** The server's configured name. */
  server: Schema.String,
  /** The model-facing name of the tool (`mcp__<server>__<tool>`). */
  tool: Schema.String,
  status: Schema.String,
  /** What the server says it is doing, redacted and cut; absent when it says nothing. */
  statusMessage: Schema.optionalKey(Schema.String),
  /** Whether the call that started it returned and it went on: a task still inline is part of its call. */
  background: Schema.Boolean,
  /** A stdio server's task: it lives in the Workspace's Container, which an idle stop ends (`container_keep`). */
  stdio: Schema.optionalKey(Schema.Boolean),
  /** The id of the tool call that started it, which a call card finds its task by. */
  callId: Schema.String,
  /** The conversation that started it, which is told how it ends. */
  conversationId: ConversationId,
  /** The agent that started it: absent for the root agent, a subagent's ID otherwise. */
  agent: Schema.optionalKey(Schema.String),
  startedAt: Schema.Finite,
  /** When it ended; absent while it goes on. */
  endedAt: Schema.optionalKey(Schema.Finite),
  /** When the agent was told of the end (its wait read the result, or the end was posted to it); absent when it was not told. */
  toldAt: Schema.optionalKey(Schema.Finite),
  /** When its server forgets it (its `ttlMs` from the start), when the server said. */
  keptUntil: Schema.optionalKey(Schema.Finite),
  /** Who it waits on: `owner` when every question it asks is theirs and nothing happens until they answer. A string, so a party a later build names reads as itself. */
  waitingFor: Schema.optionalKey(Schema.String),
  /**
   * The cancel that was asked for it, by whom and when: the card reads "Cancelling…" until the task ends or the server
   * ignores it for two minutes.
   */
  cancel: Schema.optionalKey(
    Schema.Struct({
      by: Schema.String,
      at: Schema.Finite,
    }),
  ),
  /** How it ended, who ended it and cloudpid's reason, when it ended; the words are never the server's. */
  end: Schema.optionalKey(
    Schema.Struct({
      by: Schema.String,
      reason: Schema.optionalKey(Schema.String),
    }),
  ),
});

export type McpTask = typeof McpTask.Type;
