// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a handful of windows over native arrays, and plain functions rather than combinators.

// The window strip of a Live View (#154): the pop-ups and new tabs the handed-over tab opened, directly or through one
// another, as a small strip inside the Pane rather than Pane tabs of their own. One page is shown at a time: the
// handed-over tab, or a window. The strip switches to a window when one opens and back to its opener when it closes.
// Links are not kept here: they expire, and the connection mints fresh ones when it needs one.

import type { LiveViewLinks } from "@cloudpid/protocol";

/** A window the handed-over tab opened. */
export interface StripWindow {
  readonly targetId: string;
  /** The page that opened it: the handed-over tab or another window. */
  readonly openerId: string;
  readonly title: string;
}

export interface WindowStrip {
  /** The handed-over tab's target. */
  readonly tab: string;
  /** Its windows still open, as the browser host listed them. */
  readonly windows: readonly StripWindow[];
  /** The target shown: the tab or one of the windows. */
  readonly shown: string;
}

const isOpen = (strip: Pick<WindowStrip, "tab" | "windows">, targetId: string): boolean =>
  targetId === strip.tab || strip.windows.some((each) => each.targetId === targetId);

/**
 * What to show once `gone` is not open any more: its opener, or the opener's opener, and so on (as `known` remembers
 * them), whichever is still open in `next`; the tab at last.
 */
const fallback = (
  known: readonly StripWindow[],
  next: Pick<WindowStrip, "tab" | "windows">,
  gone: string,
): string => {
  const openers = new Map(known.map((each) => [each.targetId, each.openerId]));
  const seen = new Set<string>();

  for (let at = openers.get(gone); at !== undefined && !seen.has(at); at = openers.get(at)) {
    if (isOpen(next, at)) return at;

    seen.add(at);
  }

  return next.tab;
};

/**
 * The strip after a reading of the links (`live_view`'s answer): the windows it lists, and the one shown. A window
 * that was not there before is shown (the newest of them, if several opened); else the shown page stays while it is
 * open, and otherwise its nearest opener still open is. The first reading shows the tab.
 */
export const stripOf = (links: LiveViewLinks, previous: WindowStrip | undefined): WindowStrip => {
  const windows = links.windows.map(({ targetId, openerId, title }) => ({
    targetId,
    openerId,
    title,
  }));

  const next = { tab: links.tab.targetId, windows };

  if (previous === undefined) return { ...next, shown: next.tab };

  const opened = windows.filter((each) => !isOpen(previous, each.targetId));
  const newest = opened.at(-1);

  if (newest !== undefined) return { ...next, shown: newest.targetId };

  if (isOpen(next, previous.shown)) return { ...next, shown: previous.shown };

  return { ...next, shown: fallback(previous.windows, next, previous.shown) };
};

/** The strip after window `targetId` closed (its connection closed): its opener is shown if it was. */
export const windowClosed = (strip: WindowStrip, targetId: string): WindowStrip => {
  const windows = strip.windows.filter((each) => each.targetId !== targetId);
  const next = { tab: strip.tab, windows };

  if (strip.shown !== targetId) return { ...next, shown: strip.shown };

  return { ...next, shown: fallback(strip.windows, next, targetId) };
};

/** The strip showing `targetId`, the tab or a window the owner picked; the same strip when it knows no such page. */
export const selectWindow = (strip: WindowStrip, targetId: string): WindowStrip =>
  isOpen(strip, targetId) && strip.shown !== targetId ? { ...strip, shown: targetId } : strip;
