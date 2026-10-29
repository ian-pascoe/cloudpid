// The Container's idle stop (docs/architecture/container.md → Idle stop). computer never stops the Container it starts:
// its connection to computerd (a WebSocket, a heartbeat timer, a container monitor) keeps the Workspace DO in memory, and
// the platform's own inactivity timeout never fires. So the Workspace stops it: every use of the Container records the
// time, and a Durable Object alarm destroys the Container once the idle time has passed without one. A command that is
// still running holds it (`hold`): the alarm only waits again while one runs. The idle time is the Workspace's setting
// at the Container's launch (`ContainerLaunch.idleMs`), and the Workspace snapshots the Container's disk before it stops
// it (`stop`).
//
// Holds and uses are bounded by the hold cap: a Container kept past `CONTAINER_HOLD_CAP_MS` (or its idle time, when
// longer) since the last owner or agent activity in the Workspace (`noteActivity`: a command started, a Session's message or
// live Run, a file write) is snapshotted and stopped as at the idle stop, its holds dropped (a held stop). A command
// handle never released, or a Container preview left open, can then keep it no longer.
//
// What may change the Container's disk is told of (`wrote`): a hold that may write (a command, by default) as it
// begins, and `noteWrite` for the rest (a bootstrap that installed something, a Setup or Start Script). The launch
// record keeps it, and an idle stop of a Container in which nothing did takes no snapshot (`launch.ts`).

// @effect-diagnostics asyncFunction:off globalDate:off

/**
 * How long a Container may be kept running, by a hold (a command, a Container preview's socket) or by uses (a Container
 * preview's requests), after the last owner or agent activity in its Workspace: an hour, or the Container's idle time
 * when that is longer. Counted from the last activity, never from the Container's start, so a long build is stopped
 * only once nothing in the Workspace has happened for an hour.
 */
export const CONTAINER_HOLD_CAP_MS = 60 * 60_000;

/** The activity is written to storage at most this often: an evicted object wakes to activity at most this old. */
const ACTIVITY_SAVE_MS = 60_000;

/** A held stop: the Container stopped at `at`, kept past the hold cap since the last activity at `lastActivity`. */
export type HeldStop = {
  readonly at: number;
  readonly lastActivity: number;
  /** The holds it had (commands, Container preview sockets), dropped with it. */
  readonly holds: number;
};

/** How long `stop`'s Container went without activity before it was stopped, in whole minutes. */
export const heldStopMinutes = (stop: HeldStop): number =>
  Math.round((stop.at - stop.lastActivity) / 60_000);

/** What holds the Container. */
export type HoldOptions = {
  /**
   * Whether what holds it may change the Container's disk: a command, a script (the default). Not a Container preview's
   * socket, a bootstrap's own hold (it tells of what it changed with `noteWrite`), the agent's resize (it snapshots
   * itself), nor the Workspace DO's reads.
   */
  readonly writes?: boolean | undefined;
};

/** A hold on the Container: it is in use, however quiet, until `end`. */
export type ContainerHold = {
  /** The use the hold began with, recorded. Its failure only shortens the idle time. */
  readonly begun: Promise<void>;
  /** End the hold (a use); once only. A hold a held stop dropped ends as a use only. */
  readonly end: () => Promise<void>;
};

/** The Workspace DO's side of the idle stop: its clock, its alarm and storage, and the Container. */
export type IdleStopDeps = {
  /** How long the Container may go unused before it is stopped: the idle time it was launched with. */
  readonly idleMs: () => Promise<number>;
  readonly now: () => number;
  /** The last use recorded in storage, if any. */
  readonly load: () => Promise<number | undefined>;
  readonly save: (at: number) => Promise<void>;
  /** The last owner or agent activity recorded in storage, if any. Absent: kept in memory only. */
  readonly loadActivity?: (() => Promise<number | undefined>) | undefined;
  readonly saveActivity?: ((at: number) => Promise<void>) | undefined;
  readonly setAlarm: (at: number) => Promise<void>;
  /** Whether a Container runs now. Absent: taken as running. */
  readonly running?: (() => boolean) | undefined;
  /** Snapshot the Container's disk. It takes seconds, in which a command may arrive. */
  readonly snapshot: () => Promise<void>;
  /** Stop the Container. */
  readonly stop: () => Promise<void>;
  /** Told of a held stop once the Container is stopped: the Workspace logs it and keeps it for its Sessions. */
  readonly held?: ((stop: HeldStop) => Promise<void>) | undefined;
  /**
   * Told of something that may change the Container's disk (a command or a Container-only file write as its hold
   * begins, a script): the launch record keeps it, so the idle stop snapshots (`ContainerLaunch.noteWrite`).
   */
  readonly wrote?: (() => Promise<void>) | undefined;
  /** Told of every use of the Container (`ContainerUsageLedger.seen`). */
  readonly used?: (() => void) | undefined;
  /** Told when commands begin to run on the Container and when the last one ends (`ContainerUsageLedger.busy`). */
  readonly busy?: ((busy: boolean) => void) | undefined;
};

export class IdleStop {
  readonly #deps: IdleStopDeps;
  #lastUse: number | undefined;
  #saved: number | undefined;
  #lastActivity: number | undefined;
  #activitySaved: number | undefined;
  #armed = false;
  /** When the alarm that is set will fire. */
  #armedAt = 0;
  /** The holds on the Container that have begun and not ended. In memory: an evicted object has none running. */
  readonly #holds = new Set<object>();
  /** Those of `#holds` that may change the Container's disk. */
  readonly #writing = new Set<object>();

  constructor(deps: IdleStopDeps) {
    this.#deps = deps;
  }

  /** The Container was used: remember when, and make sure an alarm will check on it. */
  async touch(): Promise<void> {
    const at = this.#deps.now();

    this.#lastUse = at;
    this.#deps.used?.();

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

  /**
   * The owner or the agent did something in the Workspace (a command started, a message, a live Run, a file write): the
   * hold cap counts from now. Not a use of the Container: it neither keeps it from the idle stop nor arms the alarm.
   */
  async noteActivity(): Promise<void> {
    const at = this.#deps.now();

    this.#lastActivity = at;

    if (this.#activitySaved === undefined || at - this.#activitySaved >= ACTIVITY_SAVE_MS) {
      this.#activitySaved = at;
      await this.#deps.saveActivity?.(at);
    }
  }

  /**
   * Something that may change the Container's disk ran without a hold of its own that writes (a bootstrap that
   * installed something, a Setup or Start Script): the idle stop snapshots the Container.
   */
  async noteWrite(): Promise<void> {
    await this.#deps.wrote?.();
  }

  /**
   * Whether a hold that may change the Container's disk is on it now: a Container a command launches is changed from its
   * start, though the command's `noteWrite` came before the launch was recorded.
   */
  writing(): boolean {
    return this.#writing.size > 0;
  }

  /** Whether anything holds the Container now: a command, a Container preview's socket, a bootstrap. */
  held(): boolean {
    return this.#holds.size > 0;
  }

  /**
   * A command (or a Container preview's socket, a bootstrap) began on the Container: it is in use until it ends. One
   * that may write (`options.writes`, the default) is told of as it begins.
   */
  hold(options: HoldOptions = {}): ContainerHold {
    const token = {};
    const writes = options.writes !== false;

    this.#holds.add(token);

    if (writes) this.#writing.add(token);

    if (this.#holds.size === 1) this.#deps.busy?.(true);

    let ended = false;

    return {
      begun: writes
        ? Promise.all([this.touch(), this.noteWrite()]).then(() => undefined)
        : this.touch(),
      end: () => {
        if (!ended) {
          ended = true;
          this.#writing.delete(token);

          if (this.#holds.delete(token) && this.#holds.size === 0) this.#deps.busy?.(false);
        }

        return this.touch();
      },
    };
  }

  /**
   * The latest the Container goes on without another use: when the idle time since its last use runs out, or the hold
   * cap since the last activity if sooner (its snapshot then takes a little longer). Null while a command runs, or when
   * no use is known.
   */
  async stopsBy(): Promise<number | null> {
    if (this.#holds.size > 0) return null;

    const lastUse = this.#lastUse ?? (await this.#deps.load());

    if (lastUse === undefined) return null;

    const idleMs = await this.#deps.idleMs();
    const activity = this.#lastActivity ?? (await this.#deps.loadActivity?.());
    const idleDue = lastUse + idleMs;

    return activity === undefined ? idleDue : Math.min(idleDue, activity + this.#capMs(idleMs));
  }

  /**
   * The alarm: stop the Container if it has been idle for the whole idle time, or kept past the hold cap since the last
   * activity; else wait for whichever comes first.
   */
  async alarm(): Promise<void> {
    this.#armed = false;

    const idleMs = await this.#deps.idleMs();
    const held = this.#holds.size > 0;
    const lastUse = held ? undefined : (this.#lastUse ?? (await this.#deps.load()));

    if (!held && lastUse === undefined) return;

    const now = this.#deps.now();
    const idleDue = lastUse === undefined ? undefined : lastUse + idleMs;

    if (idleDue !== undefined && now >= idleDue) {
      await this.#snapshotAndStop();

      return;
    }

    // Kept, by a hold or a recent use: no longer than the hold cap since the last activity.
    const activity = await this.#activitySince(now);
    const capDue = activity + this.#capMs(idleMs);

    if (now >= capDue) {
      await this.#heldStop(activity);

      return;
    }

    this.#armedAt = Math.min(idleDue ?? now + idleMs, capDue);
    await this.#deps.setAlarm(this.#armedAt);
    this.#armed = true;
  }

  /**
   * Snapshot and stop the Container now, whatever its idle time, as the alarm does once it is due: a spare Workspace
   * once it is prepared. A command that runs keeps it, and so does one that arrives during the snapshot, as for the alarm.
   */
  async stop(): Promise<void> {
    if (this.#holds.size > 0) return;

    await this.#snapshotAndStop();
  }

  /** The hold cap for a Container of idle time `idleMs`: never shorter than the idle time. */
  #capMs(idleMs: number): number {
    return Math.max(CONTAINER_HOLD_CAP_MS, idleMs);
  }

  /** The last activity: in memory, else stored; when none is known, from now (recorded), so the cap counts from here. */
  async #activitySince(now: number): Promise<number> {
    if (this.#lastActivity !== undefined) return this.#lastActivity;

    const stored = await this.#deps.loadActivity?.();

    if (stored !== undefined) {
      this.#lastActivity = stored;

      return stored;
    }

    await this.noteActivity();

    return now;
  }

  /**
   * Stop a Container kept past the hold cap since `lastActivity`, holds and all: its holds are dropped (their commands
   * end with it), so a hold that never ends keeps no later Container. Activity during the snapshot keeps it.
   */
  async #heldStop(lastActivity: number): Promise<void> {
    // No Container runs (a restart or a resize stopped it since): there is nothing to stop, only the holds to drop.
    if (this.#deps.running?.() === false) {
      this.#dropHolds();

      return;
    }

    this.#lastUse = undefined;
    this.#saved = undefined;
    await this.#deps.snapshot();

    // The owner or the agent came back while the disk was saved: the Container is kept, holds and all, and its alarm
    // armed again.
    if (this.#lastActivity !== lastActivity) {
      await this.touch();

      return;
    }

    const holds = this.#dropHolds();

    await this.#deps.stop();
    await this.#deps.held?.({ at: this.#deps.now(), lastActivity, holds });
  }

  /** Drop every hold: their ends, if they come, count as uses only. Answers how many there were. */
  #dropHolds(): number {
    const holds = this.#holds.size;

    this.#holds.clear();
    this.#writing.clear();

    if (holds > 0) this.#deps.busy?.(false);

    return holds;
  }

  async #snapshotAndStop(): Promise<void> {
    // Forgotten before the snapshot, not after: a use while it is taken is remembered and arms the next alarm.
    this.#lastUse = undefined;
    this.#saved = undefined;
    await this.#deps.snapshot();

    // A command that arrived during the snapshot connected to this Container, and stopping it now would kill the
    // command. The use re-armed the alarm, which takes over.
    if (this.#lastUse !== undefined || this.#holds.size > 0) return;

    await this.#deps.stop();
  }
}
