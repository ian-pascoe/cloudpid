// @effect-diagnostics missingPipeableSignature:off -- a plain function of a width and a key.

// The Pane area as atoms: the Panes open and the one shown are the URL's query, and the area's width is a view
// preference kept on this device.

import * as Match from "effect/Match";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import {
  applyPaneAction,
  paneAreaOf,
  searchWithPaneArea,
  type PaneAction,
  type PaneArea,
} from "./panes.ts";
import { searchAtom } from "./router.ts";
import { appRuntime } from "./runtime.ts";

/**
 * The Panes open and the one shown, read from the page's query. Writing a `PaneAction` opens, closes or switches a Pane
 * by replacing the history entry's query (Back leaves the Session, not the Pane: `router.ts` says why).
 */
export const panesAtom = Atom.writable(
  (get): PaneArea => paneAreaOf(get(searchAtom)),
  (ctx, action: PaneAction) => {
    const search = ctx.get(searchAtom);
    const area = paneAreaOf(search);

    const next = applyPaneAction(area, action);

    if (next !== area) ctx.set(searchAtom, searchWithPaneArea(search, next));
  },
);

/** The narrowest the Pane area is dragged to on a wide screen, in px. */
export const MIN_PANE_WIDTH = 288;

/** The widest it is dragged to, in px. */
export const MAX_PANE_WIDTH = 720;

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
 * column grows to the left, so the left arrow widens it; Home and End go to the narrowest and the widest.
 */
export const paneWidthForKey = (width: number, key: string, large: boolean): number | undefined => {
  const step = large ? KEY_STEP_LARGE : KEY_STEP;

  return Match.value(key).pipe(
    Match.when("ArrowLeft", () => width + step),
    Match.when("ArrowRight", () => width - step),
    Match.when("Home", () => MIN_PANE_WIDTH),
    Match.when("End", () => MAX_PANE_WIDTH),
    Match.orElse(() => undefined),
  );
};
