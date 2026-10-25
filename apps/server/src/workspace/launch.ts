// How the Workspace DO launches its Container (docs/spec.md → Container and Toolchains → Container settings, Snapshots).
// `@cloudflare/computer`'s `ContainerBackend` builds each launch's spec itself and has no hook for either a size that
// changes or a snapshot, so this wraps the Container API it launches through (`wrap`):
//
// - the size is the one the agent's resize recorded for it (`resize.ts`), else the Workspace's setting, when the
//   Container launches, and is then kept for as long as that Container runs. computer relaunches a running Container whose launch differs from the one asked for, so a setting
//   saved meanwhile must not reach a reconnect to it: it applies at the next launch;
// - the idle time is kept the same way, for the idle stop;
// - the latest snapshot is restored when there is one. A Container that does not come up from it is started again from
//   the image (computer's one restart), and the snapshot is forgotten when the Container died, not when it was slow. A
//   start the platform rejects outright for a snapshot (an expired handle) is retried once from the image;
// - the image the Container runs is recorded per launch (the image of the snapshot it restored, else the deployed one),
//   because Containers outlive a deploy: a snapshot is labelled with that, never with the image a launch would run now;
// - every launch carries the Workspace's labels (`labels`), which Cloudflare's usage analytics are filtered by;
// - the Container-only paths (computer's `ignore`: the built-in ones, then the Workspace's own) are decided before
//   computer builds the launch (`ignore`), kept for as long as that Container runs, and recorded from the launch itself,
//   so a snapshot is restored only by a launch with the paths it was taken with;
// - a Workspace with no snapshot of its own starts from its Environment's Build (docs/spec.md → Builds) when the Build
//   is of the image a launch would run now, has the launch's Container-only paths and is within its lifetime. Such a
//   launch has computerd's store reset (`RESET_STORE_VARIABLE` in its environment), and asks for it again whenever it
//   reconnects to that Container, since computer relaunches a running Container whose environment differs. A Build
//   that does not come up falls back to the image as a snapshot does, and this Workspace does not try it again.
// @effect-diagnostics asyncFunction:off preferEffectArray:off missingPipeableSignature:off
import type {
  ContainerLaunchSpec,
  IWorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import {
  compareInstances,
  containerInstance,
  DEFAULT_CONTAINER_SETTINGS,
  type InstanceType,
  type ContainerSettings,
} from "@cloudpid/config";
import { type EnvironmentBuild, RESET_STORE_VARIABLE } from "./build-record.ts";
import {
  type ContainerSnapshots,
  samePaths,
  SNAPSHOT_MAX_AGE_MS,
  type SnapshotOutcome,
  type SnapshotReason,
} from "./snapshots.ts";

/** What the Container that is running (or was last launched) was launched with. */
export type LaunchRecord = {
  /** The stored size name (`InstanceType`), not its resources: `containerInstance` maps it at each start. */
  readonly instance: InstanceType;
  readonly idleMinutes: number;
  /** Whether it still wants a snapshot once its Toolchains are installed: it did not start from one. */
  readonly needsSnapshot: boolean;
  /** Whether a bootstrap installed something that is not in a snapshot yet (the one after it was not taken). */
  readonly installPending?: boolean | undefined;
  /** The snapshot it started from, if any. */
  readonly restoredFrom: string | undefined;
  /** The reference of the image it runs; undefined when not known (a Container adopted with no record). */
  readonly image: string | undefined;
  /** The Container-only paths it launched with; none where it had none. Absent from older records. */
  readonly ignore?: readonly string[] | undefined;
  /** Whether it started from its Environment's Build, with computerd's store reset (`RESET_STORE_VARIABLE`). */
  readonly resetStore?: boolean | undefined;
  /** Epoch milliseconds. */
  readonly launchedAt: number;
};

export type ContainerLaunchDeps = {
  /** The Workspace's settings now. */
  readonly settings: () => Promise<ContainerSettings>;
  /**
   * The size the agent's resize recorded for the next launch (`ContainerResizes`), which it takes instead of the
   * settings' while it is within their size limit; undefined for none.
   */
  readonly resized?: (() => Promise<InstanceType | undefined>) | undefined;
  /** The Container-only paths a launch with `settings` has: the built-in ones, then the Workspace's own. */
  readonly ignore: (settings: ContainerSettings) => readonly string[] | undefined;
  readonly snapshots: Pick<
    ContainerSnapshots,
    "restorable" | "restored" | "forget" | "take" | "capture"
  >;
  /** The Environment's Build the Workspace holds, which a launch with no snapshot of its own may start from. */
  readonly builds?: {
    /** The Build, unless this Workspace has given up on it (`failed`). */
    readonly current: () => Promise<EnvironmentBuild | undefined>;
    /** A Container started from the Build `id` did not come up: this Workspace does not try it again. */
    readonly failed: (id: string) => Promise<void>;
  };
  /** The reference of the image a Container launched now would run. */
  readonly image: () => string | undefined;
  readonly load: () => Promise<LaunchRecord | undefined>;
  readonly save: (record: LaunchRecord) => Promise<void>;
  /** Whether a Container is running now. */
  readonly running: () => boolean;
  readonly now: () => number;
  readonly warn: (message: string) => void;
  readonly info: (message: string) => void;
  /** Labels every Container is launched with, which Cloudflare's analytics are filtered by (`container-analytics.ts`). */
  readonly labels?: Readonly<Record<string, string>> | undefined;
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

/** The size a launch with `settings` has: the one a resize recorded, while the size limit allows it, else the settings'. */
const launchInstance = (
  settings: ContainerSettings,
  resized: InstanceType | undefined,
): InstanceType =>
  resized !== undefined && compareInstances(resized, settings.maxInstance) <= 0
    ? resized
    : settings.instance;

/** `spec` with computerd's store reset at the Container's start (`RESET_STORE_VARIABLE`) when `reset`. */
const resettingStore = (spec: ContainerLaunchSpec, reset: boolean): ContainerLaunchSpec =>
  reset ? { ...spec, env: { ...spec.env, [RESET_STORE_VARIABLE]: "1" } } : spec;

export class ContainerLaunch {
  readonly #deps: ContainerLaunchDeps;
  #record: LaunchRecord | undefined;
  /** The snapshot the launch in progress restores from, until the Container is known to be up. */
  #restoring: string | undefined;
  /** Whether that snapshot is the Environment's Build's, not the Workspace's own. */
  #restoringBuild = false;

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
        : this.#deps.ignore(DEFAULT_CONTAINER_SETTINGS);
    }

    return this.#deps.ignore(await this.#deps.settings());
  }

  /** How long the running Container may go unused: what it was launched with, not what the settings say now. */
  async idleMs(): Promise<number> {
    const record = await this.#current();

    return (record?.idleMinutes ?? DEFAULT_CONTAINER_SETTINGS.idleMinutes) * MINUTE;
  }

  /**
   * The Toolchains are installed in the running Container, and `changed` says whether the bootstrap installed any.
   * When it started from the image and something was installed (now, or by an earlier bootstrap whose snapshot was not
   * taken), snapshot it, so the next launch skips the downloads. A bootstrap that installed nothing (the image had
   * every Toolchain) does not hold the first command for a snapshot: the idle stop's takes one. One restored from a
   * snapshot has nothing new to keep (the idle stop snapshots again).
   */
  async afterInstall(changed: boolean): Promise<void> {
    const record = await this.#current();

    if (record === undefined || !record.needsSnapshot) return;

    if (!changed && record.installPending !== true) {
      this.#deps.info(
        "The Toolchain bootstrap installed nothing: no snapshot until the Container idles",
      );

      return;
    }

    if ((await this.snapshot("install")) === "taken") {
      await this.#remember({ ...record, needsSnapshot: false, installPending: false });
    } else if (changed && record.installPending !== true) {
      await this.#remember({ ...record, installPending: true });
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

  /**
   * Snapshot the running Container as an Environment's Build (`build.ts`), without keeping it as the Workspace's own:
   * the handle, with the image and Container-only paths it was launched with, or why there is none.
   */
  async captureBuild(): Promise<
    | {
        readonly ok: true;
        readonly snapshot: { readonly id: string; readonly size: number };
        readonly image: string;
        readonly ignore: readonly string[] | undefined;
      }
    | { readonly ok: false; readonly reason: string }
  > {
    const record = await this.#current();

    if (record?.image === undefined) {
      return { ok: false, reason: "the image the Container runs is not known" };
    }

    const captured = await this.#deps.snapshots.capture("build", record.image);

    return captured.outcome === "taken"
      ? {
          ok: true,
          snapshot: { id: captured.id, size: captured.size },
          image: record.image,
          ignore: record.ignore,
        }
      : { ok: false, reason: captured.reason };
  }

  /** `spec` with the Workspace's labels. computer does not compare labels, so adding them relaunches nothing. */
  #labelled(spec: ContainerLaunchSpec): ContainerLaunchSpec {
    const { labels } = this.#deps;

    return labels === undefined ? spec : { ...spec, labels: { ...spec.labels, ...labels } };
  }

  async #current(): Promise<LaunchRecord | undefined> {
    this.#record ??= await this.#deps.load();

    return this.#record;
  }

  async #remember(record: LaunchRecord): Promise<void> {
    this.#record = record;
    await this.#deps.save(record);
  }

  /**
   * The Environment's Build a launch with the Container-only paths `ignore` may start from: one of the image a launch
   * would run now, taken with the same paths, and not near the end of its snapshot's lifetime.
   */
  async #usableBuild(ignore: readonly string[] | undefined): Promise<EnvironmentBuild | undefined> {
    const build = await this.#deps.builds?.current();

    if (build === undefined) {
      this.#deps.info("Container launch: no Environment's Build held (or it failed here)");

      return undefined;
    }

    const unusable =
      build.image !== this.#deps.image()
        ? `it is of image ${build.image}, a launch runs ${this.#deps.image() ?? "an unknown one"}`
        : !samePaths(build.ignore ?? undefined, ignore)
          ? "its Container-only paths differ from the launch's"
          : this.#deps.now() - build.finishedAt > SNAPSHOT_MAX_AGE_MS
            ? "it is older than a snapshot's lifetime"
            : undefined;

    if (unusable !== undefined) {
      this.#deps.info(
        `Container launch: the Environment's Build ${build.snapshot.id} is not used: ${unusable}`,
      );

      return undefined;
    }

    return build;
  }

  async #start(api: IWorkspaceContainerAPI, spec: ContainerLaunchSpec) {
    // A Container that already runs is adopted if this asks for what it launched with; anything else would relaunch it.
    const running = this.#deps.running();
    const kept = running ? await this.#current() : undefined;
    const settings = await this.#deps.settings();

    const instance =
      kept?.instance ??
      (running ? UNRECORDED_INSTANCE : launchInstance(settings, await this.#deps.resized?.()));

    const size = containerInstance(instance);

    const ignore = ignoreOf(spec);
    let snapshot = running ? undefined : await this.#deps.snapshots.restorable(ignore);

    // With no snapshot of its own, the Workspace starts from its Environment's Build.
    let build = running || snapshot !== undefined ? undefined : await this.#usableBuild(ignore);

    this.#restoring = snapshot?.id ?? build?.snapshot.id;
    this.#restoringBuild = build !== undefined;

    // A Container that started from a Build was launched with the store reset, which a reconnect asks for again.
    let launch: ContainerLaunchSpec = resettingStore(
      this.#labelled({ ...spec, instance: size }),
      build !== undefined || kept?.resetStore === true,
    );

    if (snapshot !== undefined) launch.containerSnapshot = { id: snapshot.id };

    if (build !== undefined) launch.containerSnapshot = { id: build.snapshot.id };

    let info;

    try {
      info = await api.start(launch);
    } catch (cause) {
      if (snapshot === undefined && build === undefined) throw cause;

      const why = cause instanceof Error ? cause.message : String(cause);

      if (build !== undefined) {
        // The platform refused the Build's snapshot (an expired or unknown handle, or one another object's Container may
        // not start from): this Workspace starts from the image, and leaves that Build alone from now on.
        this.#deps.warn(
          `The Container could not be started from the Environment's Build ${build.snapshot.id} (${why}): starting it from the image`,
        );
        await this.#deps.builds?.failed(build.snapshot.id);
      } else if (snapshot !== undefined) {
        // The platform refused the snapshot outright (an expired or unknown handle): the image is the way forward.
        this.#deps.warn(
          `The Container could not be started from snapshot ${snapshot.id} (${why}): starting it from the image and forgetting the snapshot`,
        );
        await this.#deps.snapshots.forget();
      }

      snapshot = undefined;
      build = undefined;
      this.#restoring = undefined;
      this.#restoringBuild = false;
      launch = this.#labelled({ ...spec, instance: size });
      info = await api.start(launch);
    }

    this.#deps.info(
      info.outcome === "adopted"
        ? `Container launch: the running Container was adopted${kept?.resetStore === true ? ", asking again for the store reset it started with" : ""}`
        : `Container launch: ${info.outcome} from ${
            snapshot !== undefined
              ? `the Workspace's snapshot ${snapshot.id}`
              : build !== undefined
                ? `the Environment's Build ${build.snapshot.id}, with computerd's store reset`
                : "the image"
          }`,
    );

    if (info.outcome === "adopted") {
      // Nothing launched. One adopted with no record (started before launches were recorded) gets one.
      this.#restoring = undefined;
      this.#restoringBuild = false;

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
      // A Container from the Build holds none of the Workspace's own work: it is snapshotted after its install too.
      needsSnapshot: snapshot === undefined,
      restoredFrom: snapshot?.id ?? build?.snapshot.id,
      image: snapshot?.image ?? build?.image ?? this.#deps.image(),
      ignore,
      resetStore: build !== undefined,
      launchedAt: this.#deps.now(),
    });

    // The restore began the snapshot's 30 days again.
    if (snapshot !== undefined) await this.#deps.snapshots.restored();

    return info;
  }

  async #restart(api: IWorkspaceContainerAPI, spec: ContainerLaunchSpec) {
    let record = await this.#current();
    const restoring = this.#restoring;
    const restoringBuild = this.#restoringBuild;

    this.#restoring = undefined;
    this.#restoringBuild = false;

    if (restoring !== undefined && restoringBuild) {
      // A Container that does not come up from the Environment's Build, slow or dead, starts from the image, and this
      // Workspace does not try that Build again: its own install snapshot replaces it.
      this.#deps.warn(
        `The Container did not answer after starting from the Environment's Build ${restoring}: starting it from the image`,
      );
      await this.#deps.builds?.failed(restoring);
    } else if (restoring !== undefined) {
      // A Container that is merely slow to restore (a big snapshot on a cold host) keeps its snapshot; one that died, or
      // that the platform could not restore, does not.
      const exited = (await api.exitInfo().catch(() => null)) !== null;

      this.#deps.warn(
        exited
          ? `The Container exited after starting from snapshot ${restoring}: starting it from the image and forgetting the snapshot`
          : `The Container did not answer after starting from snapshot ${restoring}: starting it from the image`,
      );

      if (exited) await this.#deps.snapshots.forget();
    }

    if (record !== undefined && restoring !== undefined) {
      record = {
        ...record,
        needsSnapshot: true,
        restoredFrom: undefined,
        image: this.#deps.image(),
      };
    }

    // computer's restart launches from the image with its own environment: no store to reset.
    if (record !== undefined && (restoring !== undefined || record.resetStore === true)) {
      const { resetStore: _reset, ...rest } = record;

      await this.#remember(rest);
    }

    // Without a record the Container is one found running that was launched before launches were recorded (as in
    // `#start`), else this is a launch of its own and the settings decide.
    const instance =
      record?.instance ??
      (this.#deps.running()
        ? UNRECORDED_INSTANCE
        : launchInstance(await this.#deps.settings(), await this.#deps.resized?.()));

    this.#deps.info("Container launch: restarted from the image (computer's restart)");

    return api.restart(this.#labelled({ ...spec, instance: containerInstance(instance) }));
  }
}
