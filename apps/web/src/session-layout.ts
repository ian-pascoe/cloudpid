// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- short native lists of IDs, and plain helpers.

// A Session page's layout (GLOSSARY.md → Session layout): what the owner opened, collapsed and picked on it, kept per
// Session on this device so that going back to a Session shows it as it was left. This module is the rules over it,
// with no atoms and no React (`session-layout-state.ts` keeps it).
//
// It holds the Pane area (the Panes open, the one shown, whether the area is hidden), whether the Activity card is
// expanded, which subagents are open in the Subagents Pane and in the transcript's cards, which of the transcript's
// disclosures (tool cards, thinking, Skills, notices) are open, and the Session tree Pane's filter. Only the Sessions
// shown last are kept (`MAX_LAYOUTS`): a Session not opened for that long starts afresh.

import * as Schema from "effect/Schema";
import { NO_PANES, paneAreaOf, searchWithPaneArea, type PaneArea } from "./panes.ts";
import { TREE_FILTER_VALUES, type TreeFilter } from "./session/tree.ts";

/**
 * The owner's choice for the Activity card: expanded or collapsed, made while the Todo List held `items`
 * (`todoItemsOf`) and was `settled` or not. It holds for as long as both still say the same: a new Todo List, or one
 * that settles (or has more to do again), shows as the card's default does.
 */
export interface ActivityChoice {
  readonly expanded: boolean;
  readonly items: readonly string[];
  readonly settled: boolean;
}

/** One Session's layout. */
export interface SessionLayout {
  readonly panes: PaneArea;
  /** Undefined while the owner has not expanded or collapsed the card. */
  readonly activity: ActivityChoice | undefined;
  /** The conversations of the subagents open in the Subagents Pane. */
  readonly openAgents: readonly number[];
  /** The conversations of the subagent cards open in the transcript. */
  readonly openCards: readonly number[];
  /** The transcript's disclosures open (`disclosureKey`). */
  readonly openDisclosures: readonly string[];
  readonly treeFilter: TreeFilter;
}

/** A Session's layout until the owner changes it: nothing open, every default. */
export const DEFAULT_LAYOUT: SessionLayout = {
  panes: NO_PANES,
  activity: undefined,
  openAgents: [],
  openCards: [],
  openDisclosures: [],
  treeFilter: "default",
};

/** How many Sessions' layouts this device keeps: the ones shown last. */
export const MAX_LAYOUTS = 50;

/** How many open things a layout keeps in each list, the last opened. */
const MAX_OPEN = 100;

/**
 * A layout as it is stored. Every field may be missing, so a layout stored before a field was added reads with its
 * default; the Pane keys are checked against the Pane types when read (`layoutOf`), as a URL's are.
 */
const StoredLayout = Schema.Struct({
  panes: Schema.optional(
    Schema.Struct({
      open: Schema.Array(Schema.String),
      shown: Schema.optional(Schema.String),
      hidden: Schema.Boolean,
    }),
  ),
  activity: Schema.optional(
    Schema.Struct({
      expanded: Schema.Boolean,
      items: Schema.Array(Schema.String),
      settled: Schema.Boolean,
    }),
  ),
  openAgents: Schema.Array(Schema.Finite).pipe(Schema.optional),
  openCards: Schema.Array(Schema.Finite).pipe(Schema.optional),
  openDisclosures: Schema.Array(Schema.String).pipe(Schema.optional),
  treeFilter: Schema.optional(Schema.Literals(TREE_FILTER_VALUES)),
});

/** The layouts this device keeps, the Session shown last first. */
export const StoredLayouts = Schema.Array(
  Schema.Struct({ sessionId: Schema.String, layout: StoredLayout }),
);

export type StoredLayouts = typeof StoredLayouts.Type;

type Stored = typeof StoredLayout.Type;

/**
 * `panes` as the Pane types allow it: what a URL holding it would open, so a key no type opens is dropped and one that
 * was renamed (`tasks`) reads as its new name.
 */
const checkedPanes = (panes: Stored["panes"]): PaneArea =>
  panes === undefined
    ? NO_PANES
    : paneAreaOf(
        searchWithPaneArea("", { open: panes.open, shown: panes.shown, hidden: panes.hidden }),
      );

/** The layout of Session `sessionId` among `stored`; the default for one this device has not kept. */
export const layoutOf = (stored: StoredLayouts, sessionId: string): SessionLayout => {
  const found = stored.find((entry) => entry.sessionId === sessionId)?.layout;

  if (found === undefined) return DEFAULT_LAYOUT;

  return {
    panes: checkedPanes(found.panes),
    activity: found.activity,
    openAgents: found.openAgents ?? [],
    openCards: found.openCards ?? [],
    openDisclosures: found.openDisclosures ?? [],
    treeFilter: found.treeFilter ?? "default",
  };
};

/** `stored` with `layout` as Session `sessionId`'s, first as the one shown last, and the oldest beyond the cap dropped. */
export const withLayout = (
  stored: StoredLayouts,
  sessionId: string,
  layout: SessionLayout,
): StoredLayouts => [
  { sessionId, layout },
  ...stored.filter((entry) => entry.sessionId !== sessionId).slice(0, MAX_LAYOUTS - 1),
];

/** `stored` with Session `sessionId` first, as the one shown last, its layout as it was (the default if none was kept). */
export const withShown = (stored: StoredLayouts, sessionId: string): StoredLayouts =>
  stored[0]?.sessionId === sessionId
    ? stored
    : withLayout(stored, sessionId, layoutOf(stored, sessionId));

/** `ids` with `id` in or out of it; one put in goes last, and the oldest beyond the cap go. */
export const withOpen = <A extends string | number>(
  ids: readonly A[],
  id: A,
  open: boolean,
): readonly A[] => {
  const others = ids.filter((known) => known !== id);

  return open ? [...others, id].slice(-MAX_OPEN) : others;
};

/**
 * A disclosure of a thread on the Session's page, as its open state is kept: in the root's thread or a subagent's
 * (`conversationId`), a tool card by its call, thinking by its message and its place there, a Skill by its message and
 * name, a notice by its message.
 */
export type TranscriptDisclosure = { readonly conversationId: number | undefined } & (
  | { readonly kind: "tool"; readonly callId: string }
  | { readonly kind: "thinking"; readonly messageId: string; readonly index: number }
  | { readonly kind: "skill"; readonly messageId: string; readonly name: string }
  | { readonly kind: "notice"; readonly messageId: string }
);

/** What a disclosure is within its thread. */
const disclosureInThread = (disclosure: TranscriptDisclosure): string => {
  switch (disclosure.kind) {
    case "tool":
      return `tool:${disclosure.callId}`;
    case "thinking":
      return `thinking:${disclosure.messageId}:${disclosure.index}`;
    case "skill":
      return `skill:${disclosure.messageId}:${disclosure.name}`;
    case "notice":
      return `notice:${disclosure.messageId}`;
  }
};

/** The key a disclosure's open state is kept under: its thread's conversation (`root` for the root's), then itself. */
export const disclosureKey = (disclosure: TranscriptDisclosure): string =>
  `${disclosure.conversationId ?? "root"}/${disclosureInThread(disclosure)}`;

/** What tells a Todo List from the next: its Todo Items, each as its ID and title. */
export const todoItemsOf = (
  items: ReadonlyArray<{ readonly id: number; readonly title: string }>,
): readonly string[] => items.map((item) => `${item.id}:${item.title}`).slice(0, MAX_OPEN);

/**
 * Whether `items` (`todoItemsOf`) are the Todo List `kept` was: one Todo Item at least is in both, so a list the agent
 * adds to, renames an item of or drops one from is the same list, and one it starts afresh is another. No items at all
 * is the same as no items.
 */
export const sameTodoList = (kept: readonly string[], items: readonly string[]): boolean =>
  kept.length === 0 ? items.length === 0 : items.some((item) => kept.includes(item));

/**
 * Whether the Activity card is expanded: as the owner left it for the Todo List shown while it was as settled as it is
 * now, else expanded on a wide screen while there is something to follow (a Todo Item not done, or a subagent working),
 * and collapsed otherwise.
 */
export const activityExpanded = ({
  choice,
  items,
  wide,
  settled,
}: {
  choice: ActivityChoice | undefined;
  /** The Todo List shown (`todoItemsOf`). */
  items: readonly string[];
  wide: boolean;
  /** Every Todo Item is done and no subagent is working. */
  settled: boolean;
}): boolean =>
  choice !== undefined && choice.settled === settled && sameTodoList(choice.items, items)
    ? choice.expanded
    : wide && !settled;
