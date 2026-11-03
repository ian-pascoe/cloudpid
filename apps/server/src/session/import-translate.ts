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

/** What a translation made: the counts, the extension state, and the root conversation's entries as pages, the notice last. */
export type Translation = {
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

/** What an error result for a call that never had one says (D25.1). */
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
  /** The entry's head: a source entry's ID, or its own (`selfHead`), where the context starts at the entry itself. */
  readonly head?: string;
  readonly selfHead?: true;
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

/** Whether `value` is a part of a user message's content: text or an image. */
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
    draft.selfHead === true
      ? id
      : draft.head === undefined
        ? undefined
        : (headOf(draft.head) ?? id);

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
type Piece = { readonly entry: EntryRecord; readonly size: number };

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
  let next = 1;
  let number = 0;
  let seen = false;
  /** The entry each source entry became, by the source's ID. */
  const placed = new Map<string, number>();
  /** Source entries that made no entry, which take the next one: a head that named one starts there. */
  let waiting: string[] = [];
  /** The calls of the last assistant message that no result has answered. */
  const open = new Map<string, { readonly name: string; readonly timestamp: number }>();
  /** The messages of the entries a context edit names, to be replaced. */
  const kept = new Map<string, Message>();

  /** An error result for each call still open, which ends them. */
  const closers = (): Draft[] => {
    const drafts = Arr.map([...open], ([id, call]) =>
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
    open.clear();

    return drafts;
  };

  /** What a source entry of kind `type` makes. */
  const draftsOf = (line: PiLine): Draft[] => {
    const { type, message } = line;

    switch (type) {
      case "message": {
        if (message === undefined) {
          drop(tally, "message:unknown");

          return [];
        }

        if (message.role === "user") {
          if (Predicate.isNullish(message.content)) message.content = [];

          return [...closers(), messageDraft("pi.user", message)];
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

          const before = closers();

          if (!EXCLUDED_STOPS.has(message.stopReason)) {
            for (const call of calls) {
              open.set(call.id, { name: call.name, timestamp: message.timestamp });
            }
          }

          return [...before, messageDraft("pi.assistant", message)];
        }

        if (message.role === "toolResult") {
          if (Predicate.isNullish(message.content)) message.content = [];

          if (Predicate.isString(message.toolName)) {
            message.toolName = mcpToolNameFromPi(message.toolName);
          }

          open.delete(message.toolCallId);

          return [messageDraft("pi.tool-result", message)];
        }

        // System messages carry the laptop's prompt and tool list, and are never imported.
        if (message.role === "system") return [];

        // SAFETY: the guard says only that the message has a string `role`; one that is none of the four is told apart by it.
        drop(tally, `message:${(message as { readonly role: string }).role}`);

        return [];
      }

      case "compaction": {
        if (!Predicate.isString(line.summary)) {
          drop(tally, type);

          return [];
        }

        const summary: Message = {
          role: "user",
          content: [
            { type: "text", text: `${COMPACTION_PREFIX}${line.summary}${COMPACTION_SUFFIX}` },
          ],
          timestamp: timeOf(line),
        };

        // The kept entries start at `firstKeptEntryId`, as pi starts them; one that is not on the branch leaves the summary alone.
        return [
          ...closers(),
          {
            kind: "pi.compaction",
            model: [summary],
            data: { reason: "manual" },
            ...(line.firstKeptEntryId === undefined
              ? { selfHead: true as const }
              : { head: line.firstKeptEntryId }),
          },
        ];
      }

      case "branch_summary":
        return line.summary === undefined || line.summary === ""
          ? []
          : [
              ...closers(),
              {
                kind: BRANCH_SUMMARY_KIND,
                model: [summaryMessage(line.summary, timeOf(line))],
                data: { notice: "Branch summary" },
              },
            ];

      case "custom_message":
        return [
          ...closers(),
          messageDraft("pi.user", {
            role: "user",
            content: keepContent(line.content ?? []),
            timestamp: timeOf(line),
          }),
        ];

      case "context_edit": {
        const target = line.targetId === undefined ? undefined : placed.get(line.targetId);

        if (target === undefined || line.targetId === undefined) return [];

        if (line.replacement === null || line.replacement === undefined) {
          return [
            { kind: CONTEXT_EDIT_KIND, edits: [{ target }], data: { notice: "Context edit" } },
          ];
        }

        const original = kept.get(line.targetId);

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
          {
            kind: CONTEXT_EDIT_KIND,
            edits: [{ target, message }],
            data: { notice: "Context edit" },
          },
        ];
      }

      case "custom": {
        const customType = line.customType ?? "";

        if (!takePiEntry(tally.state, customType, line.data, timeOf(line))) {
          drop(tally, `custom:${customType}`);
        }

        return [];
      }

      default:
        if (!IGNORED.has(type)) drop(tally, type);

        return [];
    }
  };

  /** `draft` as an entry with the next ID, held to its bound; none when it could not be made to fit. */
  const make = (draft: Draft): EntryRecord | undefined => {
    const fitted = fitEntry(
      record(
        next,
        draft,
        (source) => placed.get(source) ?? (waiting.includes(source) ? next : undefined),
      ),
    );

    if (fitted.cut) tally.cut += 1;

    if (fitted.entry === undefined) {
      drop(tally, `oversize:${draft.kind}`);

      return undefined;
    }

    next += 1;
    tally.entries += 1;

    return fitted.entry;
  };

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

    const drafts = draftsOf(line);

    // Every entry but the last of a source entry's is a call it closed: the source entry's own is last.
    const own = drafts.length - 1;

    let produced = 0;

    for (const [at, draft] of drafts.entries()) {
      const entry = make(draft);

      if (entry === undefined) continue;

      produced += 1;

      if (at === own && line.id !== undefined) {
        placed.set(line.id, entry.id);

        for (const source of waiting) placed.set(source, entry.id);

        waiting = [];

        const first = entry.model?.[0];

        if (plan.edited.has(line.id) && first !== undefined && line.type !== "compaction") {
          kept.set(line.id, first);
        }
      }

      yield { entry, size: Math.max(512, at === own ? text.length : 512) };
    }

    if (produced === 0 && line.id !== undefined) waiting.push(line.id);
  }

  for (const draft of closers()) {
    const entry = make(draft);

    if (entry !== undefined) yield { entry, size: 512 };
  }

  if (notice !== undefined) {
    const entry = make(
      messageDraft("pi.user", {
        role: "user",
        content: [{ type: "text", text: notice() }],
        timestamp: Date.now(),
      }),
    );

    if (entry !== undefined) yield { entry, size: 4096 };
  }
}

/** `pieces` as pages of at most `IMPORT_PAGE_ENTRIES` entries and about `IMPORT_PAGE_BYTES` bytes. */
function* paged(pieces: Iterable<Piece>): Generator<ReadonlyArray<EntryRecord>> {
  let page: EntryRecord[] = [];
  let size = 0;

  for (const piece of pieces) {
    if (
      page.length > 0 &&
      (page.length >= IMPORT_PAGE_ENTRIES || size + piece.size > IMPORT_PAGE_BYTES)
    ) {
      yield page;
      page = [];
      size = 0;
    }

    page.push(piece.entry);
    size += piece.size;
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
