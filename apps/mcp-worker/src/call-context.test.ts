// The budget's leases are Promise-based, so the checks are too.
// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vitest";
import { ByteBudget, makeBudget } from "./budget.ts";
import { progressTo, withCall } from "./call-context.ts";
import { MiB } from "./units.ts";

const hooks = { untilAborted: () => new Promise<void>(() => undefined) };

const env = { version: "test", hold: () => undefined };

/** A call that takes the large slot, keeps no stream, then does `then`. */
const largeCall = <A, E>(then: Effect.Effect<A, E>) =>
  withCall(
    {},
    hooks,
    env,
    (call) => Effect.promise(() => call.lease.charge(10 * MiB)).pipe(Effect.andThen(then)),
    [],
  );

/** Whether the large slot is free: a new lease takes it at once. */
const largeSlotFree = async (budget: ReturnType<typeof makeBudget>) => {
  let taken = false;

  void budget
    .lease()
    .charge(10 * MiB)
    .then(() => {
      taken = true;
    });

  await new Promise((resolve) => setTimeout(resolve, 0));

  return taken;
};

describe("withCall", () => {
  it("gives the call's lease back when the call dies of a defect", async () => {
    const budget = makeBudget();

    const exit = await Effect.runPromiseExit(
      Effect.die(new Error("a defect")).pipe(largeCall, Effect.provideService(ByteBudget, budget)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(await largeSlotFree(budget)).toBe(true);
  });

  it("keeps the lease of a call that handed it to a stream", async () => {
    const budget = makeBudget();

    await Effect.runPromise(
      withCall(
        {},
        hooks,
        env,
        (call) =>
          Effect.promise(() => call.lease.charge(10 * MiB)).pipe(
            Effect.andThen(Effect.sync(() => call.handOff())),
          ),
        [],
      ).pipe(Effect.provideService(ByteBudget, budget)),
    );

    expect(await largeSlotFree(budget)).toBe(false);
  });

  it("gives the lease back when the call ends without a stream", async () => {
    const budget = makeBudget();

    await Effect.runPromise(Effect.void.pipe(largeCall, Effect.provideService(ByteBudget, budget)));

    expect(await largeSlotFree(budget)).toBe(true);
  });
});

describe("progressTo", () => {
  it("passes at most ten notices a second on, and a hook that throws fails nothing", () => {
    const seen: Array<number> = [];
    let now = 0;

    const report = progressTo(
      (progress) => {
        seen.push(progress.progress);

        if (progress.progress === 3) throw new Error("the caller is gone");
      },
      () => now,
    );

    for (const [at, step] of [
      [0, 1],
      [50, 2],
      [100, 3],
      [150, 4],
      [260, 5],
      [300, 6],
    ] as const) {
      now = at;
      report({ progress: step });
    }

    expect(seen).toEqual([1, 3, 5]);
  });
});
