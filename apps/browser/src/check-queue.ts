// docs/architecture/visuals.md → The check. The checks of a Session's browser, one at a time: a check waits for those ahead of
// it, however they end, and the host holds at most `max` (the one that runs and those queued), so a script that calls
// `visual_check` in a loop cannot pile up work in the Durable Object. One more fails at once, as busy.
// @effect-diagnostics asyncFunction:off newPromise:off preferEffectArray:off

export class CheckQueue {
  readonly #max: number;
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;

  constructor(max: number) {
    this.#max = max;
  }

  /** How many are held: the one that runs and those queued behind it. */
  get pending(): number {
    return this.#pending;
  }

  /** `task` once those ahead have ended, or a rejection with `busy(held)` when `max` are held already. */
  run<A>(task: () => Promise<A>, busy: (held: number) => Error): Promise<A> {
    if (this.#pending >= this.#max) return Promise.reject(busy(this.#pending));

    this.#pending += 1;

    const result = this.#tail.then(task).finally(() => {
      this.#pending -= 1;
    });

    // The next waits for this one to end, however it ends.
    this.#tail = result.catch(() => undefined);

    return result;
  }
}
