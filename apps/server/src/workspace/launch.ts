// How the Workspace DO launches its Container (docs/spec.md → Container and Toolchains → Size and idle, Snapshots).
// `@cloudflare/computer`'s `ContainerBackend` builds each launch's spec itself and has no hook for either a size that
// changes or a snapshot, so this wraps the Container API it launches through (`wrap`):
//
// - the size is the Workspace's setting when the Container launches, and is then kept for as long as that
//   Container runs. computer relaunches a running Container whose launch differs from the one asked for, so a setting
//   saved meanwhile must not reach a reconnect to it: it applies at the next launch;
// - the idle time is kept the same way, for the idle stop;
// - the latest snapshot is restored when there is one. A Container that does not come up from it is started again from
//   the image (computer's one restart), and the snapshot is forgotten when the Container died, not when it was slow. A
//   start the platform rejects outright for a snapshot (an expired handle) is retried once from the image;
// - the image the Container runs is recorded per launch (the image of the snapshot it restored, else the deployed one),
//   because Containers outlive a deploy: a snapshot is labelled with that, never with the image a launch would run now;
// - the Container-only paths (computer's `ignore`: the built-in ones, then the Workspace's own) are decided before
//   computer builds the launch (`ignore`), kept for as long as that Container runs, and recorded from the launch itself,
//   so a snapshot is restored only by a launch with the paths it was taken with.
// @effect-diagnostics asyncFunction:off preferEffectArray:off missingPipeableSignature:off
import type {
  ContainerLaunchSpec,
  IWorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import {
  containerInstance,
  DEFAULT_WORKSPACE_SETTINGS,
  type InstanceType,
  type WorkspaceSettings,
} from "@cloudpid/config";
import type { ContainerSnapshots, SnapshotOutcome, SnapshotReason } from "./snapshots.ts";

/** What the Container that is running (or was last launched) was launched with. */
export type LaunchRecord = {
  /** The stored size name (`InstanceType`), not its resources: `containerInstance` maps it at each start. */
  readonly instance: InstanceType;
  readonly idleMinutes: number;
  /** Whether it still wants a snapshot once its Toolchains are installed: it did not start from one. */
  readonly needsSnapshot: boolean;
  /** The snapshot it started from, if any. */
  readonly restoredFrom: string | undefined;
  /** The reference of the image it runs; undefined when not known (a Container adopted with no record). */
  readonly image: string | undefined;
  /** The Container-only paths it launched with; none where it had none. Absent from older records. */
  readonly ignore?: readonly string[] | undefined;
  /** Epoch milliseconds. */
  readonly launchedAt: number;
};

export type ContainerLaunchDeps = {
  /** The Workspace's settings now. */
  readonly settings: () => Promise<WorkspaceSettings>;
  /** The Container-only paths a launch with `settings` has: the built-in ones, then the Workspace's own. */
  readonly ignore: (settings: WorkspaceSettings) => readonly string[] | undefined;
  readonly snapshots: Pick<ContainerSnapshots, "restorable" | "restored" | "forget" | "take">;
  /** The reference of the image a Container launched now would run. */
  readonly image: () => string | undefined;
  readonly load: () => Promise<LaunchRecord | undefined>;
  readonly save: (record: LaunchRecord) => Promise<void>;
  /** Whether a Container is running now. */
  readonly running: () => boolean;
  readonly now: () => number;
  readonly warn: (message: string) => void;
};

const MINUTE = 60_000;

/**
 * The size of a running Container found with no launch record: one launched before launches were recorded, when every
 * Workspace's default was `standard-2`. It is adopted as that, not as today's default, so a default that changed
 * meanwhile does not make computer relaunch it.
 */
const UNRECORDED_INSTANCE: InstanceType = "standard-2";

/** The Container-only paths of a launch, as computer passes them to computerd (`MOUNT_IGNORE`), if it has any. */
const ignoreOf = (spec: ContainerLaunchSpec): readonly string[] | undefined => {
  const joined = spec.env?.["MOUNT_IGNORE"];

  if (joined === undefined) return undefined;

  return joined === "" ? [] : joined.split(",");
};

/**
 * The Container-only paths of a launch: the built-in ones, then the Workspace's own, so that a `!` pattern of its own
 * keeps a built-in one synced. A pattern given twice is kept only where it comes last, which is the one that decides
 * (the last match wins), so the list computer checks computerd against has no repeats.
 */
export const containerIgnore = (
  builtIn: readonly string[],
  own: readonly string[],
): readonly string[] => {
  const all = [...builtIn, ...own];

  return all.filter((pattern, index) => all.lastIndexOf(pattern) === index);
};

export class ContainerLaunch {
  readonly #deps: ContainerLaunchDeps;
  #record: LaunchRecord | undefined;
  /** The snapshot the launch in progress restores from, until the Container is known to be up. */
  #restoring: string | undefined;

  constructor(deps: ContainerLaunchDeps) {
    this.#deps = deps;
  }

  /** `api`, the Container API `ContainerBackend` launches through, with each launch's size and snapshot decided here. */
  wrap(api: IWorkspaceContainerAPI): IWorkspaceContainerAPI {
    return {
      start: (spec) => this.#start(api, spec),
      restart: (spec) => this.#restart(api, spec),
      interceptOutboundHttp: (host, workspace) => api.interceptOutboundHttp(host, workspace),
      interceptAllOutboundHttp: (workspace, token) =>
        api.interceptAllOutboundHttp(workspace, token),
      fetchPort: (port, input, init) => api.fetchPort(port, input, init),
      port: (port) => api.port(port),
      setInactivityTimeout: (durationMs) => api.setInactivityTimeout(durationMs),
      status: () => api.status(),
      exitInfo: () => api.exitInfo(),
    };
  }

  /**
   * The Container-only paths of the Container a connection reaches: what the running one launched with, else what a
   * launch now would have. computer takes them when its backend is built, before the launch, so they are asked for here
   * first. One found running with no list on record (launched before lists were recorded) gets the built-in ones; when
   * a deploy changed those since, computer relaunches it, as for any change to its launch.
   */
  async ignore(): Promise<readonly string[] | undefined> {
    if (this.#deps.running()) {
      const kept = await this.#current();

      return kept !== undefined && "ignore" in kept
        ? kept.ignore
        : this.#deps.ignore(DEFAULT_WORKSPACE_SETTINGS);
    }

    return this.#deps.ignore(await this.#deps.settings());
  }

  /** How long the running Container may go unused: what it was launched with, not what the settings say now. */
  async idleMs(): Promise<number> {
    const record = await this.#current();

    return (record?.idleMinutes ?? DEFAULT_WORKSPACE_SETTINGS.idleMinutes) * MINUTE;
  }

  /**
   * The Toolchains are installed in the running Container. When it started from the image, snapshot it, so the next
   * launch skips the downloads; one restored from a snapshot has nothing new to keep (the idle stop snapshots again).
   */
  async afterInstall(): Promise<void> {
    const record = await this.#current();

    if (record === undefined || !record.needsSnapshot) return;

    if ((await this.snapshot("install")) === "taken") {
      await this.#remember({ ...record, needsSnapshot: false });
    }
  }

  /**
   * Snapshot the running Container, labelled with the image it runs. A Container with no record (adopted from before
   * launches were recorded) has no known image, and gets no snapshot.
   */
  async snapshot(reason: SnapshotReason): Promise<SnapshotOutcome> {
    const record = await this.#current();

    return record?.image === undefined
      ? "skipped"
      : this.#deps.snapshots.take(reason, record.image, record.ignore);
  }

  async #current(): Promise<LaunchRecord | undefined> {
    this.#record ??= await this.#deps.load();

    return this.#record;
  }

  async #remember(record: LaunchRecord): Promise<void> {
    this.#record = record;
    await this.#deps.save(record);
  }

  async #start(api: IWorkspaceContainerAPI, spec: ContainerLaunchSpec) {
    // A Container that already runs is adopted if this asks for what it launched with; anything else would relaunch it.
    const running = this.#deps.running();
    const kept = running ? await this.#current() : undefined;
    const settings = await this.#deps.settings();

    const instance = kept?.instance ?? (running ? UNRECORDED_INSTANCE : settings.instance);
    const size = containerInstance(instance);

    const ignore = ignoreOf(spec);
    let snapshot = running ? undefined : await this.#deps.snapshots.restorable(ignore);

    this.#restoring = snapshot?.id;

    let launch: ContainerLaunchSpec = { ...spec, instance: size };

    if (snapshot !== undefined) launch.containerSnapshot = { id: snapshot.id };

    let info;

    try {
      info = await api.start(launch);
    } catch (cause) {
      if (snapshot === undefined) throw cause;

      // The platform refused the snapshot outright (an expired or unknown handle): the image is the way forward.
      this.#deps.warn(
        `The Container could not be started from snapshot ${snapshot.id} (${cause instanceof Error ? cause.message : String(cause)}): starting it from the image and forgetting the snapshot`,
      );
      await this.#deps.snapshots.forget();
      snapshot = undefined;
      this.#restoring = undefined;
      launch = { ...spec, instance: size };
      info = await api.start(launch);
    }

    if (info.outcome === "adopted") {
      // Nothing launched. One adopted with no record (started before launches were recorded) gets one.
      this.#restoring = undefined;

      if (kept === undefined) {
        await this.#remember({
          instance,
          idleMinutes: settings.idleMinutes,
          needsSnapshot: false,
          restoredFrom: undefined,
          image: undefined,
          ignore,
          launchedAt: this.#deps.now(),
        });
      }

      return info;
    }

    await this.#remember({
      instance,
      idleMinutes: settings.idleMinutes,
      needsSnapshot: snapshot === undefined,
      restoredFrom: snapshot?.id,
      image: snapshot === undefined ? this.#deps.image() : snapshot.image,
      ignore,
      launchedAt: this.#deps.now(),
    });

    // The restore began the snapshot's 30 days again.
    if (snapshot !== undefined) await this.#deps.snapshots.restored();

    return info;
  }

  async #restart(api: IWorkspaceContainerAPI, spec: ContainerLaunchSpec) {
    const record = await this.#current();
    const restoring = this.#restoring;

    this.#restoring = undefined;

    if (restoring !== undefined) {
      // A Container that is merely slow to restore (a big snapshot on a cold host) keeps its snapshot; one that died, or
      // that the platform could not restore, does not.
      const exited = (await api.exitInfo().catch(() => null)) !== null;

      this.#deps.warn(
        exited
          ? `The Container exited after starting from snapshot ${restoring}: starting it from the image and forgetting the snapshot`
          : `The Container did not answer after starting from snapshot ${restoring}: starting it from the image`,
      );

      if (exited) await this.#deps.snapshots.forget();

      if (record !== undefined) {
        await this.#remember({
          ...record,
          needsSnapshot: true,
          restoredFrom: undefined,
          image: this.#deps.image(),
        });
      }
    }

    return api.restart({
      ...spec,
      instance: containerInstance(record?.instance ?? DEFAULT_WORKSPACE_SETTINGS.instance),
    });
  }
}
