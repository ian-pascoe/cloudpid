// @effect-diagnostics newPromise:off globalTimers:off -- waits a task, as the blur's check does.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { refreshOnReturn, type PageEvents } from "./page-return.ts";

/** A page whose events the test fires. */
const fakePage = () => {
  const listeners = new Map<string, () => void>();
  let visible = true;
  let focused = true;

  const page: PageEvents = {
    listen: (type, listener) => {
      listeners.set(type, listener);

      return () => {
        listeners.delete(type);
      };
    },
    visible: () => visible,
    hasFocus: () => focused,
  };

  return {
    page,
    fire: (type: string) => {
      listeners.get(type)?.();
    },
    setVisible: (value: boolean) => {
      visible = value;
    },
    setFocused: (value: boolean) => {
      focused = value;
    },
    listening: () => listeners.size,
  };
};

/** Let the blur's check, a task later, run. */
const nextTask = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 0)));

const counting = () => {
  let count = 0;

  return {
    refresh: Effect.sync(() => {
      count += 1;
    }),
    count: () => count,
  };
};

describe("refreshOnReturn", () => {
  it.effect("refreshes when the page is shown again, at most once in 2 s", () =>
    Effect.gen(function* () {
      const fake = fakePage();
      const refreshes = counting();

      yield* refreshOnReturn(fake.page, refreshes.refresh);

      fake.fire("visibilitychange");
      yield* Effect.yieldNow;
      expect(refreshes.count()).toBe(1);

      yield* TestClock.adjust("1 second");
      fake.fire("visibilitychange");
      yield* Effect.yieldNow;
      expect(refreshes.count()).toBe(1);

      yield* TestClock.adjust("2 seconds");
      fake.setVisible(false);
      fake.fire("visibilitychange");
      fake.setVisible(true);
      fake.fire("visibilitychange");
      yield* Effect.yieldNow;
      expect(refreshes.count()).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "refreshes when the window gets the focus back from another window, not from a frame",
    () =>
      Effect.gen(function* () {
        const fake = fakePage();
        const refreshes = counting();

        yield* refreshOnReturn(fake.page, refreshes.refresh);

        // Into the Live View's frame and back: the page had the focus all along.
        fake.fire("blur");
        yield* nextTask;
        fake.fire("focus");
        yield* Effect.yieldNow;
        expect(refreshes.count()).toBe(0);

        // To another window and back.
        fake.setFocused(false);
        fake.fire("blur");
        yield* nextTask;
        fake.setFocused(true);
        fake.fire("focus");
        yield* Effect.yieldNow;
        expect(refreshes.count()).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect("stops listening when its scope closes", () =>
    Effect.gen(function* () {
      const fake = fakePage();

      yield* refreshOnReturn(fake.page, Effect.void).pipe(Effect.scoped);
      expect(fake.listening()).toBe(0);
    }),
  );
});
