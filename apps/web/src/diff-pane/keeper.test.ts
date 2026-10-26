import { describe, expect, it } from "vitest";
import { keeperOf } from "./keeper.ts";

/** A clock whose timers run when the test says so. */
const manualTimers = () => {
  let next = 0;
  const due = new Map<number, () => void>();

  return {
    set: (run: () => void) => {
      next += 1;
      due.set(next, run);

      return next;
    },
    clear: (id: number) => {
      due.delete(id);
    },
    fire: () => {
      const runs = [...due.values()];

      due.clear();

      for (const run of runs) run();
    },
    pending: () => due.size,
  };
};

const keeperOver = () => {
  const timers = manualTimers();
  const made: number[] = [];
  const disposed: number[] = [];

  const keeper = keeperOf({
    create: () => {
      made.push(made.length + 1);

      return made.length;
    },
    dispose: (value: number) => {
      disposed.push(value);
    },
    graceMs: 30_000,
    setTimer: (run, ms) => {
      expect(ms).toBe(30_000);

      return timers.set(run);
    },
    clearTimer: timers.clear,
  });

  return { keeper, timers, made, disposed };
};

describe("keeperOf", () => {
  it("makes the thing when first acquired and shares it while held", () => {
    const { keeper, made } = keeperOver();

    expect(keeper.acquire()).toBe(1);
    expect(keeper.acquire()).toBe(1);
    expect(made).toEqual([1]);
  });

  it("disposes of it once its grace has passed after the last release", () => {
    const { keeper, timers, disposed } = keeperOver();

    keeper.acquire();
    keeper.acquire();
    keeper.release();
    expect(timers.pending()).toBe(0);

    keeper.release();
    expect(disposed).toEqual([]);
    timers.fire();
    expect(disposed).toEqual([1]);
  });

  it("keeps it when acquired again within the grace, and makes a new one after it", () => {
    const { keeper, timers, made, disposed } = keeperOver();

    keeper.acquire();
    keeper.release();
    expect(keeper.acquire()).toBe(1);
    expect(timers.pending()).toBe(0);

    keeper.release();
    timers.fire();
    expect(disposed).toEqual([1]);
    expect(keeper.acquire()).toBe(2);
    expect(made).toEqual([1, 2]);
  });
});
