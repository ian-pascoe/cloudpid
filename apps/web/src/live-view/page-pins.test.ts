// @effect-diagnostics preferEffectArray:off -- a fake page's answers in native arrays.
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { settle } from "../session/client.testing.ts";
import type { Located } from "./page-annotations.ts";
import {
  LOCATE_AFTER_MOVE,
  LOCATE_EVERY,
  type LocatedRects,
  type LocatePage,
  locatedRects,
} from "./page-pins.ts";

const URL = "https://app.test/page";

/** A page that answers each read with `answer(n)` (`n` from 1), and moves when told. */
const fakePage = (answer: (read: number) => Located) => {
  const listeners = new Set<() => void>();
  let reads = 0;

  const page: LocatePage = {
    evaluate: <A>() => {
      reads += 1;

      // SAFETY: the pins read `Located`, which the fake answers.
      return Promise.resolve(answer(reads) as A);
    },
    moved: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    page,
    reads: () => reads,
    move: () => {
      for (const listener of listeners) listener();
    },
  };
};

/** Run the pins' reads of `page` in the test's scope, keeping what they answer. */
const follow = (page: LocatePage, selectors: readonly string[]) =>
  Effect.gen(function* () {
    const seen: LocatedRects[] = [];

    yield* locatedRects(page, selectors, URL).pipe(
      Stream.runForEach((rects) =>
        Effect.sync(() => {
          seen.push(rects);
        }),
      ),
      Effect.forkScoped,
    );
    yield* settle;

    return seen;
  });

const at = (x: number): Located => ({ url: URL, rects: [{ x, y: 0, width: 10, height: 10 }] });

describe("the pins' reads of the page", () => {
  it.effect("find the elements at once, every second, and soon after the page last moved", () =>
    Effect.gen(function* () {
      const fake = fakePage((read) => at(read));
      const seen = yield* follow(fake.page, ["#a"]);

      expect(fake.reads()).toBe(1);
      expect(seen).toEqual([new Map([["#a", { x: 1, y: 0, width: 10, height: 10 }]])]);

      yield* TestClock.adjust(LOCATE_EVERY);
      yield* settle;
      expect(fake.reads()).toBe(2);

      // A scroll: found again once it has held still for a moment, not on each of its events.
      fake.move();
      yield* TestClock.adjust(Duration.millis(60));
      fake.move();
      yield* TestClock.adjust(Duration.millis(60));
      yield* settle;
      expect(fake.reads()).toBe(2);

      yield* TestClock.adjust(LOCATE_AFTER_MOVE);
      yield* settle;
      expect(fake.reads()).toBe(3);
      expect(seen).toHaveLength(3);
    }).pipe(Effect.scoped),
  );

  it.effect("say nothing new when the elements have not moved, nor of another page", () =>
    Effect.gen(function* () {
      const fake = fakePage((read) =>
        read === 3 ? { ...at(1), url: "https://app.test/other" } : at(1),
      );

      const seen = yield* follow(fake.page, ["#a"]);

      yield* TestClock.adjust(LOCATE_EVERY);
      yield* settle;
      yield* TestClock.adjust(LOCATE_EVERY);
      yield* settle;

      expect(fake.reads()).toBe(3);
      expect(seen).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect("ask the page nothing when the drafts are all areas", () =>
    Effect.gen(function* () {
      const fake = fakePage(at);
      const seen = yield* follow(fake.page, []);

      yield* TestClock.adjust(LOCATE_EVERY);
      yield* settle;

      expect(fake.reads()).toBe(0);
      expect(seen).toEqual([new Map()]);
    }).pipe(Effect.scoped),
  );
});
