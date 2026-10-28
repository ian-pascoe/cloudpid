// The agent's Container resize (docs/architecture/container.md → Resize by the agent; GLOSSARY.md → Container
// resize): `container_resize` has the Workspace's next launch start on another size, up to its Environment's size limit,
// until the idle stop. The size is a one-launch override kept in the Workspace DO's storage: `ContainerLaunch` takes it
// instead of the settings' size (`launchSize`), the launch record keeps what each Container launched with, and the idle
// stop forgets it (`stopIdle`), so the launch after that has the Environment's size again. A running Container is
// snapshotted and stopped as the idle stop does (snapshot, then destroy), so the next one restores what its disk held,
// the Container-only paths included; unlike the idle stop, commands running on it do not keep it.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off
import { compareInstances, type ContainerSettings, type InstanceType } from "@cloudpid/config";
import type { ContainerResizeOutcome } from "@cloudpid/extensions/container";
import type { SnapshotOutcome } from "./snapshots.ts";

/**
 * The size a launch with `settings` has: the one a resize recorded (`recorded`) while their size limit allows it, else
 * their own. A limit the owner lowered after the resize wins over it.
 */
export const launchSize = (
  settings: ContainerSettings,
  recorded: InstanceType | undefined,
): InstanceType =>
  recorded !== undefined && compareInstances(recorded, settings.maxInstance) <= 0
    ? recorded
    : settings.instance;

/** The Workspace DO's side of a resize: its settings, its storage, and its Container. */
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

/** The size the agent's resize recorded for the Workspace's next launch: set by `resize`, forgotten at the idle stop. */
export class ContainerResizes {
  readonly #deps: ContainerResizeDeps;

  constructor(deps: ContainerResizeDeps) {
    this.#deps = deps;
  }

  /** The size recorded for the next launch, if any (`ContainerLaunch`'s `resized`). */
  recorded(): Promise<InstanceType | undefined> {
    return this.#deps.load();
  }

  /** Forget the size recorded, whatever runs: the owner's _Restart container_ starts on the Environment's size. */
  forget(): Promise<void> {
    return this.#deps.clear();
  }

  /**
   * The idle stop's stop (`IdleStop`'s `stop`): when a Container runs, the size recorded is forgotten, so the next
   * launch has the Environment's size, and then the Container is stopped. Forgotten first, so a resize that records a
   * size while the stop is under way is kept for the next launch. An alarm that finds no Container running (one a resize
   * or `container_restart` stopped since its last use) keeps it for the Container the next command starts.
   */
  async stopIdle(): Promise<void> {
    if (this.#deps.running()) await this.#deps.clear();

    await this.#deps.stop();
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
      const previous = launchSize(settings, await deps.load());

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
