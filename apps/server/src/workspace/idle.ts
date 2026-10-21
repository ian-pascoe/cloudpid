// The Container's idle stop (docs/spec.md → Container and Toolchains). computer never stops the Container it starts: its
// connection to computerd (a WebSocket, a heartbeat timer, a container monitor) keeps the Workspace DO in memory, and
// the platform's own inactivity timeout never fires. So the Workspace stops it: every use of the Container records the
// time, and a Durable Object alarm destroys the Container once the idle time has passed without one. A command that is
// still running counts as use (`begin`/`end`): the alarm only waits again while one runs. The idle time is the
// Workspace's setting at the Container's launch (`ContainerLaunch.idleMs`), and the Workspace snapshots the Container's
// disk before it stops it (`stop`).

// @effect-diagnostics asyncFunction:off globalDate:off

/** The Workspace DO's side of the idle stop: its clock, its alarm and storage, and the Container. */
export type IdleStopDeps = {
  /** How long the Container may go unused before it is stopped: the idle time it was launched with. */
  readonly idleMs: () => Promise<number>;
  readonly now: () => number;
  /** The last use recorded in storage, if any. */
  readonly load: () => Promise<number | undefined>;
  readonly save: (at: number) => Promise<void>;
  readonly setAlarm: (at: number) => Promise<void>;
  /** Snapshot the Container's disk. It takes seconds, in which a command may arrive. */
  readonly snapshot: () => Promise<void>;
  /** Stop the Container. */
  readonly stop: () => Promise<void>;
};

export class IdleStop {
  readonly #deps: IdleStopDeps;
  #lastUse: number | undefined;
  #saved: number | undefined;
  #armed = false;
  /** When the alarm that is set will fire. */
  #armedAt = 0;
  /** Commands on the Container that have begun and not ended. In memory: an evicted object has none running. */
  #running = 0;

  constructor(deps: IdleStopDeps) {
    this.#deps = deps;
  }

  /** The Container was used: remember when, and make sure an alarm will check on it. */
  async touch(): Promise<void> {
    const at = this.#deps.now();

    this.#lastUse = at;

    const idleMs = await this.#deps.idleMs();

    // An alarm already set for later than the idle time allows is brought forward: the first use of a Container comes
    // before its launch is recorded, so it is armed with the default time, not the Container's own.
    if (!this.#armed || at + idleMs < this.#armedAt) {
      // Armed only once the alarm is set: a failed write leaves the next use to try again.
      await this.#deps.setAlarm(at + idleMs);
      this.#armed = true;
      this.#armedAt = at + idleMs;
    }

    // Storage is written at most this often: an evicted object then wakes to a use that is at most this old.
    if (this.#saved === undefined || at - this.#saved >= Math.min(30_000, idleMs / 4)) {
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

    const idleMs = await this.#deps.idleMs();

    if (this.#running > 0) {
      this.#armedAt = this.#deps.now() + idleMs;
      await this.#deps.setAlarm(this.#armedAt);
      this.#armed = true;

      return;
    }

    const lastUse = this.#lastUse ?? (await this.#deps.load());

    if (lastUse === undefined) return;

    const due = lastUse + idleMs;

    if (this.#deps.now() < due) {
      this.#armedAt = due;
      await this.#deps.setAlarm(due);
      this.#armed = true;

      return;
    }

    // Forgotten before the snapshot, not after: a use while it is taken is remembered and arms the next alarm.
    this.#lastUse = undefined;
    this.#saved = undefined;
    await this.#deps.snapshot();

    // A command that arrived during the snapshot connected to this Container, and stopping it now would kill the
    // command. The use re-armed the alarm, which takes over.
    if (this.#lastUse !== undefined || this.#running > 0) return;

    await this.#deps.stop();
  }
}
