// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off globalDate:off missedPipeableOpportunity:off -- plain functions over lines of JSON and a few counts.
// The Session import's translation (`docs/architecture/mcp-endpoint.md` → Session import → Translation): the raw pi file,
// as lines, becomes entries for the root conversation (the import notice last), the Todo List and Notes of the owner's pi
// extensions, and the counts of what was cut, dropped and closed. `ImportTranslator` is the seam the Session imports
// through; `translatePiSession` is the translation.
//
// The file can be 64 MiB, so the entries are never all held: the file is read three times, as lines, and an entry lives
// only while it is made. The first read finds the active branch (the path that ends at the last line) and what the
// context edits name; the second makes every entry and keeps only the counts; the third, `pages()`, makes them again, a
// page at a time, as the Session writes them. The reads agree because the translation is a function of the lines.
import { mcpToolNameFromPi } from "@cloudpid/config";
import type { ContextState } from "@cloudpid/extensions/context";
import type { TodoState } from "@cloudpid/extensions/todo";
import type { ImportSummary } from "@cloudpid/protocol";
import type { JsonValue } from "@earendil-works/chord";
import type { ImageContent, Message, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { type EntryId, type EntryRecord, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { summaryMessage } from "./branch-summary.ts";
import { fitEntry } from "./import-bounds.ts";
import { type ImportFacts, importNotice } from "./import-notice.ts";
import { contextOf, emptyPiState, type PiState, takePiEntry, todoOf } from "./import-pi-state.ts";
import { BRANCH_SUMMARY_KIND } from "./tree.ts";

export type { ImportFacts } from "./import-notice.ts";

/**
 * The version of the translation: raised whenever a change makes other entries (or other IDs) of the same file, so that
 * an import cut off part way under one version is not resumed under another (`importTranslated`).
 */
export const TRANSLATOR_VERSION = 1;

/** What a translation made: the counts, the extension state, and the root conversation's entries as pages, the notice last. */
export type Translation = {
  /** The translator's version (`TRANSLATOR_VERSION`) that made it. */
  readonly version: number;
  readonly summary: ImportSummary;
  /** How many entries `pages()` makes, the notice included. Their IDs are 1 to `count`, in order, and heads and edits name them. */
  readonly count: number;
  /**
   * The entries, oldest first, a page at a time. Each call reads the file again and makes them anew, so a page is held only
   * while it is written, and one that is cut off is made again the same.
   */
  readonly pages: () => Iterable<ReadonlyArray<EntryRecord>>;
  /** The Notes and the Handoff the file held, as the document `importFinish` takes; none when it held neither. */
  readonly context: ContextState | null;
  /** The Todo List, with `rev` 0 (`importFinish` moves it to 1); none when the file held no list. */
  readonly todo: TodoState | null;
};

/** A file that cannot be translated: why, as one sentence for the Local agent. */
export type TranslationFailure = { readonly failed: string };

export type ImportTranslator = (
  lines: Iterable<string>,
  facts: ImportFacts,
) => Translation | TranslationFailure;

/** The entry kind of a context edit, which carries the edits and no message. */
export const CONTEXT_EDIT_KIND = "cloudpid.context-edit";

/** How many entries, and about how many bytes of JSON, one page of the written entries holds at most. */
export const IMPORT_PAGE_ENTRIES = 200;

export const IMPORT_PAGE_BYTES = 4 * 1024 * 1024;

/** What an error result for a call that never had one says (Translation → Tool calls: a dangling call is closed). */
export const NOT_RUN_TEXT = "Not run: the laptop's turn ended before this call had a result";

/** pi's framing of a compaction summary in the context, which pi-durable's compaction entries share. */
const COMPACTION_PREFIX =
  "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";

const COMPACTION_SUFFIX = "\n</summary>";

/** An assistant message with one of these stops is left out of the context (pi-durable's `EXCLUDED_STOP_REASONS`), and so are its calls. */
const EXCLUDED_STOPS: ReadonlySet<string> = new Set(["aborted", "error", "deferred"]);

/** Kinds that make no entry and are not counted: pi's own bookkeeping, which begin's `model` and `thinking` and the Session replace. */
const IGNORED: ReadonlySet<string> = new Set([
  "model_change",
  "thinking_level_change",
  "label",
  "session_info",
  "usage",
]);

const Header = Schema.Struct({
  type: Schema.Literal("session"),
  cwd: Schema.optionalKey(Schema.String),
});

/** A message as pi wrote it: any object with a `role`. Kept as it is, and looked at by role. */
const isMessage = (value: unknown): value is Message =>
  Predicate.isObject(value) &&
  Predicate.hasProperty(value, "role") &&
  Predicate.isString(value.role);

type Content = string | Array<TextContent | ImageContent>;

/** The content of a custom message or a context edit: text, or parts. */
const isContent = (value: unknown): value is Content =>
  Predicate.isString(value) || Array.isArray(value);

const Line = Schema.Struct({
  type: Schema.String,
  id: Schema.optionalKey(Schema.String),
  parentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  timestamp: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.declare(isMessage)),
  summary: Schema.optionalKey(Schema.String),
  firstKeptEntryId: Schema.optionalKey(Schema.String),
  customType: Schema.optionalKey(Schema.String),
  data: Schema.optionalKey(Schema.Json),
  content: Schema.optionalKey(Schema.declare(isContent)),
  targetId: Schema.optionalKey(Schema.String),
  replacement: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ content: Schema.declare(isContent) })),
  ),
});

type PiLine = typeof Line.Type;

const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Header));

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Line));

/** What the first read needs of a line: where it sits in the tree, and what an edit names. */
const Identity = Schema.Struct({
  type: Schema.String,
  id: Schema.optionalKey(Schema.String),
  parentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  targetId: Schema.optionalKey(Schema.String),
});

const decodeIdentity = Schema.decodeUnknownOption(Schema.fromJsonString(Identity));

/** pi writes `type`, `id` and `parentId` first, in that order: most lines are read without parsing the rest of them. */
const LEADING = /^\{"type":"([^"\\]*)","id":"([^"\\]*)","parentId":(?:null|"([^"\\]*)")/u;

/** Where the file's entries are, as the first read found them. */
type Plan = {
  readonly cwd: string | undefined;
  /** The ids of the active branch's entries; none when every entry is on it (or the entries have no ids). */
  readonly onPath: ReadonlySet<string> | undefined;
  /** The ids of the entries a context edit names: their messages are kept to be replaced. */
  readonly edited: ReadonlySet<string>;
};

/** The first read: the header, the active branch and the context edits' targets; or why the file is no pi Session. */
const planOf = (lines: Iterable<string>): Plan | TranslationFailure => {
  let cwd: string | undefined;
  let seen = false;
  let number = 0;
  let entries = 0;
  let last: string | undefined;
  let identified = true;
  const parents = new Map<string, string | null>();
  const edited = new Set<string>();

  for (const line of lines) {
    number += 1;

    if (line.trim() === "") continue;

    if (!seen) {
      const first = decodeHeader(line);

      if (Option.isNone(first)) {
        return { failed: "The file does not start with a pi session header line." };
      }

      seen = true;
      cwd = first.value.cwd;

      continue;
    }

    entries += 1;

    const leading = LEADING.exec(line);

    if (leading !== null && leading[1] !== "context_edit") {
      const [, , id = "", parent] = leading;

      parents.set(id, parent ?? null);
      last = id;

      continue;
    }

    const parsed = decodeIdentity(line);

    if (Option.isNone(parsed)) return { failed: `Line ${String(number)} is not a pi entry.` };

    const { id, parentId, targetId } = parsed.value;

    if (id === undefined) {
      identified = false;
    } else {
      parents.set(id, parentId ?? null);
      last = id;
    }

    if (parsed.value.type === "context_edit" && targetId !== undefined) edited.add(targetId);
  }

  if (!seen) return { failed: "The file is empty." };

  if (!identified || last === undefined) return { cwd, onPath: undefined, edited };

  // The path that ends at the last line (the leaf is never stored): every entry of a branch sent whole is on it.
  const path = new Set<string>();

  for (
    let at: string | null | undefined = last;
    at !== null && at !== undefined && !path.has(at);
    at = parents.get(at)
  ) {
    path.add(at);
  }

  return { cwd, onPath: path.size === entries ? undefined : path, edited };
};

/** What the second and third reads count, and keep for the end. */
type Tally = {
  cut: number;
  closed: number;
  entries: number;
  dropped: Record<string, number>;
  /** The tools the history called, by name as cloudpid spells it, with how many times. */
  called: Map<string, number>;
  state: PiState;
  failed: string | undefined;
};

const newTally = (): Tally => ({
  cut: 0,
  closed: 0,
  entries: 0,
  dropped: {},
  called: new Map(),
  state: emptyPiState(),
  failed: undefined,
});

const drop = (tally: Tally, kind: string): void => {
  tally.dropped[kind] = (tally.dropped[kind] ?? 0) + 1;
};

/** An entry the translation will make, before it has an ID. */
type Draft = {
  readonly kind: string;
  readonly model?: ReadonlyArray<Message>;
  readonly data?: JsonValue;
  /** The entry's head: where the context starts: a source entry's ID, or `"self"`, the entry itself. */
  readonly head?: { readonly source: string } | "self";
  readonly edits?: ReadonlyArray<{ readonly target: number; readonly message?: Message }>;
};

/** The entry a message makes, and the kind that says so. */
const messageDraft = (
  kind: "pi.user" | "pi.assistant" | "pi.tool-result",
  message: Message,
): Draft =>
  kind === "pi.tool-result"
    ? { kind, model: [message], data: { diagnostics: [] } }
    : { kind, model: [message] };

/** A time in milliseconds, from the ISO time of an entry; 0 when it has none. */
const timeOf = (line: PiLine): number => {
  const time = line.timestamp === undefined ? Number.NaN : Date.parse(line.timestamp);

  return Number.isFinite(time) ? time : 0;
};

/** `content` as a user message holds it: a string as it is, a list with only its text and image parts. */
const keepContent = (content: Content): UserMessage["content"] =>
  Predicate.isString(content)
    ? content
    : Arr.filter(content, (part) => part.type === "text" || part.type === "image");

/** An ID of this translation's own, which the fill renumbers (`copiedDraft`). */
// SAFETY: every ID the translation makes is a number it counted, and entries are written under IDs the Session assigns.
const entryId = (id: number): EntryId => id as EntryId;

/** An entry of the root conversation with its ID. */
const record = (
  id: number,
  draft: Draft,
  headOf: (source: string) => number | undefined,
): EntryRecord => {
  const entry: Types.Mutable<EntryRecord> = {
    id: entryId(id),
    conversationId: ROOT_CONVERSATION_ID,
    kind: draft.kind,
  };

  if (draft.model !== undefined) entry.model = draft.model;

  if (draft.data !== undefined) entry.data = draft.data;

  // A head that names an entry the branch does not have starts the context at the entry itself, as pi's does.
  const head =
    draft.head === undefined
      ? undefined
      : draft.head === "self"
        ? id
        : (headOf(draft.head.source) ?? id);

  if (head !== undefined) entry.head = entryId(head);

  if (draft.edits !== undefined) {
    entry.edits = Arr.map(draft.edits, (edit) =>
      edit.message === undefined
        ? { target: entryId(edit.target), action: "omit" as const }
        : {
            target: entryId(edit.target),
            action: "replace" as const,
            messages: [edit.message],
          },
    );
  }

  return entry;
};

/** One entry of the pages, with about how many bytes of JSON it holds. */
type Piece = { readonly entry: EntryRecord; readonly bytes: number };

/** What an entry made with no line of its own (a call closed, the notice's neighbours) is counted as holding, in bytes of JSON: its fields. */
const MIN_PIECE_BYTES = 512;

/** What the notice is counted as holding, in bytes of JSON: a few sentences and a list of names. */
const NOTICE_PIECE_BYTES = 4096;

const encoder = new TextEncoder();

/** What one read keeps while it goes through the lines. */
type ReadState = {
  /** The ID the next entry gets. */
  next: number;
  /** The entry each source entry became, by the source's ID. */
  readonly placed: Map<string, number>;
  /** Source entries that made no entry, which take the next one: a head that named one starts there. */
  waiting: string[];
  /** The calls of the last assistant message that no result has answered. */
  readonly open: Map<string, { readonly name: string; readonly timestamp: number }>;
  /** The messages of the entries a context edit names, to be replaced. */
  readonly kept: Map<string, Message>;
};

const newReadState = (): ReadState => ({
  next: 1,
  placed: new Map(),
  waiting: [],
  open: new Map(),
  kept: new Map(),
});

/** An error result for each call still open, which ends them. */
const closersOf = (read: ReadState, tally: Tally): Draft[] => {
  const drafts = Arr.map([...read.open], ([id, call]) =>
    messageDraft("pi.tool-result", {
      role: "toolResult",
      toolCallId: id,
      toolName: call.name,
      content: [{ type: "text", text: NOT_RUN_TEXT }],
      details: { reason: "import_not_run" },
      isError: true,
      timestamp: call.timestamp,
    }),
  );

  tally.closed += drafts.length;
  read.open.clear();

  return drafts;
};

/** What a `message` entry makes: its message as an entry (the calls open before it closed), or nothing and a count. */
const messageDrafts = (line: PiLine, read: ReadState, tally: Tally): Draft[] => {
  const { message } = line;

  if (message === undefined) {
    drop(tally, "message:unknown");

    return [];
  }

  if (message.role === "user") {
    if (Predicate.isNullish(message.content)) message.content = [];

    return [...closersOf(read, tally), messageDraft("pi.user", message)];
  }

  if (message.role === "assistant") {
    if (!Array.isArray(message.content)) message.content = [];

    const calls: Array<{ readonly id: string; readonly name: string }> = [];

    for (const part of message.content) {
      if (part.type !== "toolCall") continue;

      part.name = mcpToolNameFromPi(part.name);
      tally.called.set(part.name, (tally.called.get(part.name) ?? 0) + 1);
      calls.push({ id: part.id, name: part.name });
    }

    const before = closersOf(read, tally);

    if (!EXCLUDED_STOPS.has(message.stopReason)) {
      for (const call of calls) {
        read.open.set(call.id, { name: call.name, timestamp: message.timestamp });
      }
    }

    return [...before, messageDraft("pi.assistant", message)];
  }

  if (message.role === "toolResult") {
    if (Predicate.isNullish(message.content)) message.content = [];

    if (Predicate.isString(message.toolName)) {
      message.toolName = mcpToolNameFromPi(message.toolName);
    }

    // The result answers its call here, once it is drafted: one too large to keep is still written, in a smaller form (`fitted`).
    read.open.delete(message.toolCallId);

    return [messageDraft("pi.tool-result", message)];
  }

  // System messages carry the laptop's prompt and tool list, and are never imported.
  if (message.role === "system") return [];

  // SAFETY: the guard says only that the message has a string `role`; one that is none of the four is told apart by it.
  drop(tally, `message:${(message as { readonly role: string }).role}`);

  return [];
};

/** What a `compaction` entry makes: pi's framed summary, with the context starting at the first entry kept. */
const compactionDrafts = (line: PiLine, read: ReadState, tally: Tally): Draft[] => {
  if (!Predicate.isString(line.summary)) {
    drop(tally, line.type);

    return [];
  }

  const summary: Message = {
    role: "user",
    content: [{ type: "text", text: `${COMPACTION_PREFIX}${line.summary}${COMPACTION_SUFFIX}` }],
    timestamp: timeOf(line),
  };

  // The kept entries start at `firstKeptEntryId`, as pi starts them; one that is not on the branch leaves the summary alone.
  return [
    ...closersOf(read, tally),
    {
      kind: "pi.compaction",
      model: [summary],
      data: { reason: "manual" },
      head: line.firstKeptEntryId === undefined ? "self" : { source: line.firstKeptEntryId },
    },
  ];
};

/** What a `branch_summary` entry makes. */
const branchSummaryDrafts = (line: PiLine, read: ReadState, tally: Tally): Draft[] =>
  line.summary === undefined || line.summary === ""
    ? []
    : [
        ...closersOf(read, tally),
        {
          kind: BRANCH_SUMMARY_KIND,
          model: [summaryMessage(line.summary, timeOf(line))],
          data: { notice: "Branch summary" },
        },
      ];

/** What a `custom_message` entry makes: a user message. */
const customMessageDrafts = (line: PiLine, read: ReadState, tally: Tally): Draft[] => [
  ...closersOf(read, tally),
  messageDraft("pi.user", {
    role: "user",
    content: keepContent(line.content ?? []),
    timestamp: timeOf(line),
  }),
];

/** What a `context_edit` entry makes: an entry that carries the edit, when its target made an entry. */
const contextEditDrafts = (line: PiLine, read: ReadState): Draft[] => {
  const target = line.targetId === undefined ? undefined : read.placed.get(line.targetId);

  if (target === undefined || line.targetId === undefined) return [];

  if (line.replacement === null || line.replacement === undefined) {
    return [{ kind: CONTEXT_EDIT_KIND, edits: [{ target }], data: { notice: "Context edit" } }];
  }

  const original = read.kept.get(line.targetId);

  // pi replaces the content of a message only: a summary, which is no message of the file's, keeps its words.
  if (original === undefined || original.role === "system") return [];

  const { content } = line.replacement;

  // SAFETY: the content a context edit carries replaces the content of the message it names, of the same role's shape (pi's `projectContextEntry`).
  const message = {
    ...original,
    content:
      original.role === "user" || !Predicate.isString(content)
        ? content
        : [{ type: "text", text: content }],
  } as Message;

  return [
    { kind: CONTEXT_EDIT_KIND, edits: [{ target, message }], data: { notice: "Context edit" } },
  ];
};

/** What a `custom` entry makes: none, it is extension state or it is counted. */
const customDrafts = (line: PiLine, tally: Tally): Draft[] => {
  const customType = line.customType ?? "";

  if (!takePiEntry(tally.state, customType, line.data, timeOf(line))) {
    drop(tally, `custom:${customType}`);
  }

  return [];
};

/** What a source entry makes: the entries, the last of them its own and those before it the calls it closed. */
const draftsOf = (line: PiLine, read: ReadState, tally: Tally): Draft[] => {
  switch (line.type) {
    case "message":
      return messageDrafts(line, read, tally);

    case "compaction":
      return compactionDrafts(line, read, tally);

    case "branch_summary":
      return branchSummaryDrafts(line, read, tally);

    case "custom_message":
      return customMessageDrafts(line, read, tally);

    case "context_edit":
      return contextEditDrafts(line, read);

    case "custom":
      return customDrafts(line, tally);

    default:
      if (!IGNORED.has(line.type)) drop(tally, line.type);

      return [];
  }
};

/**
 * What stands in for a result too large to keep: its call is answered, with an error, as a call that never had a result
 * is (`NOT_RUN_TEXT`), so the history stays one the provider accepts.
 */
export const TOO_LARGE_TEXT = "Not kept: the result was too large for the import to keep";

/**
 * `entry` held to its bound, or none when nothing could hold it (counted as `oversize:<kind>` by the caller). A tool
 * result is never dropped while it has a way to fit, because its call would stay open: its `details`, which the model
 * never sees, are replaced first, and then the whole result by an error result, counted as closed.
 */
const fitted = (entry: EntryRecord, tally: Tally): EntryRecord | undefined => {
  const first = fitEntry(entry);

  if (first.entry !== undefined) {
    if (first.cut) tally.cut += 1;

    return first.entry;
  }

  const [message] = entry.model ?? [];

  if (message?.role !== "toolResult") return undefined;

  message.details = { reason: "import_too_large" };

  const second = fitEntry(entry);

  if (second.entry !== undefined) {
    tally.cut += 1;

    return second.entry;
  }

  const replaced = fitEntry({
    ...entry,
    model: [
      {
        ...message,
        content: [{ type: "text", text: TOO_LARGE_TEXT }],
        details: { reason: "import_too_large" },
        isError: true,
      },
    ],
  });

  if (replaced.entry !== undefined) tally.closed += 1;

  return replaced.entry;
};

/** `draft` as an entry with the next ID, held to its bound; none when it could not be made to fit. */
const make = (draft: Draft, read: ReadState, tally: Tally): EntryRecord | undefined => {
  const entry = fitted(
    record(
      read.next,
      draft,
      (source) =>
        read.placed.get(source) ?? (read.waiting.includes(source) ? read.next : undefined),
    ),
    tally,
  );

  if (entry === undefined) {
    drop(tally, `oversize:${draft.kind}`);

    return undefined;
  }

  read.next += 1;
  tally.entries += 1;

  return entry;
};

/**
 * One read of the entries (the second and the third): every entry of the active branch as the entries it makes, with
 * `notice` made last when there is one. Counts into `tally`; stops at a line that is no entry, with `tally.failed`.
 */
function* walk(
  lines: Iterable<string>,
  plan: Plan,
  tally: Tally,
  notice: (() => string) | undefined,
): Generator<Piece> {
  const read = newReadState();
  let number = 0;
  let seen = false;

  for (const text of lines) {
    number += 1;

    if (text.trim() === "") continue;

    // The header was read first.
    if (!seen) {
      seen = true;

      continue;
    }

    const parsed = decodeLine(text);

    if (Option.isNone(parsed)) {
      tally.failed = `Line ${String(number)} is not a pi entry.`;

      return;
    }

    const line = parsed.value;

    if (plan.onPath !== undefined && line.id !== undefined && !plan.onPath.has(line.id)) continue;

    const drafts = draftsOf(line, read, tally);

    // Every entry but the last of a source entry's is a call it closed: the source entry's own is last.
    const own = drafts.length - 1;

    let produced = 0;

    for (const [at, draft] of drafts.entries()) {
      const entry = make(draft, read, tally);

      if (entry === undefined) continue;

      produced += 1;

      if (at === own && line.id !== undefined) {
        read.placed.set(line.id, entry.id);

        for (const source of read.waiting) read.placed.set(source, entry.id);

        read.waiting = [];

        const first = entry.model?.[0];

        if (plan.edited.has(line.id) && first !== undefined && line.type !== "compaction") {
          read.kept.set(line.id, first);
        }
      }

      yield {
        entry,
        bytes:
          at === own ? Math.max(MIN_PIECE_BYTES, encoder.encode(text).byteLength) : MIN_PIECE_BYTES,
      };
    }

    if (produced === 0 && line.id !== undefined) read.waiting.push(line.id);
  }

  for (const draft of closersOf(read, tally)) {
    const entry = make(draft, read, tally);

    if (entry !== undefined) yield { entry, bytes: MIN_PIECE_BYTES };
  }

  if (notice !== undefined) {
    const entry = make(
      messageDraft("pi.user", {
        role: "user",
        content: [{ type: "text", text: notice() }],
        timestamp: Date.now(),
      }),
      read,
      tally,
    );

    if (entry !== undefined) yield { entry, bytes: NOTICE_PIECE_BYTES };
  }
}

/** `pieces` as pages of at most `IMPORT_PAGE_ENTRIES` entries and about `IMPORT_PAGE_BYTES` bytes. */
function* paged(pieces: Iterable<Piece>): Generator<ReadonlyArray<EntryRecord>> {
  let page: EntryRecord[] = [];
  let size = 0;

  for (const piece of pieces) {
    if (
      page.length > 0 &&
      (page.length >= IMPORT_PAGE_ENTRIES || size + piece.bytes > IMPORT_PAGE_BYTES)
    ) {
      yield page;
      page = [];
      size = 0;
    }

    page.push(piece.entry);
    size += piece.bytes;
  }

  if (page.length > 0) yield page;
}

/** `lines` as something that can be read again: a generator, which reads once, is held. */
const readableAgain = (lines: Iterable<string>): Iterable<string> =>
  Object.is(lines[Symbol.iterator](), lines) ? Array.from(lines) : lines;

/** The tools the history called that `declared` does not offer, most called first; MCP tools are left out, which the Session may reach another way. */
const lackedBy = (called: ReadonlyMap<string, number>, declared: ReadonlyArray<string>): string[] =>
  Arr.map(
    Arr.sort(
      Arr.filter([...called], ([name]) => !declared.includes(name) && !name.startsWith("mcp__")),
      Order.combine(
        Order.mapInput(Order.flip(Order.Number), ([, count]: readonly [string, number]) => count),
        Order.mapInput(Order.String, ([name]: readonly [string, number]) => name),
      ),
    ),
    ([name]) => name,
  );

/**
 * The translation: messages unchanged, compaction and branch summaries and custom messages and context edits as entries,
 * the owner's Todo List and Notes as documents, everything bounded, dangling calls closed, MCP tool names spelled as
 * cloudpid spells them, and the notice last. See the section this file cites for what each kind becomes.
 */
export const translatePiSession: ImportTranslator = (input, facts) => {
  const lines = readableAgain(input);
  const plan = planOf(lines);

  if (Predicate.hasProperty(plan, "failed")) return plan;

  const tally = newTally();

  // The count read: nothing is held but the counts.
  for (const _piece of walk(lines, plan, tally, undefined)) {
    // Made and let go.
  }

  if (tally.failed !== undefined) return { failed: tally.failed };

  const summary: ImportSummary = { cut: tally.cut, dropped: tally.dropped, closed: tally.closed };
  const context = contextOf(tally.state);
  const todo = todoOf(tally.state);

  const text = importNotice(
    facts,
    {
      cwd: plan.cwd,
      tasks: todo?.tasks.length ?? 0,
      notes: context?.notes.length ?? 0,
      handoff: context?.handoff !== undefined && context.handoff !== null,
      lacking: facts.tools === undefined ? [] : lackedBy(tally.called, facts.tools),
    },
    summary,
  );

  return {
    version: TRANSLATOR_VERSION,
    summary,
    count: tally.entries + 1,
    pages: () => paged(walk(lines, plan, newTally(), () => text)),
    context,
    todo,
  };
};

/** Whether `translation` is one, not a failure. */
export const translated = (
  translation: Translation | TranslationFailure,
): translation is Translation => !Predicate.hasProperty(translation, "failed");
