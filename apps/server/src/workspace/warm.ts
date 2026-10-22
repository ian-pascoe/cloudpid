// The Container's early start on a message (docs/spec.md → Backends): when the owner sends a message, the Session asks
// its Workspace to start the Container (restore its snapshot or launch the image, push the files, run the bootstrap)
// while the model works on its first response, so the turn's first command on the Container does not wait for it. It
// runs no command. It does nothing while the Container runs or a start is under way, and it never fails: a start that
// fails is logged, and the first command starts the Container as it would have. It is one use of the Container for the
// idle stop, held from its start to its end as a command is, so the bootstrap is never stopped midway.
// @effect-diagnostics asyncFunction:off globalDate:off
import type { CommandTracker } from "./tracked.ts";

export type WarmupDeps = {
  /** Whether the Container is running (`ctx.container.running`): then there is nothing to start. */
  readonly running: () => boolean;
  /** Connect to the Container, launching or restoring it, and push the Workspace's files to it: how many entries went. */
  readonly connect: () => Promise<number>;
  /** Run the bootstrap on the Container connected (`ToolchainBackend.prepare`), which never throws. */
  readonly bootstrap: () => Promise<void>;
  /** The idle stop's count of the Container's uses. */
  readonly tracker: CommandTracker;
  readonly now: () => number;
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
};

export class ContainerWarmup {
  readonly #deps: WarmupDeps;
  #inflight: Promise<void> | undefined;

  constructor(deps: WarmupDeps) {
    this.#deps = deps;
  }

  /** Start the Container, unless it runs or is starting. Resolves once it is ready or has failed; never rejects. */
  start(): Promise<void> {
    if (this.#inflight !== undefined) return this.#inflight;

    if (this.#deps.running()) return Promise.resolve();

    const inflight = this.#run().finally(() => {
      this.#inflight = undefined;
    });

    this.#inflight = inflight;

    return inflight;
  }

  async #run(): Promise<void> {
    const { tracker, now, info, warn } = this.#deps;

    const log = (cause: unknown) =>
      warn(`idle stop: tracking the early start failed: ${String(cause)}`);

    const started = now();

    // A failed write only shortens the idle time: the alarm works from what was stored before.
    tracker.begin().catch(log);
    info("workspace.container.warm: starting the Container for a message");

    try {
      const pushed = await this.#deps.connect();

      info(
        `workspace.container.warm: connected after ${now() - started} ms, ${pushed} entries pushed`,
      );
      await this.#deps.bootstrap();
      info(`workspace.container.warm: ready after ${now() - started} ms`);
    } catch (cause) {
      warn(
        `workspace.container.warm: the early start failed after ${now() - started} ms; the first command starts the Container: ${String(cause instanceof Error ? cause.message : cause)}`,
      );
    } finally {
      tracker.end().catch(log);
    }
  }
}
