// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over pi-durable's records.
// Forks and Clones (GLOSSARY.md → Fork, Clone; ADR-0017): a new Session carrying another's active branch up to a point.
// pi-durable forks only inside one Session, and every Session is a Durable Object of its own, so the new Session is
// filled by copying: the source answers what to copy (`ForkPlan`) and the branch's entries in pages, and the new Session
// appends them to its root conversation, renumbered, then takes the documents a fork carries (Notes, the Todo List) and
// the agent as of the point.
import type { ContextState } from "@cloudpid/extensions/context";
import type { TodoState } from "@cloudpid/extensions/todo";
import type {
  AgentState,
  ContextEdit,
  EntryDraft,
  EntryId,
  EntryRecord,
  ModelRef,
} from "@earendil-works/pi-durable";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** About the most one page of copied entries holds, in UTF-16 code units of their JSON: well under an RPC's 32 MiB. */
export const MAX_EXPORT_BYTES = 8 * 1024 * 1024;

/** The most entries one page reads. */
export const EXPORT_PAGE_ENTRIES = 200;

/** What a Fork or Clone carries besides the entries, as its source answers it. */
export type ForkPlan = {
  /** The source's Session branch whose path is copied. */
  readonly conversationId: number;
  /** The last entry copied; null when there is none (a Fork before the Session's first message). */
  readonly through: number | null;
  /** The owner's message the new composer starts with: the one a Fork was made before. */
  readonly text: string | null;
  /** The branch's agent as of the point: its model, thinking level, loaded tools and the rest of `pi.agent`. */
  readonly agent: AgentState;
  /** The model and thinking level the source picked itself, which the new Session keeps picked. */
  readonly pick: { readonly model?: ModelRef; readonly thinkingLevel?: ModelThinkingLevel };
  /** The branch's Notes and last Handoff, as they are now. */
  readonly context: ContextState | null;
  /** The branch's Todo List, as it is now. */
  readonly todo: TodoState | null;
};

/** One page of the entries a Fork copies, oldest first, and the entry the next page starts after (null: the last). */
export type ExportPage = {
  readonly entries: ReadonlyArray<EntryRecord>;
  readonly next: number | null;
};

/**
 * `entries` cut to a page: as many as fit in `MAX_EXPORT_BYTES` (always one), and where the next page starts, or null
 * when they are all of what is left (`more` false) and all fit.
 */
export const exportPage = (entries: ReadonlyArray<EntryRecord>, more: boolean): ExportPage => {
  const kept: EntryRecord[] = [];
  let size = 0;

  for (const entry of entries) {
    const bytes = JSON.stringify(entry).length;

    if (kept.length > 0 && size + bytes > MAX_EXPORT_BYTES) break;

    kept.push(entry);
    size += bytes;
  }

  const last = kept.at(-1);

  return {
    entries: kept,
    next: last === undefined || (!more && kept.length === entries.length) ? null : last.id,
  };
};

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
