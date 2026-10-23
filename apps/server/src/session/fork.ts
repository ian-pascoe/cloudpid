// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over pi-durable's records.
// Forks and Clones (GLOSSARY.md → Fork, Clone; ADR-0017): a new Session carrying another's active branch up to a point.
// pi-durable forks only inside one Session, and every Session is a Durable Object of its own, so the new Session is
// filled by copying: the source answers what to copy (`ForkPlan`) and the branch's entries in pages, and the new Session
// appends them to its root conversation, renumbered, then takes the documents a fork carries (Notes, the Todo List) and
// the agent as of the point.
import type { ContextState } from "@cloudpid/extensions/context";
import type { TodoState } from "@cloudpid/extensions/todo";
import type { TreePoint } from "@cloudpid/protocol";
import type {
  AgentState,
  ContextEdit,
  ConversationId,
  EntryDraft,
  EntryId,
  EntryRecord,
} from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
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

/** One page of the entries a Fork copies, oldest first, and the entry the next page starts after (null: the last). */
export type ExportPage = {
  readonly entries: ReadonlyArray<EntryRecord>;
  readonly next: number | null;
};

/**
 * `entries` cut to a page: as many as fit in `MAX_COPY_PAGE_SIZE` (always one), and where the next page starts, or null
 * when they are all of what is left (`more` false) and all fit.
 */
export const exportPage = (entries: ReadonlyArray<EntryRecord>, more: boolean): ExportPage => {
  const kept: EntryRecord[] = [];
  let size = 0;

  for (const entry of entries) {
    const length = JSON.stringify(entry).length;

    if (kept.length > 0 && size + length > MAX_COPY_PAGE_SIZE) break;

    kept.push(entry);
    size += length;
  }

  const last = kept.at(-1);

  return {
    entries: kept,
    next: last === undefined || (!more && kept.length === entries.length) ? null : last.id,
  };
};

/** The source Session's side of filling a Fork or Clone. */
export type FillSource<E, R> = {
  readonly exportEntries: (request: ExportRequest) => Effect.Effect<ExportPage, E, R>;
};

/** The new Session's side of filling it. */
export type FillTarget<E, R> = {
  readonly importStart: Effect.Effect<void, E, R>;
  readonly importEntries: (entries: ReadonlyArray<EntryRecord>) => Effect.Effect<void, E, R>;
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

        yield* target.importEntries(page.entries);
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
