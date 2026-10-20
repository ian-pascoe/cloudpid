// @effect-diagnostics asyncFunction:off preferEffectArray:off preferSchemaOverJson:off -- pi-durable commit callbacks are Promise code; History reads and searches stored entries' JSON text.
// `context_notes` and `context_history`, with pi-context-management's parameters and limits. Notes live in the
// conversation's Notes document (`./notes.ts`); History reads stored entries (`./history.ts`). The `lineage` scope also
// covers the conversations of the agents that spawned this one and that it spawned, read-only.
import { defineEffectTool } from "@cloudpid/effect-durable";
import type { ConversationId, EntryRecord, ToolExecutionApi } from "@earendil-works/pi-durable";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  callRange,
  describeEntry,
  entryRef,
  matchesFilter,
  PAGE_SIZE,
  parseRef,
  READ_CHARACTERS,
  search,
  type SearchItem,
  timestampOf,
  windowsOf,
} from "./history.ts";
import {
  ContextDoc,
  findNote,
  joinAppend,
  MAX_NOTE_CHARACTERS,
  MAX_NOTE_NAME,
  MAX_NOTES,
  type Note,
  NOTE_NAME,
  noteRef,
} from "./notes.ts";
import {
  type ContextError,
  durable,
  fail,
  lineage,
  type Owner,
  readContext,
  readEntries,
  readEntry,
  Refusal,
} from "./store.ts";

/** One line per tool for the system prompt, as pi-context-management's prompt guidelines. */
export const CONTEXT_GUIDELINES = {
  context_notes: "Keep named Notes with context_notes; read full Notes only when needed.",
  context_history:
    "Earlier History, including entries from before a Handoff, is available through context_history.",
  context_rollover:
    "Before Rollover, update Notes with context_notes, then call context_rollover alone with an explicit continuation Handoff.",
} as const;

const Scope = Schema.Literals(["branch", "lineage"]).annotate({
  description:
    'Conversations covered: "branch" (default) is this conversation; "lineage" adds the agents this agent was spawned by and spawned, read-only',
});

const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Ref = Schema.String.check(Schema.isMaxLength(300));

const Query = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

const NoteName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_NOTE_NAME),
  Schema.isPattern(NOTE_NAME),
);

const NotesParameters = Schema.Struct({
  action: Schema.Literals(["list", "read", "write", "append", "delete", "search", "copy"]),
  scope: Schema.optional(Scope),
  ref: Schema.optional(Ref),
  name: Schema.optional(NoteName),
  content: Schema.optional(Schema.String.check(Schema.isMaxLength(MAX_NOTE_CHARACTERS))),
  query: Schema.optional(Query),
  offset: Schema.optional(Offset),
  limit: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(MAX_NOTE_CHARACTERS),
    ),
  ),
});

const HistoryParameters = Schema.Struct({
  action: Schema.Literals(["windows", "list", "read", "search"]),
  scope: Schema.optional(Scope),
  ref: Schema.optional(Ref),
  window: Schema.optional(Ref),
  type: Schema.optional(
    Schema.String.check(Schema.isMaxLength(64)).annotate({
      description:
        'list/search: only entries of this kind, e.g. "pi.user", "pi.assistant", "pi.tool-result", "pi.reset", "pi.compaction"',
    }),
  ),
  role: Schema.optional(
    Schema.String.check(Schema.isMaxLength(64)).annotate({
      description:
        'list/search: only entries whose message has this role, e.g. "user", "assistant", "toolResult"',
    }),
  ),
  query: Schema.optional(Query),
  offset: Schema.optional(Offset),
  limit: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(READ_CHARACTERS)),
  ),
});

const NextOffset = Schema.NullOr(Schema.Int).annotate({
  description: "Offset of the next page or chunk, or null when this one is the last",
});

const Owned = {
  agent: Schema.optionalKey(
    Schema.String.annotate({ description: "lineage: owning agent, or root" }),
  ),
  session: Schema.optionalKey(
    Schema.String.annotate({ description: "lineage: owning conversation ID" }),
  ),
};

const Matches = Schema.Array(
  Schema.Struct({
    ref: Schema.String,
    name: Schema.optionalKey(
      Schema.String.annotate({ description: "Note name; absent for History" }),
    ),
    ...Owned,
    offset: Schema.Int,
    preview: Schema.String,
  }),
).annotate({ description: "search: literal matches" });

// Flat on purpose, as in pi-context-management: each action fills a different subset of the fields.
const NotesOutput = Schema.Struct({
  notes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        updated_at: Schema.String,
        ref: Schema.String,
        characters: Schema.Int,
        ...Owned,
      }),
    ).annotate({ description: "list: one page of Notes" }),
  ),
  matches: Schema.optionalKey(Matches),
  total: Schema.optionalKey(Schema.Int.annotate({ description: "list: total Notes" })),
  next_offset: Schema.optionalKey(NextOffset),
  name: Schema.optionalKey(
    Schema.String.annotate({ description: "read and mutations: the Note name" }),
  ),
  ref: Schema.optionalKey(Schema.String.annotate({ description: "read: the Note reference" })),
  ...Owned,
  content: Schema.optionalKey(Schema.String.annotate({ description: "read: Note text chunk" })),
  offset: Schema.optionalKey(Schema.Int.annotate({ description: "read: chunk start" })),
  total_characters: Schema.optionalKey(
    Schema.Int.annotate({ description: "read: length of the whole Note" }),
  ),
  action: Schema.optionalKey(
    Schema.Literals(["write", "append", "delete", "copy"]).annotate({
      description: "mutations: the action performed",
    }),
  ),
  saved: Schema.optionalKey(
    Schema.Literal(true).annotate({ description: "mutations: the change was persisted" }),
  ),
});

const HistoryOutput = Schema.Struct({
  windows: Schema.optionalKey(
    Schema.Array(Schema.Struct({ ref: Schema.String, items: Schema.Int })).annotate({
      description: "windows: one page of Context Windows",
    }),
  ),
  items: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        ref: Schema.String,
        type: Schema.String,
        timestamp: Schema.String,
        preview: Schema.String,
      }),
    ).annotate({ description: "list: one page of stored entries" }),
  ),
  matches: Schema.optionalKey(Matches),
  total: Schema.optionalKey(
    Schema.Int.annotate({ description: "windows/list: total windows or entries" }),
  ),
  next_offset: Schema.optionalKey(NextOffset),
  ref: Schema.optionalKey(Schema.String.annotate({ description: "read: the entry reference" })),
  resolved_in_session: Schema.optionalKey(
    Schema.String.annotate({ description: "read: the conversation holding the entry" }),
  ),
  format: Schema.optionalKey(Schema.Literal("recorded-entry-json")),
  content: Schema.optionalKey(Schema.String.annotate({ description: "read: entry JSON chunk" })),
  offset: Schema.optionalKey(Schema.Int.annotate({ description: "read: chunk start" })),
  total_characters: Schema.optionalKey(
    Schema.Int.annotate({ description: "read: length of the whole entry JSON" }),
  ),
});

type NotesResult = typeof NotesOutput.Type;

type HistoryResult = typeof HistoryOutput.Type;

/** The model reads the JSON text; scripts get the same value as an object. */
const result = <T extends NotesResult | HistoryResult>(data: T) => ({
  output: [{ type: "text" as const, text: JSON.stringify(data) }],
  structuredOutput: data,
});

/** Where the next page starts, or null after the last. */
const nextOffset = (offset: number, shown: number, total: number) =>
  offset + shown < total ? offset + shown : null;

/** A Note with the conversation that holds it, labelled when a scope reaches beyond the caller's own. */
type HeldNote = Note & {
  readonly conversationId: ConversationId;
  readonly owner?: Owner | undefined;
};

const ownerLabel = (owner: Owner | undefined) =>
  owner === undefined ? {} : { agent: owner.agent, session: String(owner.conversationId) };

/** The conversation `conversationId` is, when it is the caller's own or one of its lineage. */
const ownerIn = (api: ToolExecutionApi, conversationId: ConversationId) =>
  Effect.gen(function* () {
    if (conversationId === api.conversationId) return undefined;

    const found = (yield* lineage(api, api.conversationId)).find(
      (owner) => owner.conversationId === conversationId,
    );

    return found ?? (yield* fail("Reference is not in this agent's lineage"));
  });

/** The current version of the Note a reference names: the caller's own, or one of its lineage. */
const noteAt = (api: ToolExecutionApi, ref: string) =>
  Effect.gen(function* () {
    const parsed = parseRef(ref);

    if (parsed?.type !== "note") {
      return yield* fail("Not a Note reference; take one from context_notes list or search");
    }

    const owner = yield* ownerIn(api, parsed.conversationId);
    const note = findNote((yield* readContext(api, parsed.conversationId)).notes, parsed.name);

    if (note === undefined) {
      return yield* fail(
        owner === undefined ? "Note not found" : `Note not found in ${owner.agent}'s conversation`,
      );
    }

    return { ...note, conversationId: parsed.conversationId, owner } satisfies HeldNote;
  });

const notesIn = (api: ToolExecutionApi, owner: Owner) =>
  Effect.map(readContext(api, owner.conversationId), (state) =>
    state.notes.map((note): HeldNote => ({ ...note, conversationId: owner.conversationId, owner })),
  );

type NotesArgs = typeof NotesParameters.Type;

const notesTool = (args: NotesArgs, api: ToolExecutionApi) =>
  Effect.gen(function* () {
    const self = api.conversationId;
    const offset = args.offset ?? 0;
    const pageSize = Math.min(args.limit ?? PAGE_SIZE, PAGE_SIZE);

    const scoped = (): Effect.Effect<HeldNote[], ContextError> =>
      args.scope === "lineage"
        ? lineage(api, self).pipe(
            Effect.flatMap((owners) => Effect.forEach(owners, (owner) => notesIn(api, owner))),
            Effect.map((each) => each.flat()),
          )
        : Effect.map(readContext(api, self), (state) =>
            state.notes.map((note): HeldNote => ({ ...note, conversationId: self })),
          );

    switch (args.action) {
      case "list": {
        const notes = yield* scoped();
        const page = notes.slice(offset, offset + pageSize);

        return result({
          notes: page.map((note) => ({
            name: note.name,
            updated_at: DateTime.formatIso(DateTime.makeUnsafe(note.updatedAt)),
            ref: noteRef(note.conversationId, note.name),
            characters: note.content.length,
            ...ownerLabel(note.owner),
          })),
          total: notes.length,
          next_offset: nextOffset(offset, page.length, notes.length),
        });
      }

      case "search": {
        if (args.query === undefined) return yield* fail("A non-empty literal query is required");

        const notes = (yield* scoped()).filter(
          (note) => args.name === undefined || note.name === args.name,
        );

        return result(
          search(
            notes.map((note): SearchItem => ({
              ref: noteRef(note.conversationId, note.name),
              content: note.content,
              name: note.name,
              ...ownerLabel(note.owner),
            })),
            args.query,
            offset,
            pageSize,
          ),
        );
      }

      case "read": {
        let note: HeldNote | undefined;

        if (args.ref !== undefined) note = yield* noteAt(api, args.ref);
        else if (args.name !== undefined) {
          const found = findNote((yield* readContext(api, self)).notes, args.name);

          note = found === undefined ? undefined : { ...found, conversationId: self };
        } else return yield* fail("A Note name or ref is required");

        if (note === undefined) return yield* fail("Note not found");

        const content = note.content.slice(offset, offset + (args.limit ?? MAX_NOTE_CHARACTERS));

        return result({
          name: note.name,
          ref: noteRef(note.conversationId, note.name),
          ...ownerLabel(note.owner),
          content,
          offset,
          total_characters: note.content.length,
          next_offset: nextOffset(offset, content.length, note.content.length),
        });
      }

      case "write":
      case "append":
      case "delete":
      case "copy": {
        const action = args.action;

        if (action === "copy" && args.ref === undefined) {
          return yield* fail("copy needs the ref of a Note from context_notes list or search");
        }

        const source =
          action === "copy" && args.ref !== undefined ? yield* noteAt(api, args.ref) : undefined;

        const name = args.name ?? source?.name;

        if (name === undefined) return yield* fail("A Note name is required");

        if ((action === "write" || action === "append") && args.content === undefined) {
          return yield* fail("Note content is required");
        }

        const now = yield* Clock.currentTimeMillis;

        yield* durable("saveNote", (context) =>
          api.commit(async (tx) => {
            const state = await tx.doc(ContextDoc, self);
            const index = state.notes.findIndex((note) => note.name === name);
            const existing = state.notes[index];

            if (action === "delete") {
              if (existing === undefined) throw new Refusal("Note not found");

              state.notes.splice(index, 1);

              return;
            }

            if (action === "copy" && existing !== undefined) {
              throw new Refusal(
                `A Note named ${JSON.stringify(name)} already exists; pass name to copy under another name`,
              );
            }

            if (existing === undefined && state.notes.length >= MAX_NOTES) {
              throw new Refusal("Note limit reached; delete an obsolete Note first");
            }

            const content =
              action === "append"
                ? joinAppend(existing?.content ?? "", args.content ?? "")
                : (source?.content ?? args.content ?? "");

            if (content.length > MAX_NOTE_CHARACTERS) {
              throw new Refusal(`Note exceeds ${MAX_NOTE_CHARACTERS} characters`);
            }

            if (existing === undefined) state.notes.push({ name, content, updatedAt: now });
            else {
              existing.content = content;
              existing.updatedAt = now;
            }
          }, context),
        );

        return result({ action, name, saved: true as const });
      }
    }
  });

type HistoryArgs = typeof HistoryParameters.Type;

/** A stored entry with the conversation that holds it. */
type HeldEntry = { readonly entry: EntryRecord; readonly owner?: Owner | undefined };

const historyTool = (args: HistoryArgs, api: ToolExecutionApi) =>
  Effect.gen(function* () {
    const self = api.conversationId;
    const offset = args.offset ?? 0;
    const pageSize = Math.min(args.limit ?? PAGE_SIZE, PAGE_SIZE);
    const scoped = args.scope === "lineage";

    if (scoped && (args.action === "windows" || args.action === "list")) {
      return yield* fail(
        "windows and list browse this conversation only; use search with scope to find entries in other conversations, then read their refs",
      );
    }

    if (scoped && args.window !== undefined) {
      return yield* fail(
        "window selects one of this conversation's Context Windows; omit it with scope",
      );
    }

    if (args.action === "read") {
      if (args.ref === undefined) return yield* fail("An entry reference is required");

      const parsed = parseRef(args.ref);

      if (parsed?.type !== "entry") {
        return yield* fail("Not an entry reference; take one from context_history list or search");
      }

      yield* ownerIn(api, parsed.conversationId);

      const entry = yield* readEntry(api, parsed.conversationId, parsed.entryId);

      if (entry === undefined) return yield* fail("Entry not found in that conversation");

      const recorded = JSON.stringify(entry);
      const content = recorded.slice(offset, offset + (args.limit ?? READ_CHARACTERS));

      return result({
        ref: args.ref,
        resolved_in_session: String(parsed.conversationId),
        format: "recorded-entry-json" as const,
        content,
        offset,
        total_characters: recorded.length,
        next_offset: nextOffset(offset, content.length, recorded.length),
      });
    }

    const own = yield* readEntries(api, self);
    const windows = windowsOf(own);

    if (args.action === "windows") {
      const page = windows.slice(offset, offset + pageSize);

      return result({
        windows: page.map((window) => ({
          // SAFETY: a window starts at one of `own`'s indexes.
          ref: entryRef(self, own[window.start]!.id),
          items: window.end - window.start,
        })),
        total: windows.length,
        next_offset: nextOffset(offset, page.length, windows.length),
      });
    }

    let entries = own;

    if (args.window !== undefined) {
      const parsed = parseRef(args.window);

      const window = windows.find(
        (each) =>
          parsed?.type === "entry" &&
          parsed.conversationId === self &&
          own[each.start]?.id === parsed.entryId,
      );

      if (window === undefined) return yield* fail("No such Context Window in this conversation");

      entries = own.slice(window.start, window.end);
    }

    const filtered = (items: ReadonlyArray<EntryRecord>) =>
      items.filter((entry) => matchesFilter(entry, args.type, args.role));

    if (args.action === "list") {
      const listed = filtered(entries);
      const page = listed.slice(offset, offset + pageSize);

      return result({
        items: page.map((entry) => ({
          ref: entryRef(self, entry.id),
          type: entry.kind,
          timestamp: timestampOf(entry),
          preview: describeEntry(entry),
        })),
        total: listed.length,
        next_offset: nextOffset(offset, page.length, listed.length),
      });
    }

    if (args.query === undefined) return yield* fail("A non-empty literal query is required");

    const held: HeldEntry[] = filtered(entries).map((entry) => ({ entry }));

    if (scoped) {
      for (const owner of (yield* lineage(api, self)).slice(1)) {
        for (const entry of filtered(yield* readEntries(api, owner.conversationId))) {
          held.push({ entry, owner });
        }
      }
    }

    // The newest assistant entry holds this call, which must not match its own query.
    const running = own.findLast((entry) => entry.model?.[0]?.role === "assistant");

    return result(
      search(
        held.map(({ entry, owner }): SearchItem => {
          const content = JSON.stringify(entry);

          return {
            ref: entryRef(owner?.conversationId ?? self, entry.id),
            content,
            recorded: true,
            skip:
              owner === undefined && entry === running
                ? callRange(entry, content, api.callId)
                : undefined,
            ...ownerLabel(owner),
          };
        }),
        args.query,
        offset,
        pageSize,
      ),
    );
  });

export const ContextNotes = defineEffectTool({
  name: "context_notes",
  description:
    'Conversation Markdown Notes, kept across Handoffs. Actions list/read/write/append/delete/search/copy. Names are labels, not paths. list/search with scope "lineage" also cover the current Notes of agents that spawned this agent or that it spawned, labelled by agent; those are read-only. read takes a name for your own Notes or a ref from list/search for any; copy saves the Note a ref names into your Notes, under name if given, as an unlinked snapshot. read returns the whole Note unless offset/limit select a character range; lists return at most 20 Notes. Append starts the new text on a new line unless the Note is empty or already ends with one. Search is case-sensitive literal text. Forks inherit Notes.',
  parameters: NotesParameters,
  structuredOutputSchema: Schema.toJsonSchemaDocument(NotesOutput).schema,
  executionMode: "sequential",
  execute: notesTool,
});

export const ContextHistory = defineEffectTool({
  name: "context_history",
  description:
    'Read-only stored History of this conversation, including entries from before a Handoff or compaction. search also accepts scope "lineage" to cover the conversations of agents that spawned this agent or that it spawned; read accepts any ref search returns. windows/list/search are paginated (max 20); read returns exact stored entry JSON, at most 2000 characters per call from a zero-based offset. Search is case-sensitive literal text, with JSON string escaping handled for you; returned offsets address the entry JSON. Optional window limits list/search to one Context Window. Optional type (entry kind, e.g. pi.user) and role (message role, e.g. user) filter list/search; by default every entry is included, and list previews describe each entry\'s text, tool call, or kind. Search previews are decoded readable text; a direct search call does not match its own tool-call block. Other conversations are never written.',
  parameters: HistoryParameters,
  structuredOutputSchema: Schema.toJsonSchemaDocument(HistoryOutput).schema,
  executionMode: "sequential",
  execute: historyTool,
});
