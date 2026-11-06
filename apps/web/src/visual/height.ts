// docs/architecture/visuals.md → The frame: Height. A Visual's frame fits its content from 160 px up to 20,000 px and then
// scrolls inside; a page whose height grows after each of 3 consecutive host resizes (one that sizes itself by its frame, and
// would climb to the cap) is frozen where it is: growth that answers a resize at once and by the same amount each time, which
// is how such a page climbs, and not how a page that loads in stages (an image, then a chart) grows; and the height is remembered on this device, so a reload, a remount or a
// lazy unmount keeps the transcript where it was. Pure: the reports and the clock go in.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain decisions over small native lists.
import { VISUAL_GROWTH_RESIZES, VISUAL_MAX_HEIGHT, VISUAL_MIN_HEIGHT } from "@cloudpid/protocol";

/** The height a frame gives a page that reports `reported` px: between 160 and 20,000 px. */
export const fitHeight = (reported: number): number =>
  Math.min(VISUAL_MAX_HEIGHT, Math.max(VISUAL_MIN_HEIGHT, Math.ceil(reported)));

/** How soon after a host resize a page's growth counts as an answer to it, in ms. */
export const GROWTH_WINDOW_MS = 1000;

/** How far apart two growths may be and still be the same step, in px (rounding). */
export const GROWTH_STEP_SLACK = 2;

/**
 * What the guard knows of a frame: the height the host set last and when, how many resizes in a row the page grew after by
 * the same step (`step`, px), and whether it froze.
 */
export interface GrowthGuard {
  readonly applied: number | undefined;
  readonly appliedAt: number;
  readonly streak: number;
  readonly step: number;
  readonly frozen: boolean;
}

export const GUARD_START: GrowthGuard = {
  applied: undefined,
  appliedAt: 0,
  streak: 0,
  step: 0,
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
 * of setting it, by the step the last one grew by, extends the streak; growth by another step starts one; anything else
 * ends it. The {@link VISUAL_GROWTH_RESIZES}th in a row freezes the frame at the height it has, which is never set again:
 * the page scrolls inside.
 */
export const guardReport = (guard: GrowthGuard, reported: number, now: number): GuardStep => {
  if (guard.frozen) return { guard, height: guard.applied };

  const height = fitHeight(reported);

  if (guard.applied === undefined) {
    return { guard: { ...guard, applied: height, appliedAt: now }, height };
  }

  if (height === guard.applied) return { guard, height };

  const step = height - guard.applied;
  const answered = step > 0 && now - guard.appliedAt <= GROWTH_WINDOW_MS;
  const same = guard.streak > 0 && Math.abs(step - guard.step) <= GROWTH_STEP_SLACK;
  const streak = !answered ? 0 : same ? guard.streak + 1 : 1;

  if (streak >= VISUAL_GROWTH_RESIZES) {
    return { guard: { ...guard, streak, step, frozen: true }, height: guard.applied };
  }

  return {
    guard: { applied: height, appliedAt: now, streak, step: answered ? step : 0, frozen: false },
    height,
  };
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
