// Something costly that the Diff pane holds while it is open and lets go of a while after it closes: the highlighting
// Worker Pool and the line-up worker are made when the Pane opens and shut 30 s after it closes, so closing and opening
// it again soon does not start them over.
// @effect-diagnostics missingPipeableSignature:off -- a plain constructor over callbacks, called from React.

/** How long a released thing is kept before it is disposed of. */
export const KEEP_AFTER_CLOSE_MS = 30_000;

/** Hands out one shared thing while anyone holds it. */
export interface Keeper<T> {
  /** The thing, made now if nobody held it and it was not kept. */
  readonly acquire: () => T;
  /** Let go of it; once nobody holds it, it is disposed of after the grace. */
  readonly release: () => void;
}

/** A keeper of what `create` makes, disposed of `graceMs` after its last holder lets go. */
export const keeperOf = <T, Timer>({
  create,
  dispose,
  graceMs = KEEP_AFTER_CLOSE_MS,
  setTimer,
  clearTimer,
}: {
  readonly create: () => T;
  readonly dispose: (value: T) => void;
  readonly graceMs?: number;
  readonly setTimer: (run: () => void, ms: number) => Timer;
  readonly clearTimer: (timer: Timer) => void;
}): Keeper<T> => {
  let kept: { readonly value: T } | undefined;
  let holders = 0;
  let timer: { readonly id: Timer } | undefined;

  return {
    acquire: () => {
      holders += 1;

      if (timer !== undefined) {
        clearTimer(timer.id);
        timer = undefined;
      }

      kept ??= { value: create() };

      return kept.value;
    },
    release: () => {
      holders = Math.max(0, holders - 1);

      if (holders > 0 || kept === undefined || timer !== undefined) return;

      timer = {
        id: setTimer(() => {
          timer = undefined;

          if (holders > 0 || kept === undefined) return;

          const { value } = kept;

          kept = undefined;
          dispose(value);
        }, graceMs),
      };
    },
  };
};
