// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- short native lists of IDs, and plain helpers.

// A Session page's layout: what the owner opened, collapsed and picked on it, kept per Session on this device so that
// going back to a Session shows it as it was left. This module is the rules over it, with no atoms and no React
// (`session-layout-state.ts` keeps it).
//
// It holds the Pane area (the Panes open, the one shown, whether the area is hidden), whether the Activity card is
// expanded, which subagents are open in the Subagents Pane and in the transcript's cards, and the Session tree Pane's
// filter. Only the Sessions shown last are kept (`MAX_LAYOUTS`): a Session not opened for that long starts afresh.

import * as Schema from "effect/Schema";
import { NO_PANES, paneAreaOf, searchWithPaneArea, type PaneArea } from "./panes.ts";
import type { TreeFilter } from "./session/tree.ts";

/**
 * The owner's choice for the Activity card: expanded or collapsed, made while the Todo List was `list`
 * (`todoListOf`). A new list (another first Task) drops the choice, so a new plan shows as the card's default does.
 */
export interface ActivityChoice {
  readonly expanded: boolean;
  readonly list: string;
}

/** One Session's layout. */
export interface SessionLayout {
  readonly panes: PaneArea;
  /** Undefined while the owner has not expanded or collapsed the card for the Todo List shown. */
  readonly activity: ActivityChoice | undefined;
  /** The conversations of the subagents open in the Subagents Pane. */
  readonly openAgents: readonly number[];
  /** The conversations of the subagent cards open in the transcript. */
  readonly openCards: readonly number[];
  readonly treeFilter: TreeFilter;
}

/** A Session's layout until the owner changes it: nothing open, every default. */
export const DEFAULT_LAYOUT: SessionLayout = {
  panes: NO_PANES,
  activity: undefined,
  openAgents: [],
  openCards: [],
  treeFilter: "default",
};

/** How many Sessions' layouts this device keeps: the ones shown last. */
export const MAX_LAYOUTS = 50;

/** How many open subagents a layout keeps for each list, the last opened. */
const MAX_OPEN = 50;

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
  activity: Schema.optional(Schema.Struct({ expanded: Schema.Boolean, list: Schema.String })),
  openAgents: Schema.Array(Schema.Finite).pipe(Schema.optional),
  openCards: Schema.Array(Schema.Finite).pipe(Schema.optional),
  treeFilter: Schema.optional(Schema.Literals(["default", "no-tools", "user-only", "all"])),
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

/** `ids` with `id` in or out of it; one put in goes last, and the oldest beyond the cap go. */
export const withOpen = (ids: readonly number[], id: number, open: boolean): readonly number[] => {
  const others = ids.filter((known) => known !== id);

  return open ? [...others, id].slice(-MAX_OPEN) : others;
};

/** What tells one Todo List from the next: its first Task's title (`""` for none). */
export const todoListOf = (tasks: ReadonlyArray<{ readonly title: string }>): string =>
  tasks[0]?.title ?? "";

/**
 * Whether the Activity card is expanded: as the owner left it for the Todo List shown, else expanded on a wide screen
 * while there is something to follow (a Task not done, or a subagent working), and collapsed otherwise.
 */
export const activityExpanded = ({
  choice,
  list,
  wide,
  settled,
}: {
  choice: ActivityChoice | undefined;
  list: string;
  wide: boolean;
  /** Every Task is done and no subagent is working. */
  settled: boolean;
}): boolean => (choice !== undefined && choice.list === list ? choice.expanded : wide && !settled);
