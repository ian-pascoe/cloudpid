// The deadline a question's wait stops (`docs/architecture/mcp-server-requests.md` → Questions), on a test clock.
// @effect-diagnostics strictEffectProvide:off preferEffectArray:off
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import { pausableDeadline } from "./deadline.ts";

const test = (name: string, body: () => Effect.Effect<void>) =>
  it(name, () => Effect.runPromise(body().pipe(Effect.provide(TestClock.layer()))));

describe("a pausable deadline", () => {
  test("aborts its signal when its time passes, with its reason", () =>
    Effect.gen(function* () {
      const deadline = yield* pausableDeadline(1000, () => new Error("too late"));

      yield* TestClock.adjust(999);
      expect(deadline.signal.aborted).toBe(false);
      yield* TestClock.adjust(1);
      expect(deadline.signal.aborted).toBe(true);
      expect(deadline.signal.reason).toEqual(new Error("too late"));
    }));

  test("stands still while paused, and runs on with what was left", () =>
    Effect.gen(function* () {
      const deadline = yield* pausableDeadline(1000, () => new Error("late"));

      yield* TestClock.adjust(600);
      yield* deadline.pause;
      yield* TestClock.adjust(10 * 60 * 1000);
      expect(deadline.signal.aborted).toBe(false);
      yield* deadline.resume;
      yield* TestClock.adjust(399);
      expect(deadline.signal.aborted).toBe(false);
      yield* TestClock.adjust(1);
      expect(deadline.signal.aborted).toBe(true);
    }));

  test("runs again only when every pause has resumed", () =>
    Effect.gen(function* () {
      const deadline = yield* pausableDeadline(1000, () => new Error("late"));

      yield* deadline.pause;
      yield* deadline.pause;
      yield* deadline.resume;
      yield* TestClock.adjust(5000);
      expect(deadline.signal.aborted).toBe(false);
      yield* deadline.resume;
      yield* TestClock.adjust(1000);
      expect(deadline.signal.aborted).toBe(true);
    }));

  test("starts again from the whole on progress", () =>
    Effect.gen(function* () {
      const deadline = yield* pausableDeadline(1000, () => new Error("late"));

      yield* TestClock.adjust(900);
      yield* deadline.reset;
      yield* TestClock.adjust(900);
      expect(deadline.signal.aborted).toBe(false);
      yield* TestClock.adjust(100);
      expect(deadline.signal.aborted).toBe(true);
    }));

  test("starts no timer once cleared, whatever resumes or resets after it", () =>
    Effect.gen(function* () {
      const deadline = yield* pausableDeadline(1000, () => new Error("late"));

      yield* deadline.pause;
      yield* deadline.clear;
      yield* deadline.resume;
      yield* deadline.reset;
      yield* TestClock.adjust(10_000);
      expect(deadline.signal.aborted).toBe(false);
    }));
});
