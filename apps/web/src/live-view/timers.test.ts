// @effect-diagnostics preferEffectArray:off -- a fake clock's timers in a native array.

import { describe, expect, it } from "vitest";
import { TimerGroup, Throttle, type Timers } from "./timers.ts";

/** Timers that run only when the test moves the clock. */
const fakeTimers = () => {
  let now = 0;
  let timers: Array<{ at: number; run: () => void; every?: number }> = [];

  const timer: Timers = {
    now: () => now,
    after: (ms, run) => {
      const entry = { at: now + ms, run };

      timers.push(entry);

      return () => {
        timers = timers.filter((each) => each !== entry);
      };
    },
    every: (ms, run) => {
      const entry = { at: now + ms, run, every: ms };

      timers.push(entry);

      return () => {
        timers = timers.filter((each) => each !== entry);
      };
    },
  };

  const advance = (ms: number) => {
    const until = now + ms;

    for (;;) {
      const next = timers.filter((each) => each.at <= until).sort((a, b) => a.at - b.at)[0];

      if (next === undefined) break;

      now = next.at;

      if (next.every === undefined) timers = timers.filter((each) => each !== next);
      else next.at += next.every;

      next.run();
    }

    now = until;
  };

  return { timer, advance, pending: () => timers.length };
};

describe("a screen's timers", () => {
  it("cancel whatever is pending when the screen goes, and start nothing after", () => {
    const { timer, advance, pending } = fakeTimers();
    const group = new TimerGroup(timer);
    const ran: string[] = [];

    group.after(100, () => ran.push("press"));
    group.every(50, () => ran.push("map"));
    advance(60);
    group.dispose();
    group.after(10, () => ran.push("late"));
    advance(200);

    expect(ran).toEqual(["map"]);
    expect(pending()).toBe(0);
  });

  it("run a throttled read at most once per interval, as soon as it may", () => {
    const { timer, advance } = fakeTimers();
    const reads: number[] = [];
    const throttle = new Throttle(new TimerGroup(timer), 250, () => reads.push(timer.now()));

    throttle.runNow();
    throttle.schedule();
    throttle.schedule();
    advance(100);

    expect(reads).toEqual([0]);

    advance(150);

    expect(reads).toEqual([0, 250]);

    // Long after the last run: at once.
    advance(1000);
    throttle.schedule();
    advance(0);

    expect(reads).toEqual([0, 250, 1250]);
  });
});
