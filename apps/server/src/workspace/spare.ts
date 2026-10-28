// A spare Workspace preparing itself (docs/architecture/workspace.md → Spare Workspace, ADR-0016). The main Worker registers each
// Environment's spare and asks its Durable Object to prepare (`prepareSpare`), but its `waitUntil` lasts far less than a
// clone, so the object does the work: the request is stored and the object's alarm, shared with the idle stop, starts
// it. The work readies the Workspace as a Session's readying would (`prepareWorkspace` over the object's own Container:
// the settings, the clones on `SPARE_BRANCH`, their Setup and Start Scripts, the bootstrap), holding the Container from
// the idle stop meanwhile, then snapshots the Container and stops it as the idle stop does, unless a Session took the
// spare meanwhile (anything but the preparation used the object: `noteUse`), whose Container is then left to the idle
// stop as any Workspace's. That use is kept (`markUsed`), so a request that comes after it (the main Worker's upkeep
// asking again) or an eviction does not prepare, nor stop, a Workspace a Session works in. A readying that fails is
// logged and the spare is left as it is: the Session that takes it readies it as usual. An object evicted midway finds
// the request at its next alarm (the idle stop's, armed by the hold) and starts again, a few times at most.
// @effect-diagnostics asyncFunction:off
import type { IdleStop } from "./idle.ts";
import type { WorkspaceSetup } from "./prepare.ts";

/** What the object keeps of a spare's preparation until it is done: what to ready it with, and how often it began. */
export type SpareRequest = { readonly setup: WorkspaceSetup; readonly attempts: number };

/** How many times a preparation cut off by an eviction is begun before it is given up on. */
export const SPARE_ATTEMPTS = 3;

export type SparePreparationDeps = {
  readonly load: () => Promise<SpareRequest | undefined>;
  readonly save: (request: SpareRequest) => Promise<void>;
  readonly clear: () => Promise<void>;
  /** Whether a use other than the preparation's was kept (`markUsed`). */
  readonly used: () => boolean;
  /** Keep that something other than the preparation used the object: a Session took it. */
  readonly markUsed: () => void;
  /** Have the object's alarm fire by `at`, keeping one set for earlier. */
  readonly wake: (at: number) => Promise<void>;
  /** Ready the Workspace with `setup` on the object's own Container, its bootstrap included. */
  readonly prepare: (setup: WorkspaceSetup) => Promise<void>;
  /** The idle stop: it holds the Container while the work runs, and stops it after (`IdleStop.stop`). */
  readonly idle: Pick<IdleStop, "begin" | "end" | "stop">;
  readonly now: () => number;
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
};

/** The key of the spare's log lines. */
const LOG_KEY = "workspace.spare";

export class SparePreparation {
  readonly #deps: SparePreparationDeps;
  #inflight: Promise<void> | undefined;
  /** Whether anything but the preparation used the object: a Session took the spare. Kept, never undone. */
  #used: boolean;

  constructor(deps: SparePreparationDeps) {
    this.#deps = deps;
    this.#used = deps.used();
  }

  /**
   * Keep `setup` to prepare the spare with, and wake the object for it. Answers before any of the work. A Workspace a
   * Session took is not prepared again.
   */
  async request(setup: WorkspaceSetup): Promise<void> {
    if (this.#used) {
      this.#deps.info(`${LOG_KEY}: asked to prepare a Workspace already in use; nothing done`);

      return;
    }

    await this.#deps.save({ setup, attempts: 0 });
    await this.#deps.wake(this.#deps.now());
  }

  /**
   * When an alarm the idle stop wants at `at` should be set instead: no later than now while a request waits for the
   * alarm that starts it, so the idle stop does not put it off.
   */
  async alarmAt(at: number): Promise<number> {
    if (this.#inflight !== undefined || (await this.#deps.load()) === undefined) return at;

    return Math.min(at, this.#deps.now());
  }

  /**
   * Something other than the preparation used the object (a Session's command, file operation, readying or early
   * start): the spare is taken, so the preparation leaves its Container running when it ends, and none begins after.
   */
  noteUse(): void {
    if (this.#used) return;

    this.#used = true;
    this.#deps.markUsed();
  }

  /** The alarm: start the preparation a request waits for, unless one runs. Answers once it has begun. */
  async alarm(): Promise<void> {
    if (this.#inflight !== undefined) return;

    const request = await this.#deps.load();

    if (request === undefined || this.#inflight !== undefined) return;

    if (this.#used) {
      await this.#deps.clear();
      this.#deps.info(`${LOG_KEY}: taken before its preparation began; not prepared`);

      return;
    }

    if (request.attempts >= SPARE_ATTEMPTS) {
      await this.#deps.clear();
      this.#deps.warn(
        `${LOG_KEY}: given up after ${request.attempts} preparations that did not finish; the Session that takes it readies it`,
      );

      return;
    }

    await this.#deps.save({ ...request, attempts: request.attempts + 1 });

    // Not awaited: the work outlasts the alarm, and the Container's connection keeps the object in memory meanwhile.
    this.#inflight = this.#run(request.setup).finally(() => {
      this.#inflight = undefined;
    });
  }

  async #run(setup: WorkspaceSetup): Promise<void> {
    const { idle, now, info, warn } = this.#deps;
    const started = now();

    const trackingFailed = (cause: unknown) => {
      warn(`idle stop: tracking the spare's preparation failed: ${String(cause)}`);
    };

    // Held from the start, so the idle stop never stops the Container midway, and its alarm is armed.
    idle.begin().catch(trackingFailed);

    let prepared = false;

    try {
      await this.#deps.prepare(setup);
      prepared = true;
      info(`${LOG_KEY}: prepared in ${now() - started} ms`);
    } catch (cause) {
      warn(
        `${LOG_KEY}: preparing failed after ${now() - started} ms; the Session that takes it readies it: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      await idle.end().catch(trackingFailed);
    }

    try {
      await this.#deps.clear();

      if (prepared && this.#used) {
        info(`${LOG_KEY}: taken while it was prepared; its Container is left to the idle stop`);
      } else if (prepared) {
        // Stopped as at an idle stop: snapshotted first, so the Session that takes it restores it.
        await idle.stop();
      }
    } catch (cause) {
      warn(`${LOG_KEY}: stopping the prepared Container failed: ${String(cause)}`);
    }
  }
}
