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
 * Submit `input` to the Session's root conversation. Submitting the same `requestId` again finds the first submission,
 * so a client may resend a submit it saw no result for. Answered with `{ submissionId }`.
 */
export const Submit = Schema.Struct({
  type: Schema.Literal("submit"),
  id: CommandId,
  input: UserInput,
  whenBusy: Schema.optionalKey(WhenBusy),
  requestId: Schema.optionalKey(Schema.String),
});

/** Abort the root conversation's work and withdraw its queued input. Answered with `null` once it is idle. */
export const Abort = Schema.Struct({ type: Schema.Literal("abort"), id: CommandId });

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

/** Client → server. */
export const ClientMessage = Schema.Union([Submit, Abort, Watch, Unwatch, Configure, SecretAnswer]);

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
