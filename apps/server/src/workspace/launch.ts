// How the Workspace DO launches its Container (docs/spec.md → Container and Toolchains → Size and idle, Snapshots).
// `@cloudflare/computer`'s `ContainerBackend` builds each launch's spec itself and has no hook for either a size that
// changes or a snapshot, so this wraps the Container API it launches through (`wrap`):
//
// - the instance type is the Workspace's setting when the Container launches, and is then kept for as long as that
//   Container runs. computer relaunches a running Container whose launch differs from the one asked for, so a setting
//   saved meanwhile must not reach a reconnect to it: it applies at the next launch;
// - the idle time is kept the same way, for the idle stop;
// - the latest snapshot is restored when there is one. A Container that does not come up from it is started again from
//   the image (computer's one restart), and the snapshot is forgotten.
// @effect-diagnostics asyncFunction:off
import type {
  ContainerInstanceSize,
  ContainerLaunchSpec,
  IWorkspaceContainerAPI,
} from "@cloudflare/computer/backends/container";
import { DEFAULT_WORKSPACE_SETTINGS, type WorkspaceSettings } from "@cloudpid/config";
import type { ContainerSnapshots } from "./snapshots.ts";

/** What the Container that is running (or was last launched) was launched with. */
export type LaunchRecord = {
  readonly instance: ContainerInstanceSize;
  readonly idleMinutes: number;
  /** Whether it still wants a snapshot once its Toolchains are installed: it did not start from one. */
  readonly needsSnapshot: boolean;
  /** The snapshot it started from, if any. */
  readonly restoredFrom: string | undefined;
  /** Epoch milliseconds. */
  readonly launchedAt: number;
};

export type ContainerLaunchDeps = {
  /** The Workspace's settings now. */
  readonly settings: () => Promise<WorkspaceSettings>;
  readonly snapshots: Pick<ContainerSnapshots, "restorable" | "forget" | "take">;
  readonly load: () => Promise<LaunchRecord | undefined>;
  readonly save: (record: LaunchRecord) => Promise<void>;
  /** Whether a Container is running now. */
  readonly running: () => boolean;
  readonly now: () => number;
  readonly warn: (message: string) => void;
};

const MINUTE = 60_000;

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

    if ((await this.#deps.snapshots.take("install")) === "taken") {
      await this.#remember({ ...record, needsSnapshot: false });
    }
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

    const instance =
      kept?.instance ?? (running ? DEFAULT_WORKSPACE_SETTINGS.instance : settings.instance);

    const snapshot = running ? undefined : await this.#deps.snapshots.restorable();

    this.#restoring = snapshot?.id;

    const launch: ContainerLaunchSpec = { ...spec, instance };

    if (snapshot !== undefined) launch.containerSnapshot = snapshot;

    const info = await api.start(launch);

    if (info.outcome === "adopted") {
      // Nothing launched. One adopted with no record (started before launches were recorded) gets one.
      this.#restoring = undefined;

      if (kept === undefined) {
        await this.#remember({
          instance,
          idleMinutes: settings.idleMinutes,
          needsSnapshot: false,
          restoredFrom: undefined,
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
      launchedAt: this.#deps.now(),
    });

    return info;
  }

  async #restart(api: IWorkspaceContainerAPI, spec: ContainerLaunchSpec) {
    const record = await this.#current();
    const restoring = this.#restoring;

    this.#restoring = undefined;

    if (restoring !== undefined) {
      this.#deps.warn(
        `The Container did not come up from snapshot ${restoring}: starting it from the image and forgetting the snapshot`,
      );
      await this.#deps.snapshots.forget();

      if (record !== undefined) {
        await this.#remember({ ...record, needsSnapshot: true, restoredFrom: undefined });
      }
    }

    return api.restart({
      ...spec,
      instance: record?.instance ?? DEFAULT_WORKSPACE_SETTINGS.instance,
    });
  }
}
