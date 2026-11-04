// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- short native lists of IDs, and plain helpers.

// A Session page's layout (GLOSSARY.md → Session layout): what the owner opened, collapsed and picked on it, kept per
// Session on this device so that going back to a Session shows it as it was left. Each Subagent page has a layout of
// its own, apart from its Session's (`layoutKey`). This module is the rules over it, with no atoms and no React
// (`session-layout-state.ts` keeps it).
//
// It holds the Pane area (the Panes open, the one shown, whether the area is hidden), whether the Session details are
// open, which of the transcript's subagent cards are open, which of the transcript's disclosures (tool cards,
// thinking, Skills, notices) are open, which App Views the owner reopened or collapsed (docs/architecture/mcp-apps.md →
// App Views in the transcript), and the Session tree Pane's filter. A subagent open in a Pane of its own is one of the
// Panes, and so is an App View popped out (`app:<callId>`). Only the Sessions shown last are kept (`MAX_LAYOUTS`): a
// Session not opened for that long starts afresh.

import * as Schema from "effect/Schema";
import { NO_PANES, paneAreaOf, searchWithPaneArea, type PaneArea } from "./panes.ts";
import { TREE_FILTER_VALUES, type TreeFilter } from "./session/tree.ts";

/**
 * The key a page's layout is kept under: the Session's ID for its Session page, and the Session's and the agent's for a
 * Subagent page, so the two never share one. A Session ID holds no `/` (a UUIDv7), so no Session's key is a Subagent
 * page's.
 */
export const layoutKey = (sessionId: string, agentId?: string): string =>
  agentId === undefined ? sessionId : `${sessionId}/agents/${agentId}`;

/** One Session's layout. */
export interface SessionLayout {
  readonly panes: PaneArea;
  /** Whether the Session details are open: the owner opens and closes them from the header. */
  readonly detailsOpen: boolean;
  /** The conversations of the subagent cards open in the transcript. */
  readonly openCards: readonly number[];
  /** The transcript's disclosures open (`disclosureKey`). */
  readonly openDisclosures: readonly string[];
  /** The calls whose App Views the owner reopened: live until they collapse them, whatever the generation rule says. */
  readonly openApps: readonly string[];
  /** The calls whose App Views the owner collapsed: collapsed until they reopen them. */
  readonly collapsedApps: readonly string[];
  readonly treeFilter: TreeFilter;
}

/** A Session's layout until the owner changes it: nothing open, every default. */
export const DEFAULT_LAYOUT: SessionLayout = {
  panes: NO_PANES,
  detailsOpen: false,
  openCards: [],
  openDisclosures: [],
  openApps: [],
  collapsedApps: [],
  treeFilter: "default",
};

/** How many Sessions' layouts this device keeps: the ones shown last. */
export const MAX_LAYOUTS = 50;

/** How many open things a layout keeps in each list, the last opened. */
const MAX_OPEN = 100;

/**
 * A layout as it is stored. Every field may be missing, so a layout stored before a field was added reads with its
 * default; the Pane keys are checked against the Pane types when read (`layoutOf`), as a URL's are. A field it no longer
 * has (`openAgents`, the rows once open in the Subagents Pane) is dropped when read, and so when written again.
 */
const StoredLayout = Schema.Struct({
  panes: Schema.optional(
    Schema.Struct({
      open: Schema.Array(Schema.String),
      shown: Schema.optional(Schema.String),
      hidden: Schema.Boolean,
    }),
  ),
  detailsOpen: Schema.optional(Schema.Boolean),
  openCards: Schema.Array(Schema.Finite).pipe(Schema.optional),
  openDisclosures: Schema.Array(Schema.String).pipe(Schema.optional),
  openApps: Schema.Array(Schema.String).pipe(Schema.optional),
  collapsedApps: Schema.Array(Schema.String).pipe(Schema.optional),
  treeFilter: Schema.optional(Schema.Literals(TREE_FILTER_VALUES)),
});

/**
 * The layouts this device keeps, the page shown last first. `sessionId` is the page's layout key (`layoutKey`): it was
 * the Session's ID alone before Subagent pages had layouts, which is still a Session page's key.
 */
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
    detailsOpen: found.detailsOpen ?? false,
    openCards: found.openCards ?? [],
    openDisclosures: found.openDisclosures ?? [],
    openApps: found.openApps ?? [],
    collapsedApps: found.collapsedApps ?? [],
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

/** What the owner chose of an App View on this device: reopened it, or collapsed it; undefined when they chose nothing. */
export type AppChoice = "open" | "collapsed";

/** The owner's choice of call `callId`'s App View in `layout`. */
export const appChoiceOf = (
  layout: Pick<SessionLayout, "openApps" | "collapsedApps">,
  callId: string,
): AppChoice | undefined => {
  if (layout.collapsedApps.includes(callId)) return "collapsed";

  return layout.openApps.includes(callId) ? "open" : undefined;
};

/** The lists of `layout` with call `callId`'s App View reopened, collapsed, or (`undefined`) left to the generation rule. */
export const withAppChoice = (
  layout: Pick<SessionLayout, "openApps" | "collapsedApps">,
  callId: string,
  choice: AppChoice | undefined,
): Pick<SessionLayout, "openApps" | "collapsedApps"> => ({
  openApps: withOpen(layout.openApps, callId, choice === "open"),
  collapsedApps: withOpen(layout.collapsedApps, callId, choice === "collapsed"),
});

/**
 * A disclosure of a thread on the Session's page, as its open state is kept: in the root's thread or a subagent's
 * (`conversationId`), a tool card by its call, thinking by its message and its place there, a Skill by its message and
 * name, an MCP prompt's block by its message, a notice by its message.
 */
export type TranscriptDisclosure = { readonly conversationId: number | undefined } & (
  | { readonly kind: "tool"; readonly callId: string }
  | { readonly kind: "thinking"; readonly messageId: string; readonly index: number }
  | { readonly kind: "skill"; readonly messageId: string; readonly name: string }
  | { readonly kind: "mcp-prompt"; readonly messageId: string }
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
    case "mcp-prompt":
      return `mcp-prompt:${disclosure.messageId}`;
    case "notice":
      return `notice:${disclosure.messageId}`;
  }
};

/** The key a disclosure's open state is kept under: its thread's conversation (`root` for the root's), then itself. */
export const disclosureKey = (disclosure: TranscriptDisclosure): string =>
  `${disclosure.conversationId ?? "root"}/${disclosureInThread(disclosure)}`;
