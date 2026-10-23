// The Workspace DO (docs/spec.md → Durable Objects, ADR-0001): one `@cloudflare/computer` Workspace per slug, its
// files in this object's SQLite storage, its commands on the Worker Shell or, for real binaries, in the Container the
// object schedules itself (ADR-0004; `durable_object` scheduling). It is a plain class rather than an alchemy
// Effect DO: computer reaches it through `__getWorkspaceStub()` with raw Workers RPC (its Worker Shell calls back into
// it through `WorkspaceServiceProxy`), which alchemy's Effect bridge would wrap in its own envelopes.
// @effect-diagnostics asyncFunction:off globalDate:off globalConsole:off cryptoRandomUUID:off preferEffectArray:off
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
import { type KeptSecret, type KeptVault, openKeptVault } from "@cloudpid/extensions/secrets/core";
import { redactText } from "./redact.ts";
import { TOOLCHAIN_IGNORE } from "@cloudpid/sandbox-image/toolchains";
import {
  type ComputerWorkspaceStub,
  type EnvRequest,
  type EnvResponse,
  type HostOperation,
  WorkspaceEnvHost,
} from "@cloudpid/computer-env";
import type { Skill } from "@cloudpid/extensions/skills-discovery";
import type { PromptTemplate } from "@cloudpid/extensions/prompt-templates";
import type { ContainerUsage } from "@cloudpid/protocol";
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { type WorkspaceSecrets, workspaceSecretsStore } from "./environment-secrets.ts";
import { BUNDLED_SKILLS } from "./bundled-skills.generated.ts";
import { type ExitReportProps, withExitReports } from "./exit-report.ts";
import { workerShellGit } from "./git.ts";
import { IdleStop } from "./idle.ts";
import { containerAnalytics, workspaceLabels } from "./container-analytics.ts";
import { ContainerUsageLedger, type ContainerUsageRecord } from "./container-usage.ts";
import { ContainerLaunch, containerIgnore, type LaunchRecord } from "./launch.ts";
import { PerLaunchContainerBackend } from "./per-launch-backend.ts";
import { WORKSPACE_DELETED_REASON } from "./lifecycle.ts";
import {
  failure,
  type PreparationHost,
  prepareWorkspace,
  preparationHost,
  type WorkspaceSetup,
} from "./prepare.ts";
import { carryWorkspaceScript } from "@cloudpid/sandbox-image/workspaces";
import {
  workspaceBuildStore,
  type WorkspaceSettingsAnswer,
  workspaceSettingsStore,
  type WriteAnswer,
} from "./settings.ts";

import type { BuildRequest, BuildState, EnvironmentBuild } from "./build-record.ts";
import { BuildRunner, type StoredBuilds } from "./build.ts";
import { discoverWorkspacePrompts, discoverWorkspaceSkills, keepPriorSkills } from "./skills.ts";
import { runAlarmSteps } from "./alarm.ts";
import { SparePreparation, type SpareRequest } from "./spare.ts";
import {
  ContainerSnapshots,
  SNAPSHOT_TIMEOUT_MS,
  type SnapshotRecord,
  scanContainerDisk,
} from "./snapshots.ts";
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
  /**
   * The master key the Environment's kept Secrets are sealed under in this object's storage (a deploy-time secret,
   * `SECRETS_ENCRYPTION_KEY`, as the Session DOs and the Registry have). Absent, they are held in memory only, and a
   * snapshot after an eviction is refused until a readying hands them again.
   */
  readonly SECRETS_ENCRYPTION_KEY?: string;
  /** The identity of the agent's commits where the Container has no other (`CLOUDPID_GIT_NAME`, `CLOUDPID_GIT_EMAIL`). */
  readonly CLOUDPID_GIT_NAME?: string;
  readonly CLOUDPID_GIT_EMAIL?: string;
  /**
   * `"false"` where the Container's `/workspace` is not a real FUSE mount, as under `alchemy dev`: computerd's
   * userspace shim refuses an ignore list and exits. Anything else applies `TOOLCHAIN_IGNORE` and the Workspace's own.
   */
  readonly CONTAINER_FUSE?: string;
  /**
   * An API token with Account Analytics Read (`CLOUDPID_ANALYTICS_TOKEN`) and the account it reads
   * (`CLOUDFLARE_ACCOUNT_ID`), for Cloudflare's usage analytics of the Containers. Either absent or empty, the
   * Containers' cost is estimated (`ContainerUsageLedger`).
   */
  readonly CLOUDPID_ANALYTICS_TOKEN?: string;
  readonly CLOUDFLARE_ACCOUNT_ID?: string;
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

/** Where what the Containers have cost is kept (`ContainerUsageLedger`). */
const USAGE_KEY = "cloudpid:container-usage";

/** Where a spare Workspace's preparation is kept until it is done (`SparePreparation`). */
const SPARE_KEY = "cloudpid:spare-preparation";

/** Kept once a Session used the Workspace, so it is never prepared, nor stopped, as a spare again (`SparePreparation`). */
const SPARE_USED_KEY = "cloudpid:spare-used";

/** Where a Build's object keeps its Builds (`BuildRunner`); only a Build's object has it. */
const BUILDS_KEY = "cloudpid:builds";

/** How long the command that starts a spare's Container, so its bootstrap runs, may take, in seconds. */
const SPARE_BOOTSTRAP_TIMEOUT_SECONDS = 20 * 60;

/** How long carrying the clones to a Fork's new Workspace may take, in seconds: a Container start, then pushes. */
const CARRY_TIMEOUT_SECONDS = 15 * 60;

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
  readonly #usage: ContainerUsageLedger;
  readonly #snapshots: ContainerSnapshots;
  readonly #settings: ReturnType<typeof workspaceSettingsStore>;
  /** The Environment's Build this Workspace was handed, which its first launch starts from. */
  readonly #environmentBuild: ReturnType<typeof workspaceBuildStore>;
  /** The Builds this object makes, when it is an Environment's Build object (`buildObjectName`). */
  readonly #builds: BuildRunner;
  readonly #spare: SparePreparation;
  /** The Environment's kept Secrets, as last handed over: sealed in storage, searched for before each snapshot. */
  readonly #environmentSecrets: WorkspaceSecrets;
  readonly #sql: SqlStorage;
  /** What the Workspace had at the skills' mount before it was mounted, dealt with once (`#ready`). */
  #mountChecked: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
    super(ctx, env);

    this.#settings = workspaceSettingsStore(ctx.storage);
    this.#environmentBuild = workspaceBuildStore(ctx.storage);
    this.#sql = ctx.storage.sql;

    let vault: Promise<KeptVault> | undefined;

    const environmentSecrets = (this.#environmentSecrets = workspaceSecretsStore({
      storage: ctx.storage,
      // Derived for the Workspaces, once, and bound to this object's id with each Secret's name.
      vault: () =>
        (vault ??= Effect.runPromise(
          openKeptVault(env.SECRETS_ENCRYPTION_KEY ?? "", "workspace"),
        ).catch((cause: unknown) => {
          vault = undefined;

          throw cause;
        })),
      owner: ctx.id.toString(),
    }));

    /** `text` with the GitHub token and the kept Secrets this instance holds taken out. */
    const redact = (text: string) =>
      redactText(text, env.CLOUDPID_GITHUB_TOKEN, environmentSecrets.known());

    const snapshots = (this.#snapshots = new ContainerSnapshots({
      // The local Container has no real mount, and no snapshots.
      enabled: env.CONTAINER_FUSE !== "false",
      secret: env.CLOUDPID_GITHUB_TOKEN,
      // The Environment's kept Secrets too: a Workspace that cannot show them takes no snapshot.
      secrets: () => environmentSecrets.read(),
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
      image: () => ctx.container?.images[WORKSPACE_CONTAINER],
      running: () => ctx.container?.running === true,
      snapshot: (name) => {
        if (ctx.container === undefined) return Promise.reject(new Error("no Container"));

        return ctx.container.snapshotContainer({ name });
      },
      scan: (patterns) => {
        if (ctx.container === undefined) return Promise.reject(new Error("no Container"));

        return scanContainerDisk(ctx.container, patterns, SCAN_TIMEOUT_MS);
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
      // With no snapshot of its own, a launch starts from the Environment's Build the Workspace was handed.
      builds: {
        current: () => this.#environmentBuild.current(),
        failed: (id) => this.#environmentBuild.failed(id),
      },
      image: () => ctx.container?.images[WORKSPACE_CONTAINER],
      load: () => ctx.storage.get<LaunchRecord>(LAUNCH_KEY),
      save: (record) => ctx.storage.put(LAUNCH_KEY, record),
      running: () => ctx.container?.running === true,
      now: () => Date.now(),
      warn: (message) => console.warn(message),
      info: (message) => console.info(message),
      // Cloudflare's usage analytics find the Workspace's Containers by this label.
      labels: workspaceLabels(ctx.id.toString()),
    });

    const analytics =
      env.CLOUDPID_ANALYTICS_TOKEN !== undefined &&
      env.CLOUDPID_ANALYTICS_TOKEN !== "" &&
      env.CLOUDFLARE_ACCOUNT_ID !== undefined &&
      env.CLOUDFLARE_ACCOUNT_ID !== ""
        ? containerAnalytics({
            token: env.CLOUDPID_ANALYTICS_TOKEN,
            accountId: env.CLOUDFLARE_ACCOUNT_ID,
          })
        : undefined;

    const usage = (this.#usage = new ContainerUsageLedger({
      load: () => ctx.storage.kv.get<ContainerUsageRecord>(USAGE_KEY),
      save: (record) => ctx.storage.kv.put(USAGE_KEY, record),
      running: () => ctx.container?.running === true,
      launch: async () => {
        const record = await ctx.storage.get<LaunchRecord>(LAUNCH_KEY);

        return record === undefined
          ? undefined
          : { instance: record.instance, launchedAt: record.launchedAt };
      },
      until: () => this.#idle.stopsBy(),
      analytics:
        analytics === undefined ? undefined : (windows) => analytics(ctx.id.toString(), windows),
      now: () => Date.now(),
      warn: (message) => console.warn(message),
    }));

    /** Note a use or a busy change of the Container in the ledger; a failure only makes the estimate rougher. */
    const tally = (note: Promise<void>) =>
      note.catch((cause: unknown) => console.warn("container usage: tracking failed", cause));

    /** Stop the Container, and end its run in the ledger. */
    const destroyContainer = async () => {
      if (ctx.container?.running === true) await ctx.container.destroy();

      await tally(usage.stopped());
    };

    this.#idle = new IdleStop({
      idleMs: () => launch.idleMs(),
      now: () => Date.now(),
      load: () => ctx.storage.get<number>(LAST_USE_KEY),
      save: (at) => ctx.storage.put(LAST_USE_KEY, at),
      // The one alarm is shared with the spare's preparation and a Build, which the idle stop does not put off.
      setAlarm: async (at) =>
        ctx.storage.setAlarm(await this.#builds.alarmAt(await this.#spare.alarmAt(at))),
      // The disk is snapshotted while the Container is idle, so the next launch restores the Toolchains. A command that
      // arrives meanwhile keeps the Container (`IdleStop`). A Build's object keeps no snapshot of its own: each Build
      // starts from the image.
      snapshot: async () => {
        if (!(await this.#builds.isBuild())) await launch.snapshot("idle");
      },
      stop: destroyContainer,
      used: () => void tally(usage.seen()),
      busy: (busy) => void tally(usage.busy(busy)),
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

    // Before the first command of each Container start, the Toolchains are installed (the lockfile's), the Environment's
    // and the repos' Setup Scripts that are due run, then their Start Scripts; every command gets the Environment's
    // variables, the GitHub token and mise's settings, and the token is taken out of its output. The Workspace sees this
    // as the Container's backend.
    const toolchains = new ToolchainBackend({
      backend: this.#container,
      githubToken: env.CLOUDPID_GITHUB_TOKEN,
      // Taken out of output as the token is, each as its Secret Reference.
      secrets: {
        read: async () => {
          const held = await environmentSecrets.read();

          return held.ok ? held.secrets : environmentSecrets.known();
        },
        known: () => environmentSecrets.known(),
      },
      // The variables and the Environment's scripts of each Container start are the Workspace's settings at its bootstrap.
      settings: async () => (await this.#settings.read()).settings,
      // Once the bootstrap has installed something (a Toolchain, a Setup Script's work) in a Container that started from
      // the image, its disk is snapshotted; not a Build's, whose snapshot is the Build.
      afterInstall: async (changed) => {
        if (!(await this.#builds.isBuild())) await launch.afterInstall(changed);
      },
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

    // A spare Workspace readies itself over its own Container, on the alarm (`prepareSpare`).
    this.#spare = new SparePreparation({
      load: () => ctx.storage.get<SpareRequest>(SPARE_KEY),
      save: (request) => ctx.storage.put(SPARE_KEY, request),
      clear: async () => {
        await ctx.storage.delete(SPARE_KEY);
      },
      used: () => ctx.storage.kv.get<boolean>(SPARE_USED_KEY) === true,
      markUsed: () => ctx.storage.kv.put(SPARE_USED_KEY, true),
      wake: async (at) => {
        const set = await ctx.storage.getAlarm();

        if (set === null || set > at) await ctx.storage.setAlarm(at);
      },
      prepare: (setup) => this.#prepareSpare(setup),
      idle: this.#idle,
      now: () => Date.now(),
      info: (message) => console.info(message),
      warn: (message) => console.warn(message),
    });

    // An Environment's Build object makes its Builds over its own Container, on the alarm (`startBuild`).
    this.#builds = new BuildRunner({
      // The local Container has no real mount, and no snapshots.
      enabled: env.CONTAINER_FUSE !== "false",
      load: () => ctx.storage.get<StoredBuilds>(BUILDS_KEY),
      save: (stored) => ctx.storage.put(BUILDS_KEY, stored),
      wake: async (at) => {
        const set = await ctx.storage.getAlarm();

        if (set === null || set > at) await ctx.storage.setAlarm(at);
      },
      image: () => ctx.container?.images[WORKSPACE_CONTAINER],
      handOver: async (overrides) => {
        const written = await this.#settings.write(overrides);

        if (!written.ok) throw new Error(`The Build refused the settings: ${written.message}`);
      },
      run: (script, timeoutSeconds, scriptEnv) =>
        this.#ownHost(`computer:build:${ctx.id.toString()}`).run(script, timeoutSeconds, scriptEnv),
      secrets: () => environmentSecrets.read(),
      snapshot: () => launch.captureBuild(),
      stop: destroyContainer,
      idle: this.#idle,
      redact,
      newId: () => crypto.randomUUID(),
      now: () => Date.now(),
      info: (message) => console.info(message),
      warn: (message) => console.warn(message),
    });

    this.#host = new WorkspaceEnvHost(this.#workspace);
    void ctx.blockConcurrencyWhile(() => this.#host.prepare(WORKSPACE_ROOT, Date.now()));
  }

  /**
   * Ready this Workspace with `setup` as a Session would (`prepareWorkspace`), over this object's own files and
   * Container, then run a command on the Container so its bootstrap (Toolchains, the Environment's Setup Script) has run
   * even for a Workspace of no Repos, whose readying starts no Container.
   */
  async #prepareSpare(setup: WorkspaceSetup): Promise<void> {
    const host = this.#ownHost(`computer:spare:${this.ctx.id.toString()}`);

    await prepareWorkspace(host, setup);

    const booted = await host.run(":", SPARE_BOOTSTRAP_TIMEOUT_SECONDS);

    if (booted.exitCode !== 0) throw new Error(`The Container did not start: ${booted.output}`);
  }

  /**
   * The `PreparationHost` of this object over itself, as environment `id`: a spare's preparation and a Build reach it
   * through a handle of their own, so their calls are not taken for a Session's (`SparePreparation.noteUse`).
   */
  #ownHost(id: string): PreparationHost {
    const own: ComputerWorkspaceStub = {
      fileOperation: (request) => this.#fileOperation(request),
      __getWorkspaceStub: () => this.#getWorkspaceStub(),
      skills: async () => [],
      prompts: async () => [],
    };

    return preparationHost(
      own,
      id,
      { read: () => this.#settings.read(), write: (overrides) => this.#settings.write(overrides) },
      {
        read: () => this.#environmentBuild.read(),
        write: (build) => this.#environmentBuild.write(build),
      },
      {
        write: (secrets) => this.#environmentSecrets.replace(secrets),
        unavailable: (reason) => this.#environmentSecrets.markUnavailable(reason),
        read: async () => {
          const held = await this.#environmentSecrets.read();

          return held.ok ? held.secrets : [];
        },
      },
      (message) => console.warn(message),
    );
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

  /**
   * The Container settings the Workspace holds (size, idle time, Container-only paths, variables, and Setup and Start
   * Scripts): its Environment's, as last handed over.
   */
  containerSettings(): Promise<WorkspaceSettingsAnswer> {
    this.#spare.noteUse();

    return this.#settings.read();
  }

  /**
   * Replace the saved overrides of the Workspace's Container settings with its Environment's, which a Session hands over
   * when it readies the Workspace (`prepare.ts`): this Worker cannot reach the Registry. Overrides that do not resolve
   * are refused and nothing is saved. A Container that runs keeps the settings it launched with.
   */
  updateContainerSettings(overrides: Schema.Json): Promise<WriteAnswer> {
    this.#spare.noteUse();

    return this.#settings.write(overrides);
  }

  /** The Environment's Build the Workspace holds, as last handed over (null: none), which its first launch starts from. */
  environmentBuild(): Promise<EnvironmentBuild | null> {
    this.#spare.noteUse();

    return this.#environmentBuild.read();
  }

  /**
   * Keep `build` as the Environment's Build (null: none), which a Session hands over when it readies the Workspace
   * (`prepare.ts`), with the settings: this Worker cannot reach the Registry.
   */
  updateEnvironmentBuild(build: EnvironmentBuild | null): Promise<void> {
    this.#spare.noteUse();

    return this.#environmentBuild.write(build);
  }

  /**
   * `text`, a report of this object's Container (`ContainerExitReports`), with the GitHub token and the Environment's
   * kept Secrets taken out; null when the copy of them does not open, so it cannot be shown free of them. Not a use of
   * the Workspace: a spare's preparation goes on.
   */
  async redactExitReport(text: string): Promise<string | null> {
    const held = await this.#environmentSecrets.read();

    return held.ok ? redactText(text, this.env.CLOUDPID_GITHUB_TOKEN, held.secrets) : null;
  }

  /**
   * Keep `secrets` as the Environment's kept Secrets (sealed), which a Session hands over when it readies the Workspace
   * (`prepare.ts`), with the settings: they are searched for before each snapshot and taken out of output.
   */
  updateEnvironmentSecrets(secrets: ReadonlyArray<KeptSecret>): Promise<void> {
    this.#spare.noteUse();

    return this.#environmentSecrets.replace(secrets);
  }

  /**
   * Keep a copy of the Environment's Secrets that cannot be shown, for `reason`: the Registry could not open them
   * (`WorkspaceSetup.secretsUnavailable`), so the snapshots and Builds that need them are refused until a handover
   * brings them.
   */
  environmentSecretsUnavailable(reason: string): Promise<void> {
    this.#spare.noteUse();

    return this.#environmentSecrets.markUnavailable(reason);
  }

  /**
   * Make this object's Environment's Build of `request` (docs/spec.md → Builds; the object is `buildObjectName`'s): it is
   * kept and begun at the alarm, so this answers at once, with the state then (`BuildRunner`). `secrets`, the
   * Environment's, are kept sealed apart from the request: those for the Build reach its Setup Scripts, and every one is
   * searched for before its snapshot.
   */
  async startBuild(
    request: BuildRequest,
    secrets: ReadonlyArray<KeptSecret> = [],
  ): Promise<BuildState> {
    await this.#environmentSecrets.replace(secrets);

    return this.#builds.request(request);
  }

  /** This Build object's last good Build, the one in progress or the last failure, and the image a launch would run now. */
  buildState(): Promise<BuildState> {
    return this.#builds.state();
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
   * Stop the Container and forget its snapshot (`LifecycleHost.restartContainer`), so the next command starts one from
   * the Environment's Build when there is a usable one, else from the image, bootstraps it and snapshots it. The files are the Workspace's and stay; what only the
   * Container's disk held is gone. Commands running in the Container end. The idle alarm finds no Container to stop.
   */
  async restartContainer(): Promise<void> {
    await this.stopContainer({ forgetSnapshot: true });
  }

  /**
   * Stop the Container if it runs, at once and without a snapshot of its own (the agent's `restart_container`, which
   * works when computerd no longer answers: the platform stops the Container). The next command starts a Container
   * from the snapshot the Workspace holds, as after an idle stop, with what its disk held when that was taken; with
   * `forgetSnapshot` it is forgotten first, as the owner's restart does (`restartContainer`). Commands running in the
   * Container end. Answers whether a Container was running.
   */
  async stopContainer(options: {
    readonly forgetSnapshot: boolean;
  }): Promise<{ readonly wasRunning: boolean }> {
    // Forgotten first, so a launch that slips in before the stop does not restore it.
    if (options.forgetSnapshot) await this.#snapshots.forget();

    const wasRunning = this.ctx.container?.running === true;

    if (wasRunning) await this.ctx.container?.destroy();

    await this.#usage.stopped().catch((cause: unknown) => {
      console.warn("container usage: tracking failed", cause);
    });

    return { wasRunning };
  }

  /**
   * What the Workspace's Containers have cost so far (`ContainerUsageLedger`), for a Session's header; null when none has
   * run. Not a use of the Workspace: it starts nothing, and a spare's preparation goes on.
   */
  async containerUsage(): Promise<ContainerUsage | null> {
    return (await this.#usage.read()) ?? null;
  }

  /**
   * Reset the object (`ctx.abort`) after `destroy` has answered, so the next call to this name opens an empty Workspace
   * instead of an instance over the wiped storage. The call always fails with `WORKSPACE_DELETED_REASON`, as an abort
   * fails the call that makes it. A reset from a timer in `destroy` raced the reply and failed the deletion.
   */
  reset(): void {
    this.ctx.abort(WORKSPACE_DELETED_REASON);
  }

  /**
   * Carry this Workspace's clones of `repos` to a new Workspace on `branch`, for a Fork or Clone made there
   * (`LifecycleHost.carry`): its Container pushes each one's HEAD as `branch`, with its uncommitted Changes beside it
   * (`carryWorkspaceScript`). Rejects with git's output when any could not be, with what was pushed taken back.
   */
  async carry(branch: string, repos: ReadonlyArray<string>): Promise<void> {
    this.#spare.noteUse();

    const ran = await this.#ownHost(`computer:carry:${this.ctx.id.toString()}`).run(
      carryWorkspaceScript(repos, branch),
      CARRY_TIMEOUT_SECONDS,
    );

    if (ran.exitCode !== 0) {
      throw failure(`The workspace's repos could not be carried to branch ${branch}`, ran);
    }
  }

  /**
   * Prepare this Workspace as its Environment's spare (docs/spec.md → Spare Workspace): `setup` is kept and the work
   * starts at the alarm, so this answers at once (`SparePreparation`).
   */
  async prepareSpare(setup: WorkspaceSetup): Promise<void> {
    // The Secrets are kept sealed, never with the set-up the preparation stores.
    const { secrets, secretsUnavailable, ...stored } = setup;

    if (secrets !== undefined) await this.#environmentSecrets.replace(secrets);
    else if (secretsUnavailable !== undefined) {
      await this.#environmentSecrets.markUnavailable(secretsUnavailable);
    }

    return this.#spare.request(stored);
  }

  /**
   * The alarm, shared: a spare's preparation or a Build that waits for it begins, then the idle stop checks on the
   * Container. Each step runs whatever the ones before it came to (`runAlarmSteps`).
   */
  async alarm(): Promise<void> {
    await runAlarmSteps(
      [
        ["spare", () => this.#spare.alarm()],
        ["build", () => this.#builds.alarm()],
        ["idle", () => this.#idle.alarm()],
      ],
      (message) => console.warn(message),
    );
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
    this.#spare.noteUse();
    await this.#ready();

    return discoverWorkspaceSkills(this.#host.readEnv(cwd), BUNDLED_SKILLS);
  }

  /**
   * The Prompt templates a conversation in `cwd` can use: the `.agents/prompts` of `cwd` and of each directory above it
   * up to the Workspace root, nearest first, walked next to the files as skills are.
   */
  async prompts(cwd: string): Promise<ReadonlyArray<PromptTemplate>> {
    this.#spare.noteUse();
    await this.#ready();

    return discoverWorkspacePrompts(this.#host.readEnv(cwd));
  }

  /** computer's Workspace RPC, for `getWorkspace()`: the caller disposes the stub. */
  __getWorkspaceStub(): Promise<WorkspaceStub> {
    this.#spare.noteUse();

    return this.#getWorkspaceStub();
  }

  async #getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.#ready();

    return this.workspaceStub(this.#workspace);
  }

  /** One of `ComputerExecutionEnv`'s file operations, answered as plain data. */
  fileOperation(request: EnvRequest): Promise<EnvResponse<HostOperation>> {
    this.#spare.noteUse();

    return this.#fileOperation(request);
  }

  async #fileOperation(request: EnvRequest): Promise<EnvResponse<HostOperation>> {
    // The bundled skills are copied into the files the first time the mounts are indexed, which `#ready()` does once.
    await this.#ready();

    return this.#host.handle(request);
  }

  /** The RPC stub `__getWorkspaceStub()` hands out, its Container commands counted by the idle stop; tests count them too. */
  protected workspaceStub(workspace: ComputerWorkspace): WorkspaceStub {
    return new TrackedWorkspaceStub(workspace, this.#idle, CONTAINER_BACKEND_ID);
  }
}
