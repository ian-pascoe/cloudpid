// @effect-diagnostics missingPipeableSignature:off -- a plain function of a width and a key.

// The Pane area as atoms: the Panes open and the one shown are the URL's query, also kept in the page's layout on
// this device (`session-layout-state.ts`: the Session page's, or a Subagent page's own) so the page shows them again
// when it is opened without them; the area's width is a view preference kept on this device.

import * as Match from "effect/Match";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import {
  applyPaneAction,
  paneAreaOf,
  paneTypesOf,
  samePaneArea,
  searchWithPaneArea,
  type PaneAction,
  type PaneArea,
} from "./panes.ts";
import { agentIdAtom, paneParamsOf, searchAtom } from "./router.ts";
import { appRuntime } from "./runtime.ts";
import { sessionLayoutAtom, shownLayoutKeyAtom } from "./session-layout-state.ts";

/** Whether `search` names any Pane: then it says what is open, else the Session's layout does. */
const namesPanes = (search: string): boolean => paneParamsOf(search).keys.length > 0;

/** The Pane types the page shown opens: a Subagent page's lack the Session tree Pane. */
const shownPaneTypesAtom = Atom.map(agentIdAtom, (agentId) => paneTypesOf(agentId !== undefined));

/**
 * The Panes open and the one shown: the page's query when it names any (a link, a reload, a push tap), else the Panes
 * the page shown was left with (going to a page drops the query), from its layout: the Session page's, or the Subagent
 * page's own. Writing a `PaneAction` opens, closes or switches a Pane by replacing the history entry's query (Back
 * leaves the page, not the Pane: `router.ts` says why), and keeps the area in the page's layout.
 */
export const panesAtom = Atom.writable(
  (get): PaneArea => {
    const search = get(searchAtom);
    const key = get(shownLayoutKeyAtom);
    const types = get(shownPaneTypesAtom);

    if (key === undefined || namesPanes(search)) return paneAreaOf(search, types);

    return get(sessionLayoutAtom(key)).panes;
  },
  (ctx, action: PaneAction) => {
    const area = ctx.get(panesAtom);
    const next = applyPaneAction(area, action, ctx.get(shownPaneTypesAtom));

    if (next === area) return;

    ctx.set(searchAtom, searchWithPaneArea(ctx.get(searchAtom), next));

    const key = ctx.get(shownLayoutKeyAtom);

    if (key === undefined) return;

    ctx.set(sessionLayoutAtom(key), { panes: next });
  },
);

/**
 * Keeps the Panes a query names in the layout under `key` (`layoutKey`) while its page is shown, so the ones a link or a
 * push tap opened are there when the owner comes back from another page. Mounted by the Session's page and each
 * Subagent page.
 */
export const rememberPanesAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    get.subscribe(
      searchAtom,
      (search) => {
        if (get.once(shownLayoutKeyAtom) !== key || !namesPanes(search)) return;

        const area = paneAreaOf(search, get.once(shownPaneTypesAtom));
        const layout = sessionLayoutAtom(key);

        if (!samePaneArea(get.once(layout).panes, area)) get.set(layout, { panes: area });
      },
      { immediate: true },
    );
  }),
);

/** The narrowest the Pane area is dragged to on a wide screen, in px. */
export const MIN_PANE_WIDTH = 288;

/**
 * The widest it is kept at, in px. The chat beside it keeps `MIN_CHAT_WIDTH` whatever the width, so on most screens
 * that is the bound: the area may take everything else.
 */
export const MAX_PANE_WIDTH = 2400;

/** The narrowest the chat gets beside the Pane area, in px: 20 rem, a phone's width. */
export const MIN_CHAT_WIDTH = 320;

/**
 * The widest the Pane area can be shown in a page `room` px wide (the chat and the area together): all of it but the
 * chat's `MIN_CHAT_WIDTH`, and never under the narrowest.
 */
export const widestPaneIn = (room: number): number =>
  Math.min(MAX_PANE_WIDTH, Math.max(MIN_PANE_WIDTH, Math.floor(room - MIN_CHAT_WIDTH)));

/** Its width until it is dragged: 24 rem, as the Tasks panel was. */
export const DEFAULT_PANE_WIDTH = 384;

/** `width` in px, whole and between the narrowest and the widest; the default for a value that is not a number. */
export const clampPaneWidth = (width: number): number =>
  Number.isFinite(width)
    ? Math.min(MAX_PANE_WIDTH, Math.max(MIN_PANE_WIDTH, Math.round(width)))
    : DEFAULT_PANE_WIDTH;

/** The width the Pane area has on this device (in the runtime's key-value store), as it was left. */
const storedPaneWidthAtom = Atom.kvs({
  runtime: appRuntime,
  key: "cloudpid:pane-width",
  schema: Schema.Finite,
  defaultValue: (): number => DEFAULT_PANE_WIDTH,
}).pipe(Atom.keepAlive);

/** The width of the Pane area in px on a wide screen (a phone's is the screen); a write is kept on this device. */
export const paneWidthAtom = Atom.writable(
  (get): number => clampPaneWidth(get(storedPaneWidthAtom)),
  (ctx, width: number) => {
    // Read first, so the store has loaded when this writes, as it has once the page has shown the width.
    ctx.get(storedPaneWidthAtom);

    ctx.set(storedPaneWidthAtom, clampPaneWidth(width));
  },
);

/** How far an arrow key moves the resize handle, in px; with Shift, the larger step. */
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

/**
 * The width a keyboard key sets from `width` when the resize handle has the focus, or undefined for any other key. The
 * column grows to the left, so the left arrow widens it; Home and End go to the narrowest and `widest` (the widest the
 * page has room for).
 */
export const paneWidthForKey = (
  width: number,
  key: string,
  large: boolean,
  widest: number = MAX_PANE_WIDTH,
): number | undefined => {
  const step = large ? KEY_STEP_LARGE : KEY_STEP;

  return Match.value(key).pipe(
    Match.when("ArrowLeft", () => Math.min(widest, width + step)),
    Match.when("ArrowRight", () => width - step),
    Match.when("Home", () => MIN_PANE_WIDTH),
    Match.when("End", () => widest),
    Match.orElse(() => undefined),
  );
};
