// @effect-diagnostics missingPipeableSignature:off -- plain functions over the Notes document's JSON.
// A conversation's Notes and its last saved Handoff, as one conversation document (`docs/spec.md` → Context
// management). Documents are not part of the transcript, so a Handoff, which starts a new context, leaves them as they
// are; a fork starts with the Notes its source has then.
import { type ConversationId, defineDoc } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

/** At most this many Notes per conversation. */
export const MAX_NOTES = 128;

/** The longest Note, and the longest Handoff. */
export const MAX_NOTE_CHARACTERS = 64_000;

/** A Note name: a label, not a path. */
export const NOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/;

export const MAX_NOTE_NAME = 64;

/** The longest Note Index a Handoff carries. */
export const NOTE_INDEX_CHARACTERS = 4_000;

export type Note = {
  name: string;
  content: string;
  /** Milliseconds since the epoch. */
  updatedAt: number;
};

export type ContextState = {
  /** In the order they were first written. */
  notes: Note[];
  /** The Handoff `context_rollover` saved last, for an Emergency Rollover. */
  handoff: string | null;
};

export const ContextDoc = defineDoc<ContextState>({
  kind: "cloudpid.context",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ notes: [], handoff: null }),
  checkpointWhen: () => false,
});

/** The state as read outside a commit: the initial one until the first Note. */
export const EMPTY_STATE: ContextState = ContextDoc.definition.initial();

/** The stable reference of Note `name` of conversation `conversationId`. */
export const noteRef = (conversationId: ConversationId, name: string): string =>
  `context:${conversationId}:note:${name}`;

/** Appended text starts on a new line, so it never runs into the Note's last line. */
export const joinAppend = (existing: string, appended: string): string =>
  existing === "" || appended === "" || existing.endsWith("\n")
    ? existing + appended
    : `${existing}\n${appended}`;

/**
 * The Note Index a new context gets: how many Notes there are and each one's reference, within `maxCharacters`, so
 * the agent can read them with `context_notes` instead of carrying them.
 */
export const noteIndex = (
  conversationId: ConversationId,
  notes: ReadonlyArray<Note>,
  maxCharacters = NOTE_INDEX_CHARACTERS,
): string => {
  const head = `Notes: ${notes.length}. Read them with context_notes.`;
  const suffix = "\nUse context_notes list for the complete catalogue.";
  let index = head;
  let listed = 0;

  for (const note of notes) {
    const line = `\n${JSON.stringify(note.name)} ${noteRef(conversationId, note.name)}`;

    if (index.length + line.length + suffix.length > maxCharacters) break;

    index += line;
    listed++;
  }

  return (listed < notes.length ? index + suffix : index).slice(0, maxCharacters);
};

/** Note `name`, if there is one. */
export const findNote = (notes: ReadonlyArray<Note>, name: string): Note | undefined =>
  Option.getOrUndefined(Arr.findFirst(notes, (note) => note.name === name));
