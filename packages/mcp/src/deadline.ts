// @effect-diagnostics missingPipeableSignature:off -- a constructor over a plain value.
// A deadline a question's wait can stop (`docs/architecture/mcp-server-requests.md` → Questions): a `tools/call`'s
// timeout, which stands still while a question waits for the owner and starts again from the whole on a progress
// notice. The one helper for both ends of a call: the core's (which ends the server request) and the Session's (which
// gives up on the host). Its timer is a fiber on Effect's clock, so a test clock moves it; no SDK is loaded here, so
// the Session and the `mcp` extension import it from `./types`.
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

/** A deadline `ms` away: `signal` aborts when it passes, with what `reason` makes. */
export interface PausableDeadline {
  readonly signal: AbortSignal;
  /** Stops the clock; every `pause` needs its `resume`, and the deadline runs again when each has resumed. */
  readonly pause: Effect.Effect<void>;
  readonly resume: Effect.Effect<void>;
  /** Progress: the whole time again, from now. */
  readonly reset: Effect.Effect<void>;
  /** The call is over: stop the timer for good. Later `resume` and `reset` start none. */
  readonly clear: Effect.Effect<void>;
}

const deadlineOver = Effect.fnUntraced(function* (
  controller: AbortController,
  ms: number,
  reason: () => Error,
) {
  let remaining = ms;
  let startedAt = yield* Clock.currentTimeMillis;
  let paused = 0;
  let closed = false;
  let timer: Fiber.Fiber<void> | undefined;

  const stop = Effect.suspend(() => {
    const running = timer;

    timer = undefined;

    return running === undefined ? Effect.void : Fiber.interrupt(running);
  });

  const arm = (delay: number) =>
    Effect.gen(function* () {
      startedAt = yield* Clock.currentTimeMillis;
      timer = yield* Effect.sleep(Duration.millis(delay)).pipe(
        Effect.andThen(Effect.sync(() => controller.abort(reason()))),
        Effect.forkDetach,
      );
    });

  /** Whether the clock should be running: not stopped by a question, not over, not cleared. */
  const running = () => paused === 0 && !closed && !controller.signal.aborted;

  yield* arm(ms);

  return {
    signal: controller.signal,
    pause: Effect.gen(function* () {
      paused += 1;

      if (paused === 1) {
        yield* stop;
        remaining -= (yield* Clock.currentTimeMillis) - startedAt;
      }
    }),
    resume: Effect.suspend(() => {
      paused = Math.max(0, paused - 1);

      return running() ? arm(Math.max(1, remaining)) : Effect.void;
    }),
    reset: Effect.suspend(() => {
      remaining = ms;

      return running() ? Effect.andThen(stop, arm(ms)) : Effect.void;
    }),
    clear: Effect.suspend(() => {
      closed = true;

      return stop;
    }),
  } satisfies PausableDeadline;
});

/**
 * A deadline `ms` away. The controller is made here, outside the Effect, as the lint rules ask; `reason` is what the
 * signal aborts with (the SDK's timeout error at the core's end).
 */
export const pausableDeadline = (
  ms: number,
  reason: () => Error,
): Effect.Effect<PausableDeadline> => deadlineOver(new AbortController(), ms, reason);
