// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over stored entries' JSON.
// History: a conversation's stored entries, which a Handoff or a compaction takes out of the model's context but never
// out of storage. Ported from pi-context-management's `context-tools.ts` and `entry-preview.ts`: Context Windows, one-line
// entry previews, references, and literal search over the decoded strings of an entry's JSON.
import type { Message, ToolCall } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, EntryRecord } from "@earendil-works/pi-durable";
import * as DateTime from "effect/DateTime";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";

/** Lists and searches return at most this many items per page. */
export const PAGE_SIZE = 20;

/** A History `read` returns at most this many characters of entry JSON per call. */
export const READ_CHARACTERS = 2_000;

const PREVIEW_LIMIT = 120;

const ARGUMENT_LIMIT = 60;

/** The reference of entry `id` of conversation `conversationId`. */
export const entryRef = (conversationId: ConversationId, id: EntryId): string =>
  `context:${conversationId}:${id}`;

export type ParsedRef =
  | { readonly type: "entry"; readonly conversationId: ConversationId; readonly entryId: EntryId }
  | { readonly type: "note"; readonly conversationId: ConversationId; readonly name: string };

const REF = /^context:(\d+):(?:note:(.+)|(\d+))$/;

/** What a reference names, or `undefined` when it is not one. */
export const parseRef = (ref: string): ParsedRef | undefined => {
  const match = REF.exec(ref);

  if (match === null) return undefined;

  // SAFETY: the pattern's first group is digits: a conversation ID as `entryRef` and `noteRef` write it.
  const conversationId = Number(match[1]) as ConversationId;

  return match[2] !== undefined
    ? { type: "note", conversationId, name: match[2] }
    : // SAFETY: the third group is digits: an entry ID as `entryRef` writes it.
      { type: "entry", conversationId, entryId: Number(match[3]) as EntryId };
};

/** A Context Window: the entries from one head marker (a Handoff or a compaction) to the next. */
export type ContextWindow = { readonly start: number; readonly end: number };

/** The Context Windows of `entries`, oldest first; a new one starts at every entry that sets the context's head. */
export const windowsOf = (entries: ReadonlyArray<EntryRecord>): ContextWindow[] => {
  const starts: number[] = [];

  entries.forEach((entry, index) => {
    if (index === 0 || entry.head !== undefined) starts.push(index);
  });

  return starts.map((start, index) => ({ start, end: starts[index + 1] ?? entries.length }));
};

const clip = (text: string, limit: number): string => {
  const line = text.replace(/\s+/g, " ").trim();

  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
};

const textOf = (content: Message["content"]): string =>
  Predicate.isString(content)
    ? content
    : content.map((block) => (block.type === "text" ? block.text : "")).join(" ");

const describeCall = (call: ToolCall): string => {
  const first = Record.values(call.arguments).find(Predicate.isString);

  return `${call.name}(${clip(first ?? JSON.stringify(call.arguments), ARGUMENT_LIMIT)})`;
};

const labelled = (label: string, text: string): string => {
  const body = clip(text, PREVIEW_LIMIT);

  return body === "" ? label : `${label}: ${body}`;
};

const describeMessage = (entry: EntryRecord, message: Message): string => {
  switch (message.role) {
    case "user":
      return labelled(
        entry.kind === "pi.user" ? "user" : `user(${entry.kind})`,
        textOf(message.content),
      );
    case "assistant": {
      const text = clip(
        textOf(message.content) ||
          message.errorMessage ||
          (message.content.some((block) => block.type === "thinking") ? "[thinking]" : ""),
        PREVIEW_LIMIT,
      );

      const calls = message.content
        .flatMap((block) => (block.type === "toolCall" ? [describeCall(block)] : []))
        .join(", ");

      return `assistant${text === "" ? "" : `: ${text}`}${calls === "" ? "" : ` → ${calls}`}`;
    }

    case "toolResult":
      return labelled(
        `toolResult(${message.toolName}${message.isError ? ", error" : ""})`,
        textOf(message.content),
      );
    case "system":
      return "system";
  }
};

/**
 * One bounded line naming what a stored entry says: `user: …`, `assistant: … → read(…)`, `toolResult(read): …`,
 * `handoff: …`, `compaction: …`, or the entry's kind.
 */
export const describeEntry = (entry: EntryRecord): string => {
  const message = entry.model?.[0];

  try {
    if (entry.kind === "pi.reset") {
      return clip(
        message === undefined ? "reset" : labelled("handoff", textOf(message.content)),
        PREVIEW_LIMIT,
      );
    }

    if (entry.kind === "pi.compaction" && message !== undefined) {
      return clip(labelled("compaction", textOf(message.content)), PREVIEW_LIMIT);
    }

    return clip(
      message === undefined ? entry.kind : describeMessage(entry, message),
      PREVIEW_LIMIT,
    );
  } catch {
    // An unfamiliar stored shape must not make the whole page unreadable.
    return entry.kind;
  }
};

/** When an entry's message was made, as ISO 8601, or an empty string for entries without one. */
export const timestampOf = (entry: EntryRecord): string => {
  const at = entry.model?.[0]?.timestamp;

  return at === undefined || at === 0 ? "" : DateTime.formatIso(DateTime.makeUnsafe(at));
};

/** Whether `entry` passes the `type` (entry kind) and `role` (message role) filters. */
export const matchesFilter = (
  entry: EntryRecord,
  type: string | undefined,
  role: string | undefined,
): boolean =>
  (type === undefined || entry.kind === type) &&
  (role === undefined || entry.model?.[0]?.role === role);

/** Something to search: a Note's text, or an entry's JSON, whose string values are searched decoded. */
export type SearchItem = {
  readonly ref: string;
  readonly content: string;
  readonly name?: string;
  readonly agent?: string;
  readonly session?: string;
  /** `content` is entry JSON. */
  readonly recorded?: true;
  /** A range of the JSON that must not match, such as the call running this search. */
  readonly skip?: { readonly start: number; readonly end: number } | undefined;
};

export type SearchMatch = {
  ref: string;
  name?: string;
  agent?: string;
  session?: string;
  /** In the Note text, or in the entry JSON `read` returns. */
  offset: number;
  preview: string;
};

/** One page of search matches; `next_offset` is null on the last page. */
export type SearchPage = { matches: SearchMatch[]; next_offset: number | null };

/** The JSON range of tool call `callId` in an entry's JSON, if the entry holds it. */
export const callRange = (entry: EntryRecord, json: string, callId: string) => {
  const message = entry.model?.[0];

  if (message?.role !== "assistant") return undefined;

  const call = message.content.find((block) => block.type === "toolCall" && block.id === callId);

  if (call === undefined) return undefined;

  const recorded = JSON.stringify(call);
  const start = json.indexOf(recorded);

  return start === -1 ? undefined : { start, end: start + recorded.length };
};

/** The searchable parts of `item`: a Note's text, or each decoded string value of entry JSON that is not a key. */
function* searchableText(item: SearchItem) {
  if (item.recorded !== true) {
    yield { content: item.content, start: 0, encoded: "" };

    return;
  }

  for (const token of item.content.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    if (item.content[token.index + token[0].length] === ":") continue;

    if (item.skip !== undefined && token.index >= item.skip.start && token.index < item.skip.end) {
      continue;
    }

    const decoded: unknown = JSON.parse(token[0]);

    if (Predicate.isString(decoded))
      yield { content: decoded, start: token.index, encoded: token[0] };
  }
}

/** The offset in a JSON string literal of the character at `offset` of its decoded value. */
const encodedOffset = (encoded: string, offset: number): number => {
  let cursor = 1; // The opening quote.

  for (let index = 0; index < offset; index++) {
    cursor += encoded[cursor] === "\\" ? (encoded[cursor + 1] === "u" ? 6 : 2) : 1;
  }

  return cursor;
};

/** One page of the case-sensitive literal matches of `query` in `items`, from match `offset`. */
export const search = (
  items: Iterable<SearchItem>,
  query: string,
  offset: number,
  limit: number,
): SearchPage => {
  const matches: SearchMatch[] = [];
  let skipped = 0;

  for (const item of items) {
    for (const part of searchableText(item)) {
      let position = part.content.indexOf(query);

      while (position !== -1) {
        if (skipped < offset) skipped++;
        else if (matches.length === limit) return { matches, next_offset: offset + matches.length };
        else {
          const match: SearchMatch = {
            ref: item.ref,
            offset:
              part.encoded === "" ? position : part.start + encodedOffset(part.encoded, position),
            // The decoded text, so escapes read as characters, not as JSON.
            preview: part.content.slice(Math.max(0, position - 20), position + 60),
          };

          if (item.name !== undefined) match.name = item.name;

          if (item.agent !== undefined) match.agent = item.agent;

          if (item.session !== undefined) match.session = item.session;

          matches.push(match);
        }

        position = part.content.indexOf(query, position + 1);
      }
    }
  }

  return { matches, next_offset: null };
};
