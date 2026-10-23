// @effect-diagnostics globalTimers:off globalDate:off -- the browser's own timers and clock, behind an interface the screen's tests can fake.

// The timers of the Live View's screen (#154): a long press, the check after a tap, a picker's late value, the field
// map's throttle. They go through `Timers`, the browser's in the page and a fake in tests, and through one
// `TimerGroup` per screen, which cancels whatever is still pending when the screen goes.

/** Time and timers, as the screen uses them. */
export interface Timers {
  /** The time, in ms. */
  readonly now: () => number;
  /** Run `run` once after `ms`; returns how to cancel it. */
  readonly after: (ms: number, run: () => void) => () => void;
  /** Run `run` every `ms`; returns how to stop. */
  readonly every: (ms: number, run: () => void) => () => void;
}

export const browserTimers: Timers = {
  now: () => Date.now(),
  after: (ms, run) => {
    const timer = setTimeout(run, ms);

    return () => {
      clearTimeout(timer);
    };
  },
  every: (ms, run) => {
    const timer = setInterval(run, ms);

    return () => {
      clearInterval(timer);
    };
  },
};

/** The timers of one screen: `dispose` cancels every one still pending, and none starts after it. */
export class TimerGroup {
  private readonly pending = new Set<() => void>();
  private disposed = false;

  constructor(private readonly timers: Timers) {}

  now(): number {
    return this.timers.now();
  }

  after(ms: number, run: () => void): () => void {
    if (this.disposed) return () => undefined;

    const cancel = this.timers.after(ms, () => {
      this.pending.delete(cancel);
      run();
    });

    this.pending.add(cancel);

    return () => {
      this.pending.delete(cancel);
      cancel();
    };
  }

  every(ms: number, run: () => void): () => void {
    if (this.disposed) return () => undefined;

    const stop = this.timers.every(ms, run);

    this.pending.add(stop);

    return () => {
      this.pending.delete(stop);
      stop();
    };
  }

  dispose(): void {
    this.disposed = true;

    for (const cancel of Array.from(this.pending)) cancel();

    this.pending.clear();
  }
}

/**
 * `run` at most once per `intervalMs`, as soon as it may, however often it is asked for: the field map, read again
 * after each scroll, tap and keystroke.
 */
export class Throttle {
  private scheduled = false;
  private last = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly timers: TimerGroup,
    private readonly intervalMs: number,
    private readonly run: () => void,
  ) {}

  /** Run now if the interval has passed since the last run, else once it has; once however often it is asked. */
  schedule(): void {
    if (this.scheduled) return;

    this.scheduled = true;
    this.timers.after(Math.max(0, this.intervalMs - (this.timers.now() - this.last)), () => {
      this.scheduled = false;
      this.runNow();
    });
  }

  /** Run at once, and count it as a run. */
  runNow(): void {
    this.last = this.timers.now();
    this.run();
  }
}
