// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { describe, expect, it } from "vitest";
import { triggerObjects, WAKE_RETRIES } from "./objects.ts";

/** Trigger objects whose `sync` fails `failures` times before it answers, each try's object name in `asked`. */
const objectsFailing = (failures: number) => {
  const asked: string[] = [];
  let failing = failures;

  // SAFETY: the Trigger objects call only `getByName`, and on its result only `sync` and `remove`.
  const namespace = {
    getByName: (name: string) => ({
      sync: () =>
        Effect.suspend(() => {
          asked.push(name);

          if (failing > 0) {
            failing--;

            return Effect.die(new Error("no answer"));
          }

          return Effect.succeed({ status: "synced" });
        }),
      remove: () => Effect.void,
    }),
  } as never;

  return { asked, objects: triggerObjects(namespace, Schedule.spaced(0)) };
};

describe("triggerObjects", () => {
  it("wakes an object that answers after a few tries", async () => {
    const { asked, objects } = objectsFailing(WAKE_RETRIES);

    await Effect.runPromise(objects.wake("t1"));

    expect(asked).toEqual(Array.from({ length: WAKE_RETRIES + 1 }, () => "trigger:t1"));
  });

  it("fails the wake of an object that never answers, and only logs a sync's", async () => {
    const waking = objectsFailing(10);

    const failed = await Effect.runPromise(waking.objects.wake("t1").pipe(Effect.flip));

    expect(failed._tag).toBe("TriggerUnreachable");
    expect(waking.asked).toHaveLength(WAKE_RETRIES + 1);

    const syncing = objectsFailing(10);

    await Effect.runPromise(syncing.objects.sync("t1"));

    expect(syncing.asked).toEqual(["trigger:t1"]);
  });
});
