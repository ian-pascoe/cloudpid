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
import { EXIT_REPORT_HOST } from "@cloudpid/sandbox-image/supervisor";
import { TOOLCHAIN_IGNORE } from "@cloudpid/sandbox-image/toolchains";
import {
  type EnvRequest,
  type EnvResponse,
  type HostOperation,
  WorkspaceEnvHost,
} from "@cloudpid/computer-env";
import type { Skill } from "@cloudpid/extensions/skills-discovery";
import type { PromptTemplate } from "@cloudpid/extensions/prompt-templates";
import { DurableObject } from "cloudflare:workers";
import type * as Schema from "effect/Schema";
import { BUNDLED_SKILLS } from "./bundled-skills.generated.ts";
import { type ExitReportProps, withExitReports } from "./exit-report.ts";
import { workerShellGit } from "./git.ts";
import { IdleStop } from "./idle.ts";
import { ContainerLaunch, containerIgnore, type LaunchRecord } from "./launch.ts";
import { PerLaunchContainerBackend } from "./per-launch-backend.ts";
import { WORKSPACE_DELETED_REASON } from "./lifecycle.ts";
import {
  type WorkspaceSettingsAnswer,
  workspaceSettingsStore,
  type WriteAnswer,
} from "./settings.ts";
import { discoverWorkspacePrompts, discoverWorkspaceSkills, keepPriorSkills } from "./skills.ts";
import { ContainerEarlyStart } from "./early-start.ts";
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
   * userspace shim refuses an ignore list and exits. Anything else applies `TOOLCHAIN_IGNORE` and the Workspace's own.
   */
  readonly CONTAINER_FUSE?: string;
};

/** The loopback bindings of the Workspaces Worker's entry (`worker.ts`) that the Workspace DO hands the platform. */
type WorkspaceExports = {
  readonly ContainerExitReports: (options: { readonly props: ExitReportProps }) => Fetcher;
};

/** A Durable Object that can start the Container it is bound to (`getWorkspaceContainer()`, for `ContainerBackend`). */
const ContainerHost = withWorkspaceContainer(class extends DurableObject<WorkspaceEnv> {});

/** Where the last use of the Container is kept, for an alarm that wakes an evicted object. */
const LAST_USE_KEY = "cloudpid:container-last-use";

/** Where the Container's launch (its instance type, idle time, paths, snapshot) and its latest snapshot are kept. */
const LAUNCH_KEY = "cloudpid:container-launch";
const SNAPSHOT_KEY = "cloudpid:container-snapshot";

/** How long a snapshot, its scan included, may take before it is given up on: the same for the install's and the idle stop's. */
const SNAPSHOT_TIMEOUT_MS = { install: 2 * 60_000, idle: 2 * 60_000 } as const;

/**
 * How long the Container's first commands wait for the install snapshot. One that takes longer goes on in the
 * background (up to `SNAPSHOT_TIMEOUT_MS`) and the commands run (#156: the snapshot after this repo's install takes
 * 45–64 s).
 */
const INSTALL_HOLD_MS = 60_000;

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
  readonly #container: PerLaunchContainerBackend;
  readonly #idle: IdleStop;
  readonly #snapshots: ContainerSnapshots;
  readonly #settings: ReturnType<typeof workspaceSettingsStore>;
  readonly #earlyStart: ContainerEarlyStart;
  readonly #sql: SqlStorage;
  /** What the Workspace had at the skills' mount before it was mounted, dealt with once (`#ready`). */
  #mountChecked: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
    super(ctx, env);

    this.#settings = workspaceSettingsStore(ctx.storage);
    this.#sql = ctx.storage.sql;

    const snapshots = (this.#snapshots = new ContainerSnapshots({
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
    }));

    // The size, idle time and Container-only paths of each launch are the Workspace's settings at that moment, and a
    // snapshot is restored.
    const launch = new ContainerLaunch({
      settings: async () => (await this.#settings.read()).settings,
      // Dependency directories, build output and caches stay in the Container, out of the Workspace (docs/spec.md →
      // Container and Toolchains): the built-in paths, then the Workspace's own, so its `!` patterns can take one back.
      // mise's Toolchains are on the Container's disk and need no entry. The local Container cannot keep any.
      ignore: (settings) =>
        env.CONTAINER_FUSE === "false"
          ? undefined
          : containerIgnore(TOOLCHAIN_IGNORE, settings.ignore),
      snapshots,
      image: () => ctx.container?.images[WORKSPACE_CONTAINER],
      load: () => ctx.storage.get<LaunchRecord>(LAUNCH_KEY),
      save: (record) => ctx.storage.put(LAUNCH_KEY, record),
      holdMs: INSTALL_HOLD_MS,
      running: () => ctx.container?.running === true,
      now: () => Date.now(),
      warn: (message) => console.warn(message),
      info: (message) => console.info(message),
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
      // The launch goes through `launch`, which picks the instance type and the snapshot, and each Container started can
      // report why it stopped (`withExitReports`).
      container: () => ({
        getWorkspaceContainer: () =>
          withExitReports(
            launch.wrap(this.getWorkspaceContainer()),
            () => this.#interceptExitReports(),
            (message) => console.warn(message),
          ),
      }),
      workspace: { binding: WORKSPACE_BINDING, id: ctx.id.toString() },
      name: WORKSPACE_CONTAINER,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      // Unrestricted direct egress in v1, not logged (docs/spec.md → Container and Toolchains).
      egress: { mode: "direct" },
    };

    // computer takes the Container-only paths when its backend is built, so one is built for each launch's paths.
    this.#container = new PerLaunchContainerBackend({
      build: (ignore) =>
        new ContainerBackend(ignore === undefined ? container : { ...container, ignore }),
      ignore: () => launch.ignore(),
    });

    // Before the first command of each Container start, the Toolchains are installed (the lockfile's) and the repos'
    // Setup Scripts that are due run; every command gets the GitHub token and mise's settings, and the token is taken out
    // of its output. The Workspace sees this as the Container's backend.
    const toolchains = new ToolchainBackend({
      backend: this.#container,
      githubToken: env.CLOUDPID_GITHUB_TOKEN,
      // Once the bootstrap has installed something (a Toolchain, a Setup Script's work) in a Container that started from
      // the image, its disk is snapshotted.
      afterInstall: (changed) => launch.afterInstall(changed),
      // A bootstrap (its Setup Scripts can take a quarter of an hour) keeps the Container from its idle stop.
      activity: this.#idle,
      // Under `alchemy dev` the Container's `/workspace` is no real mount (`CONTAINER_FUSE=false`): it cannot be locked.
      readOnlyDirectories: env.CONTAINER_FUSE === "false" ? [] : [SKILLS_MOUNT],
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

    // A message the owner sends starts the Container before its first command asks for it (`startContainerEarly`).
    this.#earlyStart = new ContainerEarlyStart({
      running: () => ctx.container?.running === true,
      connect: async () => {
        await this.#ready();
        await this.#workspace.ready(CONTAINER_BACKEND_ID);

        let pushed = 0;

        for await (const block of this.#workspace.push(CONTAINER_BACKEND_ID))
          pushed += block.entries;

        return pushed;
      },
      runBootstrap: () => toolchains.runBootstrap(),
      idle: this.#idle,
      now: () => Date.now(),
      info: (message) => console.info(message),
      warn: (message) => console.warn(message),
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

  /** Routes the report host of the Container that runs now to `ContainerExitReports`, which logs what it is sent. */
  async #interceptExitReports(): Promise<void> {
    const container = this.ctx.container;

    if (container === undefined) return;

    // SAFETY: the Workspaces Worker's entry (`worker.ts`) exports `ContainerExitReports`; `ctx.exports` is untyped here.
    const exports = this.ctx.exports as WorkspaceExports;

    await container.interceptOutboundHttp(
      EXIT_REPORT_HOST,
      exports.ContainerExitReports({ props: { workspace: this.ctx.id.toString() } }),
    );
  }

  /** The Workspace's own settings in force (Container size, idle time and Container-only paths), for the UI: `getWorkspaceSettings`. */
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

  /**
   * Delete the Workspace's own state (`LifecycleHost`): stop its Container, then wipe the storage (files, settings, the
   * snapshot and launch records) and the alarm. The disk snapshot itself expires on Cloudflare's side; there is no API to
   * delete it. The instance is not reset here: the caller resets it with `reset` once this call has answered.
   */
  async destroy(): Promise<void> {
    if (this.ctx.container?.running === true) await this.ctx.container.destroy();

    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /**
   * Reset the Workspace to a fresh start (`LifecycleHost.clear`, for `resetWorkspace`): as `destroy`, but its own
   * settings (Container size, idle time and Container-only paths) are put back after the wipe. The caller resets the instance with `reset`.
   */
  async clear(): Promise<void> {
    const settings = await this.#settings.saved();

    await this.destroy();
    await this.#settings.restore(settings);
  }

  /**
   * Stop the Container and forget its snapshot (`LifecycleHost.restartContainer`), so the next command starts one from
   * the image, installs the Toolchains again and snapshots it. The files are the Workspace's and stay; what only the
   * Container's disk held is gone. Commands running in the Container end. The idle alarm finds no Container to stop.
   */
  async restartContainer(): Promise<void> {
    // Forgotten first, so a launch that slips in before the stop does not restore it.
    await this.#snapshots.forget();

    if (this.ctx.container?.running === true) await this.ctx.container.destroy();
  }

  /**
   * Reset the object (`ctx.abort`) after `destroy` or `clear` has answered, so the next call to this slug opens an empty Workspace
   * instead of an instance over the wiped storage. The call always fails with `WORKSPACE_DELETED_REASON`, as an abort
   * fails the call that makes it. A reset from a timer in `destroy` raced the reply and failed the deletion.
   */
  reset(): void {
    this.ctx.abort(WORKSPACE_DELETED_REASON);
  }

  /**
   * The early start (docs/spec.md → Backends), for a message the owner sent: restore or launch the Container, push the
   * files and run the bootstrap, with no command, so the turn's first command does not wait for it. It answers at once
   * and never fails. While the Container runs or is starting it starts nothing; either way the message is a use of the
   * Container for the idle stop.
   */
  startContainerEarly(): void {
    // Not awaited: the start goes on after this call has answered. Nothing needs to hold the object for it
    // (`ctx.waitUntil` has no effect in a Durable Object): one is evicted only after tens of seconds without a request,
    // and once computer has connected, its connection to computerd keeps the object in memory, as for a command.
    void this.#earlyStart.start();
  }

  /** The idle stop's alarm. */
  alarm(): Promise<void> {
    return this.#idle.alarm();
  }

  /** The Container's egress: computerd dials back here, and `WorkspaceProxy` forwards its WebSocket upgrade. */
  override fetch(request: Request): Promise<Response> {
    return this.#container.handleFetch(request);
  }

  /**
   * The Workspace is ready once computer has indexed its mounts, which copies the bundled skills into the files the first
   * time. A mount replaces what is at its path, so what the Workspace had at the skills' mount before is moved aside
   * first (`keepPriorSkills`).
   */
  async #ready(): Promise<void> {
    this.#mountChecked ??= keepPriorSkills({
      fs: this.#workspace.fs,
      // computer records a mount in its own table when it first indexes it, and never forgets it.
      indexed: () => this.#mountIndexed(),
      warn: (message) => console.warn(message),
    }).then(
      () => undefined,
      (cause: unknown) => {
        // Checked again by the next call: nothing is indexed over files that could not be moved.
        this.#mountChecked = undefined;

        throw cause;
      },
    );

    await this.#mountChecked;
    await this.#workspace.ready();
  }

  /**
   * Whether computer has indexed the skills' mount, which it records in its own table. If that table cannot be read (a
   * computer upgrade changed it), the mount is taken for indexed: files are left to computer, as before this check,
   * rather than every call failing.
   */
  #mountIndexed(): boolean {
    try {
      return (
        this.#sql.exec("SELECT 1 FROM _vfs_mounts WHERE root = ?", SKILLS_MOUNT).toArray().length >
        0
      );
    } catch (cause) {
      console.warn(
        "Cannot tell whether the skills mount was indexed; leaving its files to computer",
        cause,
      );

      return true;
    }
  }

  /**
   * The skills a conversation in `cwd` can use: the `skills` section's discovery, run next to the files, so a request
   * costs this one call instead of a listing per directory and a read per skill. The bundled skills are known from the
   * bundle and parsed once per version, and only the repo's own are read.
   */
  async skills(cwd: string): Promise<ReadonlyArray<Skill>> {
    await this.#ready();

    return discoverWorkspaceSkills(this.#host.readEnv(cwd), BUNDLED_SKILLS);
  }

  /**
   * The Prompt templates a conversation in `cwd` can use: the `.agents/prompts` of `cwd` and of each directory above it
   * up to the Workspace root, nearest first, walked next to the files as skills are.
   */
  async prompts(cwd: string): Promise<ReadonlyArray<PromptTemplate>> {
    await this.#ready();

    return discoverWorkspacePrompts(this.#host.readEnv(cwd));
  }

  /** computer's Workspace RPC, for `getWorkspace()`: the caller disposes the stub. */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.#ready();

    return this.workspaceStub(this.#workspace);
  }

  /** One of `ComputerExecutionEnv`'s file operations, answered as plain data. */
  async fileOperation(request: EnvRequest): Promise<EnvResponse<HostOperation>> {
    // The bundled skills are copied into the files the first time the mounts are indexed, which `#ready()` does once.
    await this.#ready();

    return this.#host.handle(request);
  }

  /** The RPC stub `__getWorkspaceStub()` hands out, its Container commands counted by the idle stop; tests count them too. */
  protected workspaceStub(workspace: ComputerWorkspace): WorkspaceStub {
    return new TrackedWorkspaceStub(workspace, this.#idle, CONTAINER_BACKEND_ID);
  }
}
