// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over pi-durable's records.
// Forks and Clones (GLOSSARY.md → Fork, Clone; ADR-0017): a new Session carrying another's active branch up to a point.
// pi-durable forks only inside one Session, and every Session is a Durable Object of its own, so the new Session is
// filled by copying: the source answers what to copy (`ForkPlan`) and the branch's entries in pages, and the new Session
// appends them to its root conversation, renumbered, then takes the documents a fork carries (Notes, the Todo List) and
// the agent as of the point.
import type { ContextState } from "@cloudpid/extensions/context";
import type { McpQuestionCopy } from "@cloudpid/extensions/mcp";
import type { TodoState } from "@cloudpid/extensions/todo";
import type {
  AttachedResource,
  McpAppCopy,
  McpAppStub,
  McpPromptData,
  TreePoint,
  VisualCopy,
  VisualStub,
} from "@cloudpid/protocol";
import type {
  AgentState,
  ContextEdit,
  ConversationId,
  EntryDraft,
  EntryId,
  EntryRecord,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type { Mutable } from "effect/Types";
import type { AgentPick } from "./pick.ts";

/** About the most one page of copied entries holds, in UTF-16 code units of their JSON: well under an RPC's 32 MiB. */
export const MAX_COPY_PAGE_SIZE = 8 * 1024 * 1024;

/** The most entries one page reads. */
export const EXPORT_PAGE_ENTRIES = 200;

/**
 * What must be at rest while a Fork or Clone takes its source: nothing (a Fork in the same Workspace, which may be made
 * while a Run goes on), the active branch (a Clone, which takes the branch as it stands), or the whole Session, every
 * branch and subagent, whose files a new Workspace carries.
 */
export type ForkQuiet = "none" | "branch" | "session";

/** What a Fork or Clone asks its source for: the point (none: the branch as it is now, a Clone), and what must be at rest. */
export type ForkSourceRequest = {
  readonly point?: TreePoint;
  readonly quiet: ForkQuiet;
};

/** What a Fork or Clone carries besides the entries, as its source answers it. */
export type ForkPlan = {
  /** The source's Session branch whose path is copied. */
  readonly conversationId: ConversationId;
  /** The last entry copied; null when there is none (a Fork before the Session's first message). */
  readonly through: number | null;
  /** The owner's message the new composer starts with: the one a Fork was made before. */
  readonly text: string | null;
  /** The MCP prompt that message had, which the new composer gets back as its chip (`Navigated.mcpPrompt`). */
  readonly mcpPrompt?: McpPromptData;
  /** The MCP resources that message attached, which the new composer gets back as chips (`Navigated.resources`). */
  readonly resources?: ReadonlyArray<AttachedResource>;
  /** The branch's agent as of the point: its model, thinking level, loaded tools and the rest of `pi.agent`. */
  readonly agent: AgentState;
  /** The model and thinking level the source picked itself, which the new Session keeps picked. */
  readonly pick: AgentPick;
  /** The branch's Notes and last Handoff, as they are now. */
  readonly context: ContextState | null;
  /** The branch's Todo List, as it is now. */
  readonly todo: TodoState | null;
};

/** A page of the entries a Fork copies: those of `conversationId`'s path after `after` (none: from the start) through `through`. */
export type ExportRequest = {
  readonly conversationId: ConversationId;
  readonly through: number;
  readonly after: number | null;
};

/**
 * One page of the entries a Fork copies, oldest first, and the entry the next page starts after (null: the last), and the
 * App records (and stubs) of the calls those entries hold the results of (`apps`; absent when there are none, or from a
 * Session before App records: a page only ever gains), and likewise the settled question records of those calls
 * (`questions`, never a value), and the Visuals of those calls (`visuals`, as the App records are).
 */
export type ExportPage = {
  readonly entries: ReadonlyArray<EntryRecord>;
  readonly next: number | null;
  readonly apps?: ReadonlyArray<McpAppCopy>;
  readonly questions?: ReadonlyArray<McpQuestionCopy>;
  readonly visuals?: ReadonlyArray<VisualCopy>;
};

/** The IDs of the tool calls whose results `entry` holds: the calls it copies, and the `codemode` calls that nested ones belong to. */
export const toolResultIds = (entry: EntryRecord): ReadonlyArray<string> =>
  Arr.flatMap(entry.model ?? [], (message) =>
    message.role === "toolResult" ? [message.toolCallId] : [],
  );

/** What a copy of the entries carries of each: the App records of the calls whose results it holds (`McpAppsService.copiesFor`). */
export type AppCopier = (entry: EntryRecord) => ReadonlyArray<McpAppCopy>;

/**
 * What a copy of the entries carries of each besides: the settled question and Sampling records of the calls whose results
 * it holds, as many whole as fit in `budget` characters (`McpQuestionCopier`).
 */
export type QuestionCopier = (entry: EntryRecord, budget: number) => ReadonlyArray<McpQuestionCopy>;

/** What a copy carries of the Visuals of the calls whose results an entry holds (`VisualCopies.copiesFor`). */
export type VisualCopier = (entry: EntryRecord) => ReadonlyArray<VisualCopy>;

/** What a record is left as when it does not fit a page: its stub (who the call was, and its time). */
const stubOfCopy = (copy: McpAppCopy): McpAppCopy => {
  if (copy.kind !== "record" || !("record" in copy)) return copy;

  const { callId, server, tool, conversation, parentCall, at } = copy.record;
  const stub: Mutable<McpAppStub> = { callId, server, tool, conversation, at };

  if (parentCall !== undefined) stub.parentCall = parentCall;

  return { kind: "stub", stub };
};

/** What a Visual is left as when it does not fit a page: its stub, everything its card shows without the page. */
const stubOfVisualCopy = (copy: VisualCopy): VisualCopy => {
  if (copy.kind !== "record" || !("record" in copy)) return copy;

  const { callId, conversation, parentCall, title, summary, source, bytes, at } = copy.record;
  const stub: Mutable<VisualStub> = { callId, conversation, title, summary, source, bytes, at };

  if (parentCall !== undefined) stub.parentCall = parentCall;

  return { kind: "stub", stub };
};

/**
 * `copies` as they fit in `budget` characters: the records in order while they do, the rest as stubs (`stubOf`). A page is a
 * single RPC's value and an entry is never split from its copies, so what one entry's calls hold past the budget (a
 * `codemode` script with many App calls or Visuals) is carried as stubs, which a card shows as "no longer kept".
 */
const fitCopies = <C extends { readonly kind: string }>(
  copies: ReadonlyArray<C>,
  budget: number,
  stubOf: (copy: C) => C,
): ReadonlyArray<C> => {
  let left = budget;

  return Arr.map(copies, (copy) => {
    const length = JSON.stringify(copy).length;

    if (copy.kind === "stub" || length <= left) {
      left -= length;

      return copy;
    }

    const stub = stubOf(copy);

    left -= JSON.stringify(stub).length;

    return stub;
  });
};

/**
 * `entries` cut to a page: as many as fit in `MAX_COPY_PAGE_SIZE` (always one), counting the App records they carry
 * (`appsOf`: the records of the calls an entry holds the results of), and where the next page starts, or null when they are
 * all of what is left (`more` false) and all fit.
 */
export const exportPage = (
  entries: ReadonlyArray<EntryRecord>,
  more: boolean,
  appsOf?: AppCopier,
  questionsOf?: QuestionCopier,
  visualsOf?: VisualCopier,
): ExportPage => {
  const kept: EntryRecord[] = [];
  const apps: McpAppCopy[] = [];
  const questions: McpQuestionCopy[] = [];
  const visuals: VisualCopy[] = [];
  let size = 0;

  for (const entry of entries) {
    const own = JSON.stringify(entry).length;

    const copies =
      appsOf === undefined
        ? []
        : fitCopies(appsOf(entry), Math.max(0, MAX_COPY_PAGE_SIZE - own), stubOfCopy);

    const withApps = own + Arr.reduce(copies, 0, (sum, copy) => sum + JSON.stringify(copy).length);

    // The question records fit beside the entries (64 KiB each, the Session keeps 100); a Sampling record past the page's
    // budget is carried as its stub, as an App record is.
    const asked =
      questionsOf === undefined
        ? []
        : questionsOf(entry, Math.max(0, MAX_COPY_PAGE_SIZE - withApps));

    const withQuestions =
      withApps + Arr.reduce(asked, 0, (sum, record) => sum + JSON.stringify(record).length);

    // The Visuals fit in what is left, a page at most 2 MiB each, the rest of an entry's as stubs.
    const shown =
      visualsOf === undefined
        ? []
        : fitCopies(
            visualsOf(entry),
            Math.max(0, MAX_COPY_PAGE_SIZE - withQuestions),
            stubOfVisualCopy,
          );

    const length =
      withQuestions + Arr.reduce(shown, 0, (sum, copy) => sum + JSON.stringify(copy).length);

    if (kept.length > 0 && size + length > MAX_COPY_PAGE_SIZE) break;

    kept.push(entry);
    apps.push(...copies);
    questions.push(...asked);
    visuals.push(...shown);
    size += length;
  }

  const last = kept.at(-1);
  const next = last === undefined || (!more && kept.length === entries.length) ? null : last.id;

  const page: Mutable<ExportPage> = { entries: kept, next };

  if (apps.length > 0) page.apps = apps;

  if (questions.length > 0) page.questions = questions;

  if (visuals.length > 0) page.visuals = visuals;

  return page;
};

/** The source Session's side of filling a Fork or Clone. */
export type FillSource<E, R> = {
  readonly exportEntries: (request: ExportRequest) => Effect.Effect<ExportPage, E, R>;
};

/** The new Session's side of filling it. */
export type FillTarget<E, R> = {
  readonly importStart: Effect.Effect<void, E, R>;
  readonly importEntries: (
    entries: ReadonlyArray<EntryRecord>,
    apps?: ReadonlyArray<McpAppCopy>,
    questions?: ReadonlyArray<McpQuestionCopy>,
    visuals?: ReadonlyArray<VisualCopy>,
  ) => Effect.Effect<void, E, R>;
  readonly importFinish: (plan: ForkPlan) => Effect.Effect<void, E, R>;
};

/** Fill new Session `target` with what `plan` of Session `source` carries: its entries, a page at a time, then the rest. */
export const fillSession = <E, R>(
  source: FillSource<E, R>,
  target: FillTarget<E, R>,
  plan: ForkPlan,
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    yield* target.importStart;

    const through = plan.through;

    // A Fork before the Session's first message copies no entry.
    if (through !== null) {
      let after: number | null = null;

      do {
        const page: ExportPage = yield* source.exportEntries({
          conversationId: plan.conversationId,
          through,
          after,
        });

        yield* target.importEntries(page.entries, page.apps, page.questions, page.visuals);
        after = page.next;
      } while (after !== null);
    }

    yield* target.importFinish(plan);
  });

/** An `EntryDraft` while `copiedDraft` fills it in. */
type DraftBeingMade = { -readonly [K in keyof EntryDraft]: EntryDraft[K] };

/**
 * The draft that appends a copy of `entry`, with the entries it names renumbered by `ids` (source ID → copy's ID): its
 * head (its own ID is `self`) and its edits' targets. A head or an edit naming an entry not copied is left out.
 */
export const copiedDraft = (entry: EntryRecord, ids: ReadonlyMap<number, number>): EntryDraft => {
  const draft: DraftBeingMade = { kind: entry.kind };

  if (entry.model !== undefined) draft.model = entry.model;

  if (entry.data !== undefined) draft.data = entry.data;

  if (entry.head !== undefined) {
    const head = entry.head === entry.id ? "self" : ids.get(entry.head);

    if (head !== undefined) {
      // SAFETY: an ID the copy's Session assigned to an entry it appended.
      draft.head = head as EntryId | "self";
    }
  }

  if (entry.edits !== undefined) {
    const edits = entry.edits.flatMap((edit): ContextEdit[] => {
      const target = ids.get(edit.target);

      // SAFETY: as above.
      return target === undefined ? [] : [{ ...edit, target: target as ContextEdit["target"] }];
    });

    if (edits.length > 0) draft.edits = edits;
  }

  return draft;
};

/** The agent of a conversation that never had one written: pi-durable's defaults throughout. */
export const NO_AGENT: AgentState = {};

/** The fields of `pi.agent` a copy takes from its source: every one, as the source stored them (tool names). */
const AGENT_FIELDS = [
  "model",
  "thinkingLevel",
  "extensions",
  "tools",
  "modelTools",
  "instructions",
  "cwd",
] as const satisfies ReadonlyArray<keyof AgentState>;

/** Give `draft` field `field` of `agent`, or drop it when `agent` has none. */
const copyField = <K extends (typeof AGENT_FIELDS)[number]>(
  draft: AgentState,
  agent: AgentState,
  field: K,
): void => {
  const value = agent[field];

  if (value === undefined) delete draft[field];
  else draft[field] = structuredClone(value);
};

/** Give `draft` (the copy's `pi.agent`) every field of `agent` the source set, and drop those it did not. */
export const copyAgent = (draft: AgentState, agent: AgentState): void => {
  for (const field of AGENT_FIELDS) copyField(draft, agent, field);
};
