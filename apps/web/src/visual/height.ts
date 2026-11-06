// docs/architecture/visuals.md → The frame: Height. A Visual's frame fits its content from 160 px up to 20,000 px and then
// scrolls inside; a page whose height grows after each of 3 consecutive host resizes (one that sizes itself by its frame, and
// would climb to the cap) is frozen where it is: growth that answers a resize within a frame or two, by any amount (a script
// that sizes the page by its frame may climb by a fixed step or in proportion), and not a page that loads in stages (a font,
// then a chart, then an image), each a few hundred milliseconds apart. Measuring the content at `max-content` (the shim)
// already stops a CSS percentage from looping, so what is left is a script's; and the height is remembered on this device, so a reload, a remount or a lazy unmount keeps the
// transcript where it was. Pure: the reports and the clock go in.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain decisions over small native lists.
import { VISUAL_GROWTH_RESIZES, VISUAL_MAX_HEIGHT, VISUAL_MIN_HEIGHT } from "@cloudpid/protocol";

/** The height a frame gives a page that reports `reported` px: between 160 and 20,000 px. */
export const fitHeight = (reported: number): number =>
  Math.min(VISUAL_MAX_HEIGHT, Math.max(VISUAL_MIN_HEIGHT, Math.ceil(reported)));

/**
 * How soon after a host resize a page's growth counts as an answer to it, in ms: a frame or two, as a script that sizes the
 * page by its frame answers; a page's own stages come later.
 */
export const GROWTH_WINDOW_MS = 200;

/**
 * What the guard knows of a frame: the height the host set last and when, how many resizes in a row the page grew after,
 * and whether it froze.
 */
export interface GrowthGuard {
  readonly applied: number | undefined;
  readonly appliedAt: number;
  readonly streak: number;
  readonly frozen: boolean;
}

export const GUARD_START: GrowthGuard = {
  applied: undefined,
  appliedAt: 0,
  streak: 0,
  frozen: false,
};

/** What a report comes to: the guard's next state, and the height to set (none before the frame has one). */
export interface GuardStep {
  readonly guard: GrowthGuard;
  readonly height: number | undefined;
}

/**
 * The guard after the page reports `reported` px at `now`: the height to set (the fit of the report; the same as before
 * once frozen), and the guard's next state. A report that grows past the height the host set within {@link GROWTH_WINDOW_MS}
 * of setting it, by any amount, extends the streak; anything else ends it. The {@link VISUAL_GROWTH_RESIZES}th in a row freezes the frame at the height it has, which is never set again:
 * the page scrolls inside.
 */
export const guardReport = (guard: GrowthGuard, reported: number, now: number): GuardStep => {
  if (guard.frozen) return { guard, height: guard.applied };

  const height = fitHeight(reported);

  if (guard.applied === undefined) {
    return { guard: { ...guard, applied: height, appliedAt: now }, height };
  }

  if (height === guard.applied) return { guard, height };

  const answered = height > guard.applied && now - guard.appliedAt <= GROWTH_WINDOW_MS;
  const streak = answered ? guard.streak + 1 : 0;

  if (streak >= VISUAL_GROWTH_RESIZES) {
    return { guard: { ...guard, streak, frozen: true }, height: guard.applied };
  }

  return { guard: { applied: height, appliedAt: now, streak, frozen: false }, height };
};

/** The most heights a device remembers: the Visuals shown last. */
export const MAX_REMEMBERED_HEIGHTS = 500;

/** Remembered heights, the Visual shown last first. */
export type RememberedHeights = ReadonlyArray<readonly [string, number]>;

/** The height remembered for `callId`, if any. */
export const rememberedHeight = (heights: RememberedHeights, callId: string): number | undefined =>
  heights.find(([id]) => id === callId)?.[1];

/** `heights` with `callId`'s set to `height`, first, and the oldest past {@link MAX_REMEMBERED_HEIGHTS} let go. */
export const withHeight = (
  heights: RememberedHeights,
  callId: string,
  height: number,
): RememberedHeights => {
  if (heights[0]?.[0] === callId && heights[0][1] === height) return heights;

  return [
    [callId, height] as const,
    ...heights.filter(([id]) => id !== callId).slice(0, MAX_REMEMBERED_HEIGHTS - 1),
  ];
};
