// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a handful of Pane keys over native arrays, and plain helpers.

// The Pane area of a Session's page: which Panes are open, in tab order, and which one is shown. The state is the URL's
// query (`router.ts` says how it is written); this module is the rules over it, with no atoms and no React.
//
// A **Pane type** is a registration in `PANE_TYPES`: its `id` (what a key starts with in the URL), whether it `multiple`
// may be open more than once, and its tab `label`. A Pane is open under a **key**: the type's `id` alone for a type
// that may be open once (`subagents`), else `<id>:<argument>` (`live-view:<requestId>`, from `@cloudpid/protocol`'s
// `liveViewPaneKey`, which a push's link opens too; `subagent:<conversationId>`; `terminal:<tab>`), the argument
// telling the Panes of one type apart; a type may refuse an argument it cannot open (`accepts`). The component a type shows is in `pane-area.tsx`, so these rules stay testable
// without React; a type with no component there fails to typecheck.
//
// The Pane area has one button in the Session's header: it opens the **New pane** (`new`), a tab that offers the Pane
// types the owner can open, when no Pane is open, and otherwise hides the area and shows it again. A hidden area keeps
// its Panes open (and mounted, so a Live View stays connected); opening or showing a Pane shows it again.

import * as Match from "effect/Match";
import { paneParamsOf, withPaneParams, type PaneParams } from "./router.ts";

/** What a tab says: what the Pane shows, and the agent it is tied to when it is tied to a subagent. */
export interface PaneLabel {
  readonly name: string;
  readonly agent?: string;
}

/**
 * What a tab's label may look up beyond its argument, in the Session's state as the Pane area reads it, each agent as
 * the owner reads it (its ID and role).
 */
export interface PaneLookups {
  /** The agent whose Browser Handoff `requestId` is, when it is not the root agent's. */
  readonly agentOfHandoff: (requestId: string) => string | undefined;
  /** The subagent that runs conversation `conversationId`, when the task graph lists it. */
  readonly agentOfConversation: (conversationId: number) => string | undefined;
}

/** One kind of Pane. */
export interface PaneType {
  /** What a key starts with in the URL: `subagents`, `live-view`, later `terminal`. */
  readonly id: string;
  /** Whether it may be open more than once, each under its own argument (`id:argument`). */
  readonly multiple: boolean;
  /** Whether a type that may be open more than once can open `argument`; any argument when it does not say. */
  readonly accepts?: (argument: string) => boolean;
  /** The tab's label, for a Pane opened with `argument` (undefined for a type that may be open once). */
  readonly label: (argument: string | undefined, lookups: PaneLookups) => PaneLabel;
}

/** A Live View's tab: named for the agent whose handoff it is, unless that is the root agent. */
const liveViewLabel = (argument: string | undefined, lookups: PaneLookups): PaneLabel => {
  const agent = argument === undefined ? undefined : lookups.agentOfHandoff(argument);

  return agent === undefined ? { name: "Live View" } : { name: "Live View", agent };
};

/** A conversation's ID as a Subagent Pane's key writes it: a whole number in decimal, with no leading zero. */
const CONVERSATION_ID = /^(?:0|[1-9]\d*)$/;

/** The conversation a Subagent Pane opened with `argument` shows, or undefined when it names none. */
export const conversationOfSubagentPane = (argument: string | undefined): number | undefined =>
  argument !== undefined && CONVERSATION_ID.test(argument) ? Number(argument) : undefined;

/**
 * How a Subagent Pane names what it shows, in its tab and its header: its agent, or, while the task graph does not list
 * the agent (not yet, or no more), its conversation, so two such Panes still read apart.
 */
export const subagentPaneName = (conversationId: number, agent: string | undefined): string =>
  agent ?? `Conversation ${conversationId}`;

/** A Subagent Pane's tab: what the Pane shows is the agent, so the agent is its name. */
const subagentLabel = (argument: string | undefined, lookups: PaneLookups): PaneLabel => {
  const conversationId = conversationOfSubagentPane(argument);

  return conversationId === undefined
    ? { name: "Subagent" }
    : { name: subagentPaneName(conversationId, lookups.agentOfConversation(conversationId)) };
};

/**
 * The Pane types: the New pane, the Subagents Pane, the Session tree Pane, the Browser Pane and the Diff pane, one each
 * per Session, a Subagent Pane per subagent the owner opens (`subagent:<conversationId>`), and a Live View per Browser Handoff waiting
 * (`live-view:<requestId>`). The Terminal (#139) joins them here, and in the New pane's choices (`new-pane.tsx`) if the
 * owner opens it.
 */
export const PANE_TYPES = [
  { id: "new", multiple: false, label: () => ({ name: "New pane" }) },
  { id: "subagents", multiple: false, label: () => ({ name: "Subagents" }) },
  {
    id: "subagent",
    multiple: true,
    accepts: (argument) => conversationOfSubagentPane(argument) !== undefined,
    label: subagentLabel,
  },
  { id: "tree", multiple: false, label: () => ({ name: "Tree" }) },
  { id: "browser", multiple: false, label: () => ({ name: "Browser" }) },
  { id: "diff", multiple: false, label: () => ({ name: "Diff" }) },
  { id: "live-view", multiple: true, label: liveViewLabel },
] as const satisfies readonly PaneType[];

/** The ID of a type in `PANE_TYPES`. */
export type PaneTypeId = (typeof PANE_TYPES)[number]["id"];

/** The key of the New pane, which offers the Pane types to open and becomes the one picked. */
export const NEW_PANE = "new";

/** The key of the Subagents Pane. */
export const SUBAGENTS_PANE = "subagents";

/** The key of the Subagent Pane that shows conversation `conversationId`, one subagent's. */
export const subagentPaneKey = (conversationId: number): string => `subagent:${conversationId}`;

/**
 * Keys a Pane was once opened under, and the key it has now: the Tasks Pane (`tasks`) became the Subagents Pane when
 * the Todo List moved to the Session details, so an old link or stored layout opens it.
 */
const RENAMED_KEYS: ReadonlyMap<string, string> = new Map([["tasks", SUBAGENTS_PANE]]);

/** `key` under its new name when no type of `types` opens it and it was renamed, else as it is. */
const currentKey = (key: string, types: readonly PaneType[]): string =>
  paneKeyOf(key, types) === undefined ? (RENAMED_KEYS.get(key) ?? key) : key;

/** The key of the Session tree Pane. */
export const TREE_PANE = "tree";

/** The key of the Browser Pane: the Session's browser, in an Owner tab. Its tab is labelled "Browser". */
export const BROWSER_PANE = "browser";

/** The key of the Diff pane: a source's files in one scroll (Changes, for now). Its tab is labelled "Diff". */
export const DIFF_PANE = "diff";

/** What a Pane's component gets. */
export interface PaneProps {
  /** The argument it was opened with (undefined for a type that may be open once). */
  readonly argument: string | undefined;
  /** Close this Pane, as the Live View does when its handoff ends. */
  readonly close: () => void;
}

/**
 * The Panes open and the one shown: `shown` is one of `open`, and undefined only when `open` is empty. `hidden` is set
 * while the area is hidden with Panes still open, never when none is.
 */
export interface PaneArea {
  readonly open: readonly string[];
  readonly shown: string | undefined;
  readonly hidden: boolean;
}

/** No Pane open: the Pane area is closed. */
export const NO_PANES: PaneArea = { open: [], shown: undefined, hidden: false };

/** Whether two areas have the same Panes open, in the same order, the same one shown, and are both hidden or not. */
export const samePaneArea = (one: PaneArea, other: PaneArea): boolean =>
  one.shown === other.shown &&
  one.hidden === other.hidden &&
  one.open.length === other.open.length &&
  one.open.every((key, index) => other.open[index] === key);

/** A Pane key, taken apart. */
export interface PaneKey {
  readonly type: PaneType;
  readonly argument: string | undefined;
}

/** The type and argument of `key`, or undefined when it is no Pane a type of `types` can open. */
export const paneKeyOf = (
  key: string,
  types: readonly PaneType[] = PANE_TYPES,
): PaneKey | undefined => {
  const colon = key.indexOf(":");
  const id = colon < 0 ? key : key.slice(0, colon);
  const argument = colon < 0 ? undefined : key.slice(colon + 1);
  const type = types.find((known) => known.id === id);

  if (type === undefined) return undefined;

  // A type that may be open more than once needs an argument it accepts; one that may not, has none.
  if (
    type.multiple
      ? argument === undefined || argument === "" || type.accepts?.(argument) === false
      : argument !== undefined
  ) {
    return undefined;
  }

  return { type, argument };
};

/** The area with `open` as its tabs: the Pane shown is `shown` if it is open, else the first. */
const areaOf = (open: readonly string[], shown: string | undefined, hidden = false): PaneArea =>
  open.length === 0
    ? NO_PANES
    : { open, shown: shown !== undefined && open.includes(shown) ? shown : open[0], hidden };

/**
 * The area a query holds. A renamed key reads as its new name (`RENAMED_KEYS`), a key no type can open is dropped, so is
 * a repeat of one already open, and a `shown` that is not open falls back to the first: a stale or hand-edited link
 * opens what it can.
 */
export const paneAreaOf = (search: string, types: readonly PaneType[] = PANE_TYPES): PaneArea => {
  const { keys, shown, hidden } = paneParamsOf(search);
  const open: string[] = [];

  for (const key of keys.map((written) => currentKey(written, types))) {
    if (paneKeyOf(key, types) !== undefined && !open.includes(key)) open.push(key);
  }

  return areaOf(open, shown === undefined ? undefined : currentKey(shown, types), hidden);
};

/** `search` with `area` in place of the Panes it held, and everything else in it kept. */
export const searchWithPaneArea = (search: string, area: PaneArea): string => {
  const params: PaneParams = { keys: area.open, shown: area.shown, hidden: area.hidden };

  return withPaneParams(search, params);
};

/** What the owner can do to the Pane area. */
export type PaneAction =
  /** Open a Pane, or show it if it is open. */
  | { readonly type: "open"; readonly key: string }
  /** Close a Pane; closing the last one closes the area. */
  | { readonly type: "close"; readonly key: string }
  /** Show an open Pane. */
  | { readonly type: "show"; readonly key: string }
  /** Put Pane `by` in the tab of `key` and show it, as the New pane does with the type picked. */
  | { readonly type: "replace"; readonly key: string; readonly by: string }
  /** What the header's button does: open the New pane when no Pane is open, else hide the area or show it again. */
  | { readonly type: "toggleArea" }
  /** Hide the area, its Panes kept open. */
  | { readonly type: "hide" };

const withOpened = (area: PaneArea, key: string, types: readonly PaneType[]): PaneArea => {
  if (paneKeyOf(key, types) === undefined) return area;

  return areaOf(area.open.includes(key) ? area.open : [...area.open, key], key);
};

const withReplaced = (
  area: PaneArea,
  key: string,
  by: string,
  types: readonly PaneType[],
): PaneArea => {
  if (!area.open.includes(key) || paneKeyOf(by, types) === undefined) return area;

  // A Pane open already is shown where its tab is, and the tab replaced goes.
  if (area.open.includes(by))
    return areaOf(
      area.open.filter((known) => known !== key),
      by,
    );

  return areaOf(
    area.open.map((known) => (known === key ? by : known)),
    by,
  );
};

const withClosed = (area: PaneArea, key: string): PaneArea => {
  const index = area.open.indexOf(key);

  if (index < 0) return area;

  const remaining = area.open.filter((known) => known !== key);

  // The one shown goes: the tab after it is shown, as in a browser, or the one before when it was the last.
  return areaOf(
    remaining,
    key === area.shown ? (remaining[index] ?? remaining[index - 1]) : area.shown,
    area.hidden,
  );
};

/** The area after `action`; the same area when it changes nothing (an unknown key, a Pane not open). */
export const applyPaneAction = (
  area: PaneArea,
  action: PaneAction,
  types: readonly PaneType[] = PANE_TYPES,
): PaneArea => {
  switch (action.type) {
    case "open":
      return withOpened(area, action.key, types);
    case "close":
      return withClosed(area, action.key);
    case "show":
      return area.open.includes(action.key) ? areaOf(area.open, action.key) : area;
    case "replace":
      return withReplaced(area, action.key, action.by, types);
    case "toggleArea":
      if (area.open.length === 0) return withOpened(area, NEW_PANE, types);

      return areaOf(area.open, area.shown, !area.hidden);
    case "hide":
      return area.open.length === 0 || area.hidden ? area : areaOf(area.open, area.shown, true);
  }
};

/**
 * The tab a keyboard key moves to from the one shown, as in a tab list: the arrows step (and wrap), Home and End go to
 * the ends. Undefined for any other key.
 */
export const tabForKey = (
  area: Pick<PaneArea, "open" | "shown">,
  key: string,
): string | undefined => {
  const { open } = area;
  const at = area.shown === undefined ? 0 : open.indexOf(area.shown);

  return Match.value(key).pipe(
    Match.when("ArrowRight", () => open[(at + 1) % open.length]),
    Match.when("ArrowLeft", () => open[(at - 1 + open.length) % open.length]),
    Match.when("Home", () => open[0]),
    Match.when("End", () => open.at(-1)),
    Match.orElse(() => undefined),
  );
};
