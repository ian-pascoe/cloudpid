import * as Effect from "effect/Effect";

/**
 * `run` at most once at a time, and once more if it was asked again meanwhile, however often it is asked (a run that fails, dies or is interrupted lets the next ask run): a page that
 * opens windows without end costs the Session one listing at a time, not one per window.
 */
export const coalesced = (run: Effect.Effect<void>): Effect.Effect<void> => {
  let state: "idle" | "running" | "again" = "idle";

  const loop: Effect.Effect<void> = run.pipe(
    Effect.andThen(
      Effect.suspend(() => {
        if (state === "again") {
          state = "running";

          return loop;
        }

        state = "idle";

        return Effect.void;
      }),
    ),
    Effect.onExit(() =>
      Effect.sync(() => {
        state = "idle";
      }),
    ),
  );

  return Effect.suspend(() => {
    if (state !== "idle") {
      state = "again";

      return Effect.void;
    }

    state = "running";

    return loop;
  });
};
