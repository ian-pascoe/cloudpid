// The Container's early start (docs/spec.md → Backends): when the owner sends a message, the Session asks its Workspace
// to start the Container (restore its snapshot or launch the image, push the files, run the bootstrap) while the model
// works on its first response, so the turn's first command on the Container does not wait for it. It runs no command.
// While the Container runs or a start is under way it starts nothing, and it never fails: a start that fails is logged,
// and the first command starts the Container as it would have. A message is a use of the Container for the idle stop
// either way: an early start is held from its start to its end as a command is, so the bootstrap is never stopped
// midway, and a message to a running Container touches the idle clock, so it is not stopped while the model thinks.
// The bootstrap holds the Container itself too (`ToolchainBackend`'s `activity`, for a bootstrap whose waiting command
// went away): the idle stop counts holds, so the two nest, each ending its own.
// @effect-diagnostics asyncFunction:off globalDate:off
import type { IdleStop } from "./idle.ts";

export type EarlyStartDeps = {
  /** Whether the Container is running (`ctx.container.running`): then there is nothing to start. */
  readonly running: () => boolean;
  /** Connect to the Container, launching or restoring it, and push the Workspace's files to it: how many entries went. */
  readonly connect: () => Promise<number>;
  /** Run the bootstrap on the Container connected (`ToolchainBackend.runBootstrap`), which never throws. */
  readonly runBootstrap: () => Promise<void>;
  /** The idle stop, which counts the Container's uses. */
  readonly idle: Pick<IdleStop, "begin" | "end" | "touch">;
  readonly now: () => number;
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
};

/** The key of the early start's log lines. */
const LOG_KEY = "workspace.container.early_start";

export class ContainerEarlyStart {
  readonly #deps: EarlyStartDeps;
  #inflight: Promise<void> | undefined;

  constructor(deps: EarlyStartDeps) {
    this.#deps = deps;
  }

  /**
   * Start the Container for a message, unless it runs or is starting. Resolves once it is ready or has failed; never
   * rejects.
   */
  start(): Promise<void> {
    // The start under way holds the Container in use until it ends.
    if (this.#inflight !== undefined) return this.#inflight;

    if (this.#deps.running()) return this.#touch();

    const inflight = this.#run().finally(() => {
      this.#inflight = undefined;
    });

    this.#inflight = inflight;

    return inflight;
  }

  /** The message is a use of the running Container. */
  #touch(): Promise<void> {
    return this.#deps.idle.touch().catch(this.#trackingFailed);
  }

  /** A failed write only shortens the idle time: the alarm works from what was stored before. */
  readonly #trackingFailed = (cause: unknown) => {
    this.#deps.warn(`idle stop: tracking the early start failed: ${String(cause)}`);
  };

  async #run(): Promise<void> {
    const { idle, now, info, warn } = this.#deps;
    const started = now();

    idle.begin().catch(this.#trackingFailed);
    info(`${LOG_KEY}: starting the Container for a message`);

    try {
      const pushed = await this.#deps.connect();

      info(`${LOG_KEY}: connected after ${now() - started} ms, ${pushed} entries pushed`);
      await this.#deps.runBootstrap();
      info(`${LOG_KEY}: ready after ${now() - started} ms`);
    } catch (cause) {
      warn(
        `${LOG_KEY}: failed after ${now() - started} ms; the first command starts the Container: ${String(cause instanceof Error ? cause.message : cause)}`,
      );
    } finally {
      idle.end().catch(this.#trackingFailed);
    }
  }
}
