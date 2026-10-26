import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { coalesced } from "./coalesced.ts";

describe("an effect coalesced", () => {
  it.effect("runs once at a time, and once more for any number of asks made meanwhile", () =>
    Effect.gen(function* () {
      let runs = 0;
      const gate = yield* Deferred.make<void>();

      const once = coalesced(
        Effect.suspend(() => {
          runs += 1;

          return runs === 1 ? Deferred.await(gate) : Effect.void;
        }),
      );

      const first = yield* Effect.forkChild(once);

      yield* Effect.yieldNow;

      for (let ask = 0; ask < 50; ask++) yield* once;

      expect(runs).toBe(1);

      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(first);

      expect(runs).toBe(2);

      // Idle again: the next ask runs.
      yield* once;
      expect(runs).toBe(3);
    }),
  );

  it.effect("runs again after a run was interrupted", () =>
    Effect.gen(function* () {
      let runs = 0;

      const once = coalesced(
        Effect.suspend(() => {
          runs += 1;

          return Effect.never;
        }),
      );

      const first = yield* Effect.forkChild(once);

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(first);

      const second = yield* Effect.forkChild(once);

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(second);

      expect(runs).toBe(2);
    }),
  );
});
