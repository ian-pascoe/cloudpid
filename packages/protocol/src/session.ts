// The Session socket: one WebSocket per client to one Session DO (`docs/spec.md` → Client and protocol, ADR-0009).
// The shapes follow the socket protocol of Cloudflare's `agents` pi example (`examples/next/harnesses/pi`, MIT), in
// Effect `Schema`: commands carry an optional `id` that a `result` or `error` answers, and every watched conversation
// streams `events` batches whose first batch is a `snapshot`.
import { ModelId, ThinkingLevel } from "@cloudpid/config";
import type { AgentEvent, ConversationId as PiConversationId } from "@earendil-works/pi-durable";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/**
 * The text the client sends to keep the socket alive, and the server's answer. The object answers it without waking,
 * so a client's heartbeat does not keep a hibernated Session in memory.
 */
export const HEARTBEAT = { request: "ping", response: "pong" } as const;

/**
 * What input submitted while the conversation is busy does. `steer` joins the running Run at its next boundary, after
 * the tool calls in progress; one that finds the Run producing its final answer starts the next Run instead.
 * `followUp`, pi-durable's default, waits for the next Run; `reject` fails the command.
 */
export const WhenBusy = Schema.Literals(["steer", "followUp", "reject"]);

export type WhenBusy = typeof WhenBusy.Type;

const TextContent = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const ImageContent = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String,
  mimeType: Schema.String,
});

/** User input, as pi takes it: text, or text and image blocks. */
export const UserInput = Schema.Union([
  Schema.String,
  Schema.Union([TextContent, ImageContent]).pipe(Schema.Array, Schema.mutable),
]);

export type UserInput = typeof UserInput.Type;

/** A conversation's ID within its Session: pi-durable's positive integer. */
export const ConversationId = Schema.declare(
  (input): input is PiConversationId =>
    Predicate.isNumber(input) && Number.isSafeInteger(input) && input > 0,
  { identifier: "ConversationId" },
);

export type ConversationId = typeof ConversationId.Type;

/** A command's correlation ID: an answered command gets a `result` or an `error` with it. */
const CommandId = Schema.optionalKey(Schema.String);

/**
 * Submit `input` to the Session's root conversation, or to the conversation of one of its subagents when
 * `conversationId` names it (a conversation that is neither fails the command). Input to a subagent is the owner
 * talking to it directly: the agent sees it as a user message, and its answer is not reported to the agent that started
 * it. Submitting the same `requestId` again finds the first submission, so a client may resend a submit it saw no
 * result for. Answered with `{ submissionId }`.
 */
export const Submit = Schema.Struct({
  type: Schema.Literal("submit"),
  id: CommandId,
  conversationId: Schema.optionalKey(ConversationId),
  input: UserInput,
  whenBusy: Schema.optionalKey(WhenBusy),
  requestId: Schema.optionalKey(Schema.String),
});

/**
 * Abort the work of the root conversation, or of the subagent conversation `conversationId` names, and withdraw its
 * queued input. Its subagents are agents of their own and keep working, unless `subagents` is true: then every subagent
 * below it is stopped too, and the results they held for it are dropped. Answered with `null` once it is idle.
 */
export const Abort = Schema.Struct({
  type: Schema.Literal("abort"),
  id: CommandId,
  conversationId: Schema.optionalKey(ConversationId),
  subagents: Schema.optionalKey(Schema.Boolean),
});

/**
 * Stream conversation `conversationId`'s events on this socket: a `snapshot`, then pi's `AgentEvent` batches. Watching
 * a conversation already watched restarts it with a fresh snapshot. The watch outlives hibernation: a woken Session
 * restarts it, with a fresh snapshot. Answered with `null`.
 */
export const Watch = Schema.Struct({
  type: Schema.Literal("watch"),
  id: CommandId,
  conversationId: ConversationId,
});

/** Stop streaming conversation `conversationId`. Answered with `null`. */
export const Unwatch = Schema.Struct({
  type: Schema.Literal("unwatch"),
  id: CommandId,
  conversationId: ConversationId,
});

/**
 * Pick the model and thinking level the root conversation runs with, from its next request on. A field left out stays
 * as it is; `null` clears it, so the Session follows the default in the settings again (and a changed default applies
 * to its next request). A Session that was never configured follows the default. Answered with `null`; the new
 * choice reaches clients as an `agent_changed` event.
 */
export const Configure = Schema.Struct({
  type: Schema.Literal("configure"),
  id: CommandId,
  model: ModelId.pipe(Schema.NullOr, Schema.optionalKey),
  thinkingLevel: ThinkingLevel.pipe(Schema.NullOr, Schema.optionalKey),
});

/**
 * The owner's answer to Secret request `request` (`secret_requests`), entered in a masked form: a value per name, where
 * a missing or empty one skips that name, or `null` when the owner cancelled. Answered with `null`; fails when no such
 * request waits or a name was not requested.
 */
export const SecretAnswer = Schema.Struct({
  type: Schema.Literal("secret_answer"),
  id: CommandId,
  request: Schema.String,
  values: Schema.NullOr(Schema.Record(Schema.String, Schema.String)),
});

/**
 * Stream a compact summary of the Session's task graph on this socket (`task_graph`): its subagents and the background
 * work live now. The first message follows at once, and the watch outlives hibernation like a conversation's. Answered
 * with `null`.
 */
export const WatchTaskGraph = Schema.Struct({
  type: Schema.Literal("watch_task_graph"),
  id: CommandId,
});

/** Stop streaming the task graph on this socket. Answered with `null`. */
export const UnwatchTaskGraph = Schema.Struct({
  type: Schema.Literal("unwatch_task_graph"),
  id: CommandId,
});

/**
 * Stream the Session's token and cost totals on this socket (`usage`). The first message follows at once, and the watch
 * outlives hibernation like a conversation's. Answered with `null`.
 */
export const WatchUsage = Schema.Struct({
  type: Schema.Literal("watch_usage"),
  id: CommandId,
});

/** Stop streaming the Session's usage on this socket. Answered with `null`. */
export const UnwatchUsage = Schema.Struct({
  type: Schema.Literal("unwatch_usage"),
  id: CommandId,
});

/** Client → server. */
export const ClientMessage = Schema.Union([
  Submit,
  Abort,
  Watch,
  Unwatch,
  Configure,
  SecretAnswer,
  WatchTaskGraph,
  UnwatchTaskGraph,
  WatchUsage,
  UnwatchUsage,
]);

export type ClientMessage = typeof ClientMessage.Type;

/** Sent once on connect: the Session's root conversation, to `watch` and to submit to. */
export const Hello = Schema.Struct({ type: Schema.Literal("hello"), root: ConversationId });

/**
 * Which of the root conversation's model and thinking level the Session picked itself with `configure`: the rest
 * follows the default in the settings. Sent after `hello`, and to every connected client whenever a `configure`
 * changes it, since `agent_changed` carries the resolved agent but not where it came from.
 */
export const Picked = Schema.Struct({
  type: Schema.Literal("picked"),
  model: Schema.Boolean,
  thinkingLevel: Schema.Boolean,
});

/** A call's request for the owner to enter Secrets; never carries a value. */
export const SecretRequest = Schema.Struct({
  /** What the answer names. */
  id: Schema.String,
  /** The conversation whose call asks. */
  conversationId: ConversationId,
  /** The Secret Names to enter, one masked field each. */
  names: Schema.Array(Schema.String),
  /** Why the agent needs them. */
  reason: Schema.optionalKey(Schema.String),
});

export type SecretRequest = typeof SecretRequest.Type;

/**
 * The Secret requests waiting for the owner, oldest first. A client shows a masked form for them, never the chat, and
 * answers each with `secret_answer`. Sent after `hello` while any waits, and to every client whenever they change (an
 * empty list once none waits). A request outlives reconnects and evictions until it is answered or its call ends.
 */
export const SecretRequests = Schema.Struct({
  type: Schema.Literal("secret_requests"),
  requests: Schema.Array(SecretRequest),
  /** How long an entered Secret is held. */
  lifetimeMinutes: Schema.Finite,
});

/**
 * A Browser Handoff waiting for the owner (`docs/spec.md` → Browser): the agent gave the owner live control of its browser
 * for a step it cannot do. `url` is the Live View link, a bearer credential for the owner alone: a client shows it as a
 * link for the owner to open and never to the agent or the chat.
 */
export const BrowserHandoffRequest = Schema.Struct({
  /** The asking call's task, unique within the Session. */
  id: Schema.String,
  /** The conversation whose tab is handed over. */
  conversationId: ConversationId,
  /** What the agent needs done. */
  instructions: Schema.String,
  /** The Live View link, to open in a browser. */
  url: Schema.String,
  /** When the handoff times out, in milliseconds since the epoch. */
  deadline: Schema.Finite,
});

export type BrowserHandoffRequest = typeof BrowserHandoffRequest.Type;

/**
 * The Browser Handoffs waiting for the owner, oldest first. A client shows each with its instructions and a link to open,
 * outside the chat. Sent after `hello` while any waits, and to every client whenever they change (an empty list once none
 * waits). The owner finishes in the Live View itself, so there is no answer command; a request ends when the owner is
 * done, the handoff times out, or the run is stopped, and it outlives reconnects and evictions until then.
 */
export const BrowserHandoffRequests = Schema.Struct({
  type: Schema.Literal("browser_handoff_requests"),
  requests: Schema.Array(BrowserHandoffRequest),
});

/** A subagent as the task graph shows it. */
export const GraphAgent = Schema.Struct({
  /** Its canonical ID, such as `agent-1` or `agent-1.reviewer`. */
  id: Schema.String,
  /** The agent that started it: `root` or another subagent's ID. */
  parent: Schema.String,
  /** The conversation to `watch`, and to `submit` and `abort` to. */
  conversationId: ConversationId,
  /** The model role it was started with, if any. */
  role: Schema.NullOr(Schema.String),
  /** `provider/modelId`. */
  model: Schema.String,
  /** `working` while its conversation has live work, otherwise `idle`: it keeps its history and can take more input. */
  status: Schema.Literals(["working", "idle"]),
});

export type GraphAgent = typeof GraphAgent.Type;

/** A live background task as the task graph shows it. */
export const GraphBackgroundTask = Schema.Struct({
  id: Schema.Finite,
  /** The task's kind, such as `pi.compaction`. */
  kind: Schema.String,
  /** The agent whose conversation it belongs to: `root` or a subagent's ID. */
  agent: Schema.String,
  conversationId: ConversationId,
  state: Schema.Literals(["pending", "running", "waiting", "completing"]),
  /** Whether an abort was asked of it and is not finished. */
  aborting: Schema.Boolean,
});

export type GraphBackgroundTask = typeof GraphBackgroundTask.Type;

/**
 * The Session's live work, summarised from pi-durable's task graph and the Subagents document: every subagent (a
 * deleted one is gone), parents before their children, and the live background tasks other than the subagents'
 * own bookkeeping. Each message replaces the last. The server sends one at most every few hundred milliseconds, and keeps
 * the lists short.
 */
export const TaskGraphSummary = Schema.Struct({
  agents: Schema.Array(GraphAgent),
  background: Schema.Array(GraphBackgroundTask),
});

export type TaskGraphSummary = typeof TaskGraphSummary.Type;

/** The Session's task graph, sent to a client that watches it (`watch_task_graph`) whenever it changes. */
export const TaskGraphMessage = Schema.Struct({
  type: Schema.Literal("task_graph"),
  ...TaskGraphSummary.fields,
});

/**
 * What the Session has spent on model requests (`docs/spec.md` → Telemetry), as pi-durable's `pi.usage` counts it:
 * every conversation of the Session, subagents' included, and the title call, which has no conversation. Token counts
 * are as the provider reported them; `cost` is in US dollars, as the model catalog prices the tokens.
 */
export const SessionUsage = Schema.Struct({
  input: Schema.Finite,
  output: Schema.Finite,
  cacheRead: Schema.Finite,
  cacheWrite: Schema.Finite,
  totalTokens: Schema.Finite,
  cost: Schema.Finite,
  /** The Session's spend limit in US dollars, or null when it has none. A Session at it stops before its next request. */
  limit: Schema.NullOr(Schema.Finite),
});

export type SessionUsage = typeof SessionUsage.Type;

/** The Session's usage, sent to a client that watches it (`watch_usage`) whenever it changes; each replaces the last. */
export const UsageMessage = Schema.Struct({
  type: Schema.Literal("usage"),
  ...SessionUsage.fields,
});

/** A Task of a conversation's Todo List: flat, in the order of its ID. */
export const TodoTask = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  description: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["pending", "active", "completed"]),
});

export type TodoTask = typeof TodoTask.Type;

/**
 * A watched conversation's Todo List, whole. The Session sends one after the snapshot of each conversation a client
 * `watch`es, the root's and a subagent's alike, and another each time the list changes; each replaces the last one of
 * that conversation. A conversation that never used the tool has an empty list.
 */
export const TodosMessage = Schema.Struct({
  type: Schema.Literal("todos"),
  conversationId: ConversationId,
  tasks: Schema.Array(TodoTask),
});

/** One of pi's agent events, passed through unchanged; only its `type` is checked. */
export const AgentEventSchema = Schema.declare(
  (input): input is AgentEvent =>
    Predicate.isObject(input) &&
    Predicate.hasProperty(input, "type") &&
    Predicate.isString(input.type),
  { identifier: "AgentEvent" },
);

/**
 * A batch of a watched conversation's events, one per commit. The first batch of a watch, and the first after the
 * Session restarted it, is a lone `snapshot` that replaces the client's state.
 */
export const Events = Schema.Struct({
  type: Schema.Literal("events"),
  conversationId: ConversationId,
  events: Schema.Array(AgentEventSchema),
});

/** A command's answer. */
export const Result = Schema.Struct({
  type: Schema.Literal("result"),
  id: Schema.String,
  result: Schema.Json,
});

/**
 * Something failed. With `id`, the command with that `id` failed, or could not be read. With `conversationId`, the
 * watch of that conversation ended and is dropped: watch it again to resume. With neither, a message without a
 * readable `id` could not be read.
 */
export const ErrorMessage = Schema.Struct({
  type: Schema.Literal("error"),
  id: Schema.optionalKey(Schema.String),
  conversationId: Schema.optionalKey(ConversationId),
  message: Schema.String,
});

/** Server → client. */
export const ServerMessage = Schema.Union([
  Hello,
  Picked,
  Events,
  Result,
  ErrorMessage,
  SecretRequests,
  BrowserHandoffRequests,
  TaskGraphMessage,
  UsageMessage,
  TodosMessage,
]);

export type ServerMessage = typeof ServerMessage.Type;

/** Client messages as the socket carries them: JSON text. */
export const ClientMessageJson = Schema.fromJsonString(ClientMessage);

/**
 * Read a client message, as the Session does: keys a message does not define are an error, so a misspelt option
 * (`whenbusy`) fails the command instead of being ignored.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a Schema decoder, as `Schema.decodeUnknownEffect` makes.
export const decodeClientMessage = Schema.decodeUnknownEffect(ClientMessageJson, {
  onExcessProperty: "error",
});

/** Server messages as the socket carries them: JSON text. */
export const ServerMessageJson = Schema.fromJsonString(ServerMessage);
