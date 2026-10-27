// A conversation's ID within its Session, in a module of its own so the socket's messages (`session.ts`) and the shapes
// they carry (`annotations.ts`) both take it without importing each other.
import type { ConversationId as PiConversationId } from "@earendil-works/pi-durable";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** A conversation's ID within its Session: pi-durable's positive integer. */
export const ConversationId = Schema.declare(
  (input): input is PiConversationId =>
    Predicate.isNumber(input) && Number.isSafeInteger(input) && input > 0,
  { identifier: "ConversationId" },
);

export type ConversationId = typeof ConversationId.Type;
