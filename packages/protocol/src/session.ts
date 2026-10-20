// The Session socket: one WebSocket per client to one Session DO (`docs/spec.md` → Client and protocol, ADR-0009).
// The shapes follow the socket protocol of Cloudflare's `agents` pi example (`examples/next/harnesses/pi`, MIT), in
// Effect `Schema`: commands carry an optional `id` that a `result` or `error` answers, and every watched conversation
// streams `events` batches whose first batch is a `snapshot`.
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

/** Client → server. */
export const ClientMessage = Schema.Union([Submit, Abort, Watch, Unwatch]);

export type ClientMessage = typeof ClientMessage.Type;

/** Sent once on connect: the Session's root conversation, to `watch` and to submit to. */
export const Hello = Schema.Struct({ type: Schema.Literal("hello"), root: ConversationId });

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

/** A command failed, or a message could not be read (then without `id`). */
export const ErrorMessage = Schema.Struct({
  type: Schema.Literal("error"),
  id: Schema.optionalKey(Schema.String),
  message: Schema.String,
});

/** Server → client. */
export const ServerMessage = Schema.Union([Hello, Events, Result, ErrorMessage]);

export type ServerMessage = typeof ServerMessage.Type;

/** Client messages as the socket carries them: JSON text. */
export const ClientMessageJson = Schema.fromJsonString(ClientMessage);

/** Server messages as the socket carries them: JSON text. */
export const ServerMessageJson = Schema.fromJsonString(ServerMessage);
