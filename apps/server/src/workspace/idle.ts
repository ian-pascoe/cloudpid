// The Container's idle stop (docs/spec.md → Container and Toolchains). computer never stops the Container it starts: its
// connection to computerd (a WebSocket, a heartbeat timer, a container monitor) keeps the Workspace DO in memory, and
// the platform's own inactivity timeout never fires. So the Workspace stops it: every use of the Container records the
// time, and a Durable Object alarm destroys the Container once the idle time has passed without one. A command that is
// still running counts as use (`begin`/`end`): the alarm only waits again while one runs. Minimal on purpose: the idle
// time is fixed and nothing is snapshotted first. The configurable time and snapshots come with #24 (snapshots and
// idle stop).

// @effect-diagnostics asyncFunction:off globalDate:off

/** How long the Container may go unused before it is stopped (docs/spec.md: 15 minutes). */
export const IDLE_STOP_MS = 15 * 60_000;

/** The Workspace DO's side of the idle stop: its clock, its alarm and storage, and the Container. */
export type IdleStopDeps = {
  readonly idleMs: number;
  readonly now: () => number;
  /** The last use recorded in storage, if any. */
  readonly load: () => Promise<number | undefined>;
  readonly save: (at: number) => Promise<void>;
  readonly setAlarm: (at: number) => Promise<void>;
  /** Stop the Container. */
  readonly stop: () => Promise<void>;
};

export class IdleStop {
  readonly #deps: IdleStopDeps;
  #lastUse: number | undefined;
  #saved: number | undefined;
  #armed = false;
  /** Commands on the Container that have begun and not ended. In memory: an evicted object has none running. */
  #running = 0;

  constructor(deps: IdleStopDeps) {
    this.#deps = deps;
  }

  /** The Container was used: remember when, and make sure an alarm will check on it. */
  async touch(): Promise<void> {
    const at = this.#deps.now();

    this.#lastUse = at;

    if (!this.#armed) {
      // Armed only once the alarm is set: a failed write leaves the next use to try again.
      await this.#deps.setAlarm(at + this.#deps.idleMs);
      this.#armed = true;
    }

    // Storage is written at most this often: an evicted object then wakes to a use that is at most this old.
    if (this.#saved === undefined || at - this.#saved >= Math.min(30_000, this.#deps.idleMs / 4)) {
      await this.#deps.save(at);
      this.#saved = at;
    }
  }

  /** A command started on the Container: it is in use, however quiet, until `end`. */
  begin(): Promise<void> {
    this.#running++;

    return this.touch();
  }

  /** A command on the Container ended (or its client went away). */
  end(): Promise<void> {
    this.#running = Math.max(0, this.#running - 1);

    return this.touch();
  }

  /** The alarm: stop the Container if it has been idle for the whole idle time, else wait for the rest of it. */
  async alarm(): Promise<void> {
    this.#armed = false;

    if (this.#running > 0) {
      await this.#deps.setAlarm(this.#deps.now() + this.#deps.idleMs);
      this.#armed = true;

      return;
    }

    const lastUse = this.#lastUse ?? (await this.#deps.load());

    if (lastUse === undefined) return;

    const due = lastUse + this.#deps.idleMs;

    if (this.#deps.now() < due) {
      await this.#deps.setAlarm(due);
      this.#armed = true;

      return;
    }

    // Forgotten before the stop, not after: a use while the Container stops is remembered and arms the next alarm.
    this.#lastUse = undefined;
    this.#saved = undefined;
    await this.#deps.stop();
  }
}
