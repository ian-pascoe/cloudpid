// The Workspace DO (docs/spec.md → Durable Objects, ADR-0001): one `@cloudflare/computer` Workspace per slug, its
// files in this object's SQLite storage, its commands on the Worker Shell or, for real binaries, in the Container the
// object schedules itself (ADR-0004; `durable_object` scheduling). It is a plain class rather than an alchemy
// Effect DO: computer reaches it through `__getWorkspaceStub()` with raw Workers RPC (its Worker Shell calls back into
// it through `WorkspaceServiceProxy`), which alchemy's Effect bridge would wrap in its own envelopes.
// @effect-diagnostics asyncFunction:off globalDate:off globalConsole:off
import {
  noopObserver,
  Workspace as ComputerWorkspace,
  WorkerBundle,
  type WorkspaceObserver,
  type WorkspaceStub,
} from "@cloudflare/computer";
import {
  ContainerBackend,
  type ContainerBackendOptions,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import jq from "@cloudflare/computer/shell/jq";
import { TOOLCHAIN_IGNORE } from "@cloudpid/sandbox-image/toolchains";
import {
  type EnvRequest,
  type EnvResponse,
  type HostOperation,
  WorkspaceEnvHost,
} from "@cloudpid/computer-env";
import { DurableObject } from "cloudflare:workers";
import type * as Schema from "effect/Schema";
import { BUNDLED_SKILLS } from "./bundled-skills.generated.ts";
import { workerShellGit } from "./git.ts";
import { IdleStop } from "./idle.ts";
import { ContainerLaunch, type LaunchRecord } from "./launch.ts";
import {
  type WorkspaceSettingsAnswer,
  workspaceSettingsStore,
  type WriteAnswer,
} from "./settings.ts";
import { ContainerSnapshots, type SnapshotRecord, scanContainerDisk } from "./snapshots.ts";
import { ToolchainBackend } from "./toolchains.ts";
import { TrackedWorkspaceStub } from "./tracked.ts";
import { SKILLS_MOUNT, WORKSPACE_CONTAINER, WORKSPACE_BINDING, WORKSPACE_ROOT } from "./binding.ts";

export type WorkspaceEnv = {
  /** The Worker Loader the Worker Shell runs in. */
  readonly LOADER: WorkerLoader;
  /**
   * The GitHub token commands on the Container get as `GH_TOKEN` and `GITHUB_TOKEN` (a deploy-time secret,
   * `CLOUDPID_GITHUB_TOKEN`). Absent or empty, commands run without one.
   */
  readonly CLOUDPID_GITHUB_TOKEN?: string;
  /** The identity of the agent's commits where the Container has no other (`CLOUDPID_GIT_NAME`, `CLOUDPID_GIT_EMAIL`). */
  readonly CLOUDPID_GIT_NAME?: string;
  readonly CLOUDPID_GIT_EMAIL?: string;
  /**
   * `"false"` where the Container's `/workspace` is not a real FUSE mount, as under `alchemy dev`: computerd's
   * userspace shim refuses an ignore list and exits. Anything else applies `TOOLCHAIN_IGNORE`.
   */
  readonly CONTAINER_FUSE?: string;
};

/** A Durable Object that can start the Container it is bound to (`getWorkspaceContainer()`, for `ContainerBackend`). */
const ContainerHost = withWorkspaceContainer(class extends DurableObject<WorkspaceEnv> {});

/** Where the last use of the Container is kept, for an alarm that wakes an evicted object. */
const LAST_USE_KEY = "cloudpid:container-last-use";

/** Where the Container's launch (its instance type, idle time, snapshot) and its latest snapshot are kept. */
const LAUNCH_KEY = "cloudpid:container-launch";
const SNAPSHOT_KEY = "cloudpid:container-snapshot";

/**
 * How long a snapshot, its scan included, may take. The install's is short because the Container's first commands wait
 * for it; the idle stop's can be long, since nothing waits.
 */
const SNAPSHOT_TIMEOUT_MS = { install: 60_000, idle: 2 * 60_000 } as const;

/** How long the search of the disk for the GitHub token may take before the snapshot is given up on. */
const SCAN_TIMEOUT_MS = 30_000;

/**
 * How long computer waits for a launched Container to answer, in all, split between its launch and its one restart.
 * Twice the default: a snapshot restored on a cold host should not be taken for a Container that failed.
 */
const CONNECT_TIMEOUT_MS = 60_000;

/** The id the Container's backend has in the Workspace (`@cloudflare/computer`'s default). */
export const CONTAINER_BACKEND_ID = "container-shell";

export class Workspace extends ContainerHost {
  readonly #workspace: ComputerWorkspace;
  readonly #host: WorkspaceEnvHost;
  readonly #container: ContainerBackend;
  readonly #idle: IdleStop;
  readonly #settings: ReturnType<typeof workspaceSettingsStore>;

  constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
    super(ctx, env);

    this.#settings = workspaceSettingsStore(ctx.storage);

    const snapshots = new ContainerSnapshots({
      // The local Container has no real mount, and no snapshots.
      enabled: env.CONTAINER_FUSE !== "false",
      secret: env.CLOUDPID_GITHUB_TOKEN,
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
      image: () => ctx.container?.images[WORKSPACE_CONTAINER],
      running: () => ctx.container?.running === true,
      snapshot: (name) => {
        if (ctx.container === undefined) return Promise.reject(new Error("no Container"));

        return ctx.container.snapshotContainer({ name });
      },
      scan: (secret) => {
        if (ctx.container === undefined) return Promise.reject(new Error("no Container"));

        return scanContainerDisk(ctx.container, secret, SCAN_TIMEOUT_MS);
      },
      load: () => ctx.storage.get<SnapshotRecord>(SNAPSHOT_KEY),
      save: (record) => ctx.storage.put(SNAPSHOT_KEY, record),
      clear: async () => {
        await ctx.storage.delete(SNAPSHOT_KEY);
      },
      now: () => Date.now(),
      warn: (message) => console.warn(message),
      info: (message) => console.info(message),
    });

    // The size and idle time of each launch are the Workspace's settings at that moment, and a snapshot is restored.
    const launch = new ContainerLaunch({
      settings: async () => (await this.#settings.read()).settings,
      snapshots,
      image: () => ctx.container?.images[WORKSPACE_CONTAINER],
      load: () => ctx.storage.get<LaunchRecord>(LAUNCH_KEY),
      save: (record) => ctx.storage.put(LAUNCH_KEY, record),
      running: () => ctx.container?.running === true,
      now: () => Date.now(),
      warn: (message) => console.warn(message),
    });

    this.#idle = new IdleStop({
      idleMs: () => launch.idleMs(),
      now: () => Date.now(),
      load: () => ctx.storage.get<number>(LAST_USE_KEY),
      save: (at) => ctx.storage.put(LAST_USE_KEY, at),
      setAlarm: (at) => ctx.storage.setAlarm(at),
      // The disk is snapshotted while the Container is idle, so the next launch restores the Toolchains. A command that
      // arrives meanwhile keeps the Container (`IdleStop`).
      snapshot: async () => {
        await launch.snapshot("idle");
      },
      stop: async () => {
        if (ctx.container?.running === true) await ctx.container.destroy();
      },
    });

    // The Container starts when a command first asks for it, not with the object.
    const container: ContainerBackendOptions = {
      // The launch goes through `launch`, which picks the instance type and the snapshot.
      container: () => ({ getWorkspaceContainer: () => launch.wrap(this.getWorkspaceContainer()) }),
      workspace: { binding: WORKSPACE_BINDING, id: ctx.id.toString() },
      name: WORKSPACE_CONTAINER,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      // Unrestricted direct egress in v1, not logged (docs/spec.md → Container and Toolchains).
      egress: { mode: "direct" },
    };

    // Dependency directories, build output and caches stay in the Container, out of the Workspace (docs/spec.md →
    // Container and Toolchains). mise's Toolchains are on the Container's disk and need no entry.
    if (env.CONTAINER_FUSE !== "false") container.ignore = TOOLCHAIN_IGNORE;

    this.#container = new ContainerBackend(container);

    // Before the first command of each Container start, the Toolchains are installed (the lockfile's); every command
    // gets the GitHub token and mise's settings, and the token is taken out of its output. The Workspace sees this as
    // the Container's backend.
    const toolchains = new ToolchainBackend({
      backend: this.#container,
      githubToken: env.CLOUDPID_GITHUB_TOKEN,
      // Once the Toolchains are installed in a Container that started from the image, its disk is snapshotted.
      afterInstall: () => launch.afterInstall(),
      git: { name: env.CLOUDPID_GIT_NAME, email: env.CLOUDPID_GIT_EMAIL },
      warn: (message) => console.warn(message),
      now: () => Date.now(),
    });

    this.#workspace = new ComputerWorkspace({
      storage: ctx.storage,
      // The bundled skills (`skills/`) ship in this Worker and appear read-only in every Workspace: a write under the
      // mount fails with EROFS, and a deploy that changes the files replaces the copy.
      mounts: { [SKILLS_MOUNT]: WorkerBundle(BUNDLED_SKILLS) },
      observer: this.#containerUseObserver(),
      // The Worker Shell's `git` runs on computer's git client. `bash` routes only a few read-only subcommands there
      // (`bash-routing.ts`): the Container's real git is the only one that writes `.git`.
      git: workerShellGit(),
      backends: [
        new WorkerShellBackend({
          loader: env.LOADER,
          workspace: { binding: WORKSPACE_BINDING, id: ctx.id.toString() },
          ctx,
          // `jq` is not in the shell's core commands.
          commands: [jq],
        }),
        toolchains,
      ],
    });

    this.#host = new WorkspaceEnvHost(this.#workspace);
    void ctx.blockConcurrencyWhile(() => this.#host.prepare(WORKSPACE_ROOT, Date.now()));
  }

  /**
   * Records each use of the Container for the idle stop: computer reports a span around every connect, push and pull on a
   * backend, and a command on the Container is a push before it and a pull after it.
   */
  #containerUseObserver(): WorkspaceObserver {
    const uses = (attributes: Parameters<WorkspaceObserver["span"]>[1]) =>
      attributes["workspace.sync.backend"] === CONTAINER_BACKEND_ID ||
      attributes["workspace.backend.id"] === CONTAINER_BACKEND_ID;

    const touch = () => {
      // A failed write only shortens the idle time: the alarm works from what was stored before.
      this.#idle.touch().catch((cause: unknown) => console.warn("idle stop: touch failed", cause));
    };

    return {
      span: (name, attributes, run) => {
        if (!uses(attributes)) return noopObserver.span(name, attributes, run);

        touch();

        return noopObserver.span(name, attributes, run).finally(touch);
      },
    };
  }

  /** The Workspace's own settings in force (Container size and idle time), for the UI: `getWorkspaceSettings`. */
  containerSettings(): Promise<WorkspaceSettingsAnswer> {
    return this.#settings.read();
  }

  /**
   * Replace the saved overrides of the Workspace's settings: `updateWorkspaceSettings`. Overrides that do not resolve
   * are refused and nothing is saved. A Container that runs keeps the settings it launched with.
   */
  updateContainerSettings(overrides: Schema.Json): Promise<WriteAnswer> {
    return this.#settings.write(overrides);
  }

  /** The idle stop's alarm. */
  alarm(): Promise<void> {
    return this.#idle.alarm();
  }

  /** The Container's egress: computerd dials back here, and `WorkspaceProxy` forwards its WebSocket upgrade. */
  override fetch(request: Request): Promise<Response> {
    return this.#container.handleFetch(request);
  }

  /** computer's Workspace RPC, for `getWorkspace()`: the caller disposes the stub. */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.#workspace.ready();

    return this.workspaceStub(this.#workspace);
  }

  /** One of `ComputerExecutionEnv`'s file operations, answered as plain data. */
  async fileOperation(request: EnvRequest): Promise<EnvResponse<HostOperation>> {
    // The bundled skills are copied into the files the first time the mounts are indexed, which `ready()` does once.
    await this.#workspace.ready();

    return this.#host.handle(request);
  }

  /** The RPC stub `__getWorkspaceStub()` hands out, its Container commands counted by the idle stop; tests count them too. */
  protected workspaceStub(workspace: ComputerWorkspace): WorkspaceStub {
    return new TrackedWorkspaceStub(workspace, this.#idle, CONTAINER_BACKEND_ID);
  }
}
