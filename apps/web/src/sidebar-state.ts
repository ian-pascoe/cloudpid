// @effect-diagnostics missingPipeableSignature:off -- plain functions of a width and a key.

// The Session list's column on a wide screen: its width and whether it is collapsed to a rail, view preferences kept on
// this device. A phone shows the list full-screen in turns with the chat, so neither applies there.

import * as Match from "effect/Match";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import { appRuntime } from "./runtime.ts";

/** The narrowest the column is dragged to, in px: room for the title and the header's buttons, as icons. */
export const MIN_SIDEBAR_WIDTH = 224;

/** The widest it is dragged to, in px. */
export const MAX_SIDEBAR_WIDTH = 480;

/** Its width until it is dragged: 19 rem, the narrowest at which the New session button keeps its words. */
export const DEFAULT_SIDEBAR_WIDTH = 304;

/** A drag that takes the column narrower than this collapses it to the rail, in px. */
export const COLLAPSE_BELOW = 160;

/** `width` in px, whole and between the narrowest and the widest; the default for a value that is not a number. */
export const clampSidebarWidth = (width: number): number =>
  Number.isFinite(width)
    ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)))
    : DEFAULT_SIDEBAR_WIDTH;

/** The width the column has on this device (in the runtime's key-value store), as it was left. */
const storedSidebarWidthAtom = Atom.kvs({
  runtime: appRuntime,
  key: "cloudpid:sidebar-width",
  schema: Schema.Finite,
  defaultValue: (): number => DEFAULT_SIDEBAR_WIDTH,
}).pipe(Atom.keepAlive);

/** The width of the Session list's column in px on a wide screen; a write is kept on this device. */
export const sidebarWidthAtom = Atom.writable(
  (get): number => clampSidebarWidth(get(storedSidebarWidthAtom)),
  (ctx, width: number) => {
    // Read first, so the store has loaded when this writes, as it has once the page has shown the width.
    ctx.get(storedSidebarWidthAtom);

    ctx.set(storedSidebarWidthAtom, clampSidebarWidth(width));
  },
);

/** Whether the column is collapsed to a rail of icons on this device (in the runtime's key-value store). */
export const sidebarCollapsedAtom = Atom.kvs({
  runtime: appRuntime,
  key: "cloudpid:sidebar-collapsed",
  schema: Schema.Boolean,
  defaultValue: (): boolean => false,
}).pipe(Atom.keepAlive);

/** How far an arrow key moves the resize handle, in px; with Shift, the larger step. */
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

/**
 * The width a keyboard key sets from `width` when the resize handle has the focus, or undefined for any other key. The
 * column grows to the right, so the right arrow widens it; Home and End go to the narrowest and the widest.
 */
export const sidebarWidthForKey = (
  width: number,
  key: string,
  large: boolean,
): number | undefined => {
  const step = large ? KEY_STEP_LARGE : KEY_STEP;

  return Match.value(key).pipe(
    Match.when("ArrowRight", () => width + step),
    Match.when("ArrowLeft", () => width - step),
    Match.when("Home", () => MIN_SIDEBAR_WIDTH),
    Match.when("End", () => MAX_SIDEBAR_WIDTH),
    Match.orElse(() => undefined),
  );
};
