// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a handful of Pane keys over native arrays, and plain helpers.

// The Pane area of a Session's page: which Panes are open, in tab order, and which one is shown. The state is the URL's
// query (`router.ts` says how it is written); this module is the rules over it, with no atoms and no React.
//
// A **Pane type** is a registration in `PANE_TYPES`: its `id` (what a key starts with in the URL), whether it `multiple`
// may be open more than once, and its tab `label`. A Pane is open under a **key**: the type's `id` alone for a type
// that may be open once (`tasks`), else `<id>:<argument>` (`live-view:<requestId>`, from `@cloudpid/protocol`'s
// `liveViewPaneKey`, which a push's link opens too; `terminal:<tab>`), the argument
// telling the Panes of one type apart. The component a type shows is in `pane-area.tsx`, so these rules stay testable
// without React; a type with no component there fails to typecheck.

import * as Match from "effect/Match";
import { paneParamsOf, withPaneParams, type PaneParams } from "./router.ts";

/** What a tab says: what the Pane shows, and the agent it is tied to when it is tied to a subagent. */
export interface PaneLabel {
  readonly name: string;
  readonly agent?: string;
}

/**
 * What a tab's label may look up beyond its argument, in the Session's state as the Pane area reads it: the agent whose
 * Browser Handoff `requestId` is, as the owner reads it, when it is not the root agent's.
 */
export type AgentOfHandoff = (requestId: string) => string | undefined;

/** One kind of Pane. */
export interface PaneType {
  /** What a key starts with in the URL: `tasks`, later `live-view` and `terminal`. */
  readonly id: string;
  /** Whether it may be open more than once, each under its own argument (`id:argument`). */
  readonly multiple: boolean;
  /** The tab's label, for a Pane opened with `argument` (undefined for a type that may be open once). */
  readonly label: (argument: string | undefined, agentOfHandoff: AgentOfHandoff) => PaneLabel;
}

/** A Live View's tab: named for the agent whose handoff it is, unless that is the root agent. */
const liveViewLabel = (argument: string | undefined, agentOfHandoff: AgentOfHandoff): PaneLabel => {
  const agent = argument === undefined ? undefined : agentOfHandoff(argument);

  return agent === undefined ? { name: "Live View" } : { name: "Live View", agent };
};

/**
 * The Pane types: the Tasks Pane and the Session tree Pane, one each per Session, and a Live View per Browser Handoff
 * waiting (`live-view:<requestId>`). The Terminal (#139) joins them here.
 */
export const PANE_TYPES = [
  { id: "tasks", multiple: false, label: () => ({ name: "Tasks" }) },
  { id: "tree", multiple: false, label: () => ({ name: "Tree" }) },
  { id: "live-view", multiple: true, label: liveViewLabel },
] as const satisfies readonly PaneType[];

/** The ID of a type in `PANE_TYPES`. */
export type PaneTypeId = (typeof PANE_TYPES)[number]["id"];

/** The key of the Tasks Pane. */
export const TASKS_PANE = "tasks";

/** The key of the Session tree Pane. */
export const TREE_PANE = "tree";

/** What a Pane's component gets. */
export interface PaneProps {
  /** The argument it was opened with (undefined for a type that may be open once). */
  readonly argument: string | undefined;
  /** Close this Pane, as the Live View does when its handoff ends. */
  readonly close: () => void;
}

/** The Panes open and the one shown: `shown` is one of `open`, and undefined only when `open` is empty. */
export interface PaneArea {
  readonly open: readonly string[];
  readonly shown: string | undefined;
}

/** No Pane open: the Pane area is closed. */
export const NO_PANES: PaneArea = { open: [], shown: undefined };

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

  // A type that may be open more than once needs its argument; one that may not, has none.
  if (type.multiple ? argument === undefined || argument === "" : argument !== undefined) {
    return undefined;
  }

  return { type, argument };
};

/** The area with `open` as its tabs: the Pane shown is `shown` if it is open, else the first. */
const areaOf = (open: readonly string[], shown: string | undefined): PaneArea =>
  open.length === 0
    ? NO_PANES
    : { open, shown: shown !== undefined && open.includes(shown) ? shown : open[0] };

/**
 * The area a query holds. A key no type can open is dropped, so is a repeat of one already open, and a `shown` that is
 * not open falls back to the first: a stale or hand-edited link opens what it can.
 */
export const paneAreaOf = (search: string, types: readonly PaneType[] = PANE_TYPES): PaneArea => {
  const { keys, shown } = paneParamsOf(search);
  const open: string[] = [];

  for (const key of keys) {
    if (paneKeyOf(key, types) !== undefined && !open.includes(key)) open.push(key);
  }

  return areaOf(open, shown);
};

/** `search` with `area` in place of the Panes it held, and everything else in it kept. */
export const searchWithPaneArea = (search: string, area: PaneArea): string => {
  const params: PaneParams = { keys: area.open, shown: area.shown };

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
  /** What a Pane's button does: open it; show it when another is shown; close it when it is the one shown. */
  | { readonly type: "toggle"; readonly key: string };

const withOpened = (area: PaneArea, key: string, types: readonly PaneType[]): PaneArea => {
  if (paneKeyOf(key, types) === undefined) return area;

  return areaOf(area.open.includes(key) ? area.open : [...area.open, key], key);
};

const withClosed = (area: PaneArea, key: string): PaneArea => {
  const index = area.open.indexOf(key);

  if (index < 0) return area;

  const remaining = area.open.filter((known) => known !== key);

  // The one shown goes: the tab after it is shown, as in a browser, or the one before when it was the last.
  return areaOf(
    remaining,
    key === area.shown ? (remaining[index] ?? remaining[index - 1]) : area.shown,
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
    case "toggle":
      return action.key === area.shown
        ? withClosed(area, action.key)
        : withOpened(area, action.key, types);
  }
};

/**
 * The tab a keyboard key moves to from the one shown, as in a tab list: the arrows step (and wrap), Home and End go to
 * the ends. Undefined for any other key.
 */
export const tabForKey = (area: PaneArea, key: string): string | undefined => {
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
