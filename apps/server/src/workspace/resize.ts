// The agent's Container resize (docs/spec.md → Container and Toolchains → Resize by the agent; GLOSSARY.md → Container
// resize): `container_resize` has the Workspace's next launch start on another size, up to its Environment's size limit,
// until the idle stop. The size is a one-launch override kept in the Workspace DO's storage: `ContainerLaunch` takes it
// instead of the settings' size (`resized`), the launch record keeps what each Container launched with, and the idle
// stop forgets it (`stopIdle`), so the launch after that has the Environment's size again. A running Container is
// snapshotted and stopped as the idle stop does (snapshot, then destroy), so the next one restores what its disk held,
// the Container-only paths included; unlike the idle stop, commands running on it do not keep it.
// @effect-diagnostics asyncFunction:off
import { compareInstances, type ContainerSettings, type InstanceType } from "@cloudpid/config";
import type { ContainerResizeOutcome } from "@cloudpid/extensions/container";
import type { SnapshotOutcome } from "./snapshots.ts";

export type ContainerResizeDeps = {
  /** The Workspace's settings now: its Environment's size and size limit. */
  readonly settings: () => Promise<ContainerSettings>;
  /** Whether a Container is running now. */
  readonly running: () => boolean;
  /** The size the running Container launched with, from its launch record; undefined when none is recorded. */
  readonly launched: () => Promise<InstanceType | undefined>;
  /** The size recorded for the next launch, if any. */
  readonly load: () => Promise<InstanceType | undefined>;
  readonly save: (size: InstanceType) => Promise<void>;
  readonly clear: () => Promise<void>;
  /** Snapshot the running Container's disk, as the idle stop does (`ContainerLaunch.snapshot`). */
  readonly snapshot: () => Promise<SnapshotOutcome>;
  /** Stop the running Container (destroy it), as the idle stop does. */
  readonly stop: () => Promise<void>;
  readonly info: (message: string) => void;
};

export class ContainerResizes {
  readonly #deps: ContainerResizeDeps;

  constructor(deps: ContainerResizeDeps) {
    this.#deps = deps;
  }

  /** The size recorded for the next launch, if any (`ContainerLaunch`'s `resized`). */
  recorded(): Promise<InstanceType | undefined> {
    return this.#deps.load();
  }

  /**
   * The idle stop's stop (`IdleStop`'s `stop`): the Container is stopped, and when one ran, the size recorded is
   * forgotten, so the next launch has the Environment's size. An alarm that finds no Container running (one a resize or
   * `container_restart` stopped since its last use) keeps it for the Container the next command starts.
   */
  async stopIdle(): Promise<void> {
    const ran = this.#deps.running();

    await this.#deps.stop();

    if (ran) await this.#deps.clear();
  }

  /**
   * Have the next launch start on `size`. Refused above the Environment's size limit. A running Container that already
   * has `size` is left running; any other is snapshotted and stopped, whatever runs on it. The size is recorded before
   * the stop, so a command that starts a Container right after it gets `size`; the Environment's own size is recorded
   * as no override at all.
   */
  async resize(size: InstanceType): Promise<ContainerResizeOutcome> {
    const deps = this.#deps;
    const settings = await deps.settings();
    const environment = settings.instance;

    if (compareInstances(size, settings.maxInstance) > 0) {
      return { outcome: "refused", limit: settings.maxInstance };
    }

    const record = () => (size === environment ? deps.clear() : deps.save(size));

    if (!deps.running()) {
      const recorded = await deps.load();

      const previous =
        recorded !== undefined && compareInstances(recorded, settings.maxInstance) <= 0
          ? recorded
          : environment;

      await record();
      deps.info(`Container resize: the next launch starts on ${size} (no Container ran)`);

      return {
        outcome: "resized",
        wasRunning: false,
        previous,
        next: size,
        environment,
        snapshotted: false,
      };
    }

    const launched = await deps.launched();

    if (launched === size) {
      // The size it has stays for a restart, and the idle stop still forgets it.
      await record();

      return { outcome: "unchanged", size };
    }

    const snapshotted = (await deps.snapshot()) === "taken";

    await record();
    await deps.stop();
    deps.info(
      `Container resize: stopped the Container on ${launched ?? "an unrecorded size"}${snapshotted ? "" : " without a new snapshot"}; the next launch starts on ${size}`,
    );

    return {
      outcome: "resized",
      wasRunning: true,
      previous: launched ?? environment,
      next: size,
      environment,
      snapshotted,
    };
  }
}
