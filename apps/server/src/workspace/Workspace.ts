// The Workspace DO (docs/architecture/overview.md → Durable Objects, ADR-0001): one `@cloudflare/computer` Workspace per slug, its
// files in this object's SQLite storage, its commands on the Worker Shell or, for real binaries, in the Container the
// object schedules itself (ADR-0004; `durable_object` scheduling). It is a plain class rather than an alchemy
// Effect DO: computer reaches it through `__getWorkspaceStub()` with raw Workers RPC (its Worker Shell calls back into
// it through `WorkspaceServiceProxy`), which alchemy's Effect bridge would wrap in its own envelopes.
// @effect-diagnostics asyncFunction:off globalDate:off globalConsole:off cryptoRandomUUID:off preferEffectArray:off globalFetch:off
import {
  type MountWriteAPI,
  noopObserver,
  Workspace as ComputerWorkspace,
  type WorkspaceObserver,
  type WorkspaceStub,
} from "@cloudflare/computer";
import {
  ContainerBackend,
  type ContainerBackendOptions,
  type IWorkspaceContainerAPI,
  withWorkspaceContainer,
} from "@cloudflare/computer/backends/container";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import jq from "@cloudflare/computer/shell/jq";
import { EXIT_REPORT_HOST } from "@cloudpid/sandbox-image/supervisor";
import { type KeptSecret, type KeptVault, openKeptVault } from "@cloudpid/extensions/secrets/core";
import { GitHubApp, type MintedToken } from "../github/app.ts";
import { redactText } from "./redact.ts";
import { TOOLCHAIN_IGNORE } from "@cloudpid/sandbox-image/toolchains";
import {
  ComputerExecutionEnv,
  type ComputerWorkspaceStub,
  type ContainerScriptRun,
  type EnvRequest,
  type EnvResponse,
  type HostOperation,
  isContainerOnly,
  withHarnessKept,
  WorkspaceEnvHost,
} from "@cloudpid/computer-env";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Skill } from "@cloudpid/extensions/skills-discovery";
import type { PromptTemplate } from "@cloudpid/extensions/prompt-templates";
import type { InstructionFile } from "@cloudpid/extensions/agents-md-discovery";
import type {
  ChangeFile,
  CompareResult,
  ComparisonSources,
  ContainerUsage,
  LastRun,
  RunDiff,
  WorkspaceChanges,
} from "@cloudpid/protocol";
import { currentInstanceName, type InstanceType, type StoredInstanceType } from "@cloudpid/config";
import type { ContainerResizeOutcome } from "@cloudpid/extensions/container";
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { type WorkspaceSecrets, workspaceSecretsStore } from "./environment-secrets.ts";
import type { SkillSet } from "./skill-set-schema.ts";
import {
  checkSkillSet,
  type SkillSetAnswer,
  skillSetMount,
  skillSetStore,
  writeSkillSet,
} from "./skill-set.ts";
import { type ExitReportProps, withExitReports } from "./exit-report.ts";
import { workerShellGit } from "./git.ts";
import {
  type ChangeFileRequest,
  type ChangesRequest,
  type ContainerOnly,
  type KeptChanges,
  WorkspaceChangesModule,
} from "./changes.ts";
import {
  type CompareRequest,
  type ComparisonFileRequest,
  WorkspaceComparisonModule,
} from "./comparison.ts";
import {
  type RunEndRequest,
  type RunFileRequest,
  type RunStartRequest,
  WorkspaceRunsModule,
} from "./runs.ts";
import { WorkspaceWorkStateModule } from "./work-state.ts";
import { type HeldStop, heldStopMinutes, IdleStop } from "./idle.ts";
import { containerAnalytics, workspaceLabels } from "./container-analytics.ts";
import { ContainerUsageLedger, type StoredUsageRecord } from "./container-usage.ts";
import {
  ContainerLaunch,
  containerIgnore,
  currentLaunchRecord,
  type StoredLaunchRecord,
} from "./launch.ts";
import { PerLaunchContainerBackend } from "./per-launch-backend.ts";
import {
  CONTAINER_PREVIEW_KEEP_ALIVE_MS,
  ContainerPreview,
  type ContainerPreviewActivity,
} from "./container-preview.ts";
import { ContainerResizes } from "./resize.ts";
import { WORKSPACE_DELETED_REASON } from "./lifecycle.ts";
import {
  failure,
  type PreparationHost,
  prepareWorkspace,
  preparationHost,
  type WorkspaceSetup,
} from "./prepare.ts";
import { carryWorkspaceScript, type RepoWorkState } from "@cloudpid/sandbox-image/workspaces";
import {
  workspaceBuildStore,
  type WorkspaceSettingsAnswer,
  workspaceSettingsStore,
  type WriteAnswer,
} from "./settings.ts";

import type { BuildRequest, BuildState, EnvironmentBuild } from "./build-record.ts";
import { BuildRunner, type StoredBuilds } from "./build.ts";
import { remoteHeads } from "./remote-heads.ts";
import {
  discoverWorkspaceInstructions,
  discoverWorkspacePrompts,
  discoverWorkspaceSkills,
  keepPriorSkills,
} from "./skills.ts";
import { runAlarmSteps } from "./alarm.ts";
import { SparePreparation, type SpareRequest } from "./spare.ts";
import {
  ContainerSnapshots,
  SNAPSHOT_TIMEOUT_MS,
  type SnapshotRecord,
  scanContainerDisk,
} from "./snapshots.ts";
import { ToolchainBackend } from "./toolchains.ts";
import { changeLog } from "./change-log.ts";
import { FileNotifier, inSignalPush, runNotify, withNoSignalStart } from "./notify.ts";
import { TrackedWorkspaceStub } from "./tracked.ts";
import { SKILLS_MOUNT, WORKSPACE_CONTAINER, WORKSPACE_BINDING, WORKSPACE_ROOT } from "./binding.ts";

export type WorkspaceEnv = {
  /** The Worker Loader the Worker Shell runs in. */
  readonly LOADER: WorkerLoader;
  /**
   * The GitHub App (deploy-time secrets, ADR-0025): its ID and private key, which this object mints the GitHub tokens
   * from that commands on the Container get as `GH_TOKEN` and `GITHUB_TOKEN` and its GitHub calls are made with. Either
   * absent or empty, commands and calls go without one.
   */
  readonly CLOUDPID_GITHUB_APP_ID?: string;
  readonly CLOUDPID_GITHUB_APP_PRIVATE_KEY?: string;
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

/** Where the last owner or agent activity in the Workspace is kept, which the hold cap counts from (`IdleStop.noteActivity`). */
const LAST_ACTIVITY_KEY = "cloudpid:container-last-activity";

/** Where the Workspace's latest held stops are kept, for its Sessions' notices (`containerHeldStops`). */
const HELD_STOPS_KEY = "cloudpid:container-held-stops";

/** How many held stops are kept: a Session that has missed more shows the latest. */
const HELD_STOPS_KEPT = 10;

/** The file operations that write: a model tool's write is activity in the Workspace (`IdleStop.noteActivity`). */
const WRITE_OPERATIONS: ReadonlySet<EnvRequest["op"]> = new Set([
  "writeFile",
  "truncate",
  "rename",
  "createDir",
  "remove",
  "createTempDir",
]);

/** Where the Container's launch (its instance type, idle time, paths, snapshot) and its latest snapshot are kept. */
const LAUNCH_KEY = "cloudpid:container-launch";
const SNAPSHOT_KEY = "cloudpid:container-snapshot";

/** Where the size the agent's resize recorded for the next launch is kept, until the idle stop (`ContainerResizes`). */
const RESIZE_KEY = "cloudpid:container-resize";

/** Where what the Containers have cost is kept (`ContainerUsageLedger`). */
const USAGE_KEY = "cloudpid:container-usage";

/** Where a spare Workspace's preparation is kept until it is done (`SparePreparation`). */
const SPARE_KEY = "cloudpid:spare-preparation";

/** Kept once a Session used the Workspace, so it is never prepared, nor stopped, as a spare again (`SparePreparation`). */
const SPARE_USED_KEY = "cloudpid:spare-used";

/** Where each repo's last list from the Container's git is kept (`WorkspaceChangesModule`), under `<key>:<repo>`. */
const CHANGES_KEY = "cloudpid:changes";

/** Where a Build's object keeps its Builds (`BuildRunner`); only a Build's object has it. */
const BUILDS_KEY = "cloudpid:builds";

/** Where the GitHub tokens this object minted are kept until they expire (`GitHubApp`), so an eviction forgets none. */
const GITHUB_TOKENS_KEY = "cloudpid:github-tokens";

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

/**
 * How long one of the file tools' scripts may run on the Container: a copy or a search, after the Container's start and
 * bootstrap, which do not count.
 */
const CONTAINER_FILES_TIMEOUT_SECONDS = 300;

/** The id the Container's backend has in the Workspace (`@cloudflare/computer`'s default). */
export const CONTAINER_BACKEND_ID = "container-shell";

export class Workspace extends ContainerHost {
  readonly #workspace: ComputerWorkspace;
  readonly #host: WorkspaceEnvHost;
  readonly #container: PerLaunchContainerBackend;
  readonly #idle: IdleStop;
  readonly #resizes: ContainerResizes;
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
  /** The GitHub App the GitHub tokens are minted from; none where the deploy bound none. */
  readonly #github: GitHubApp | undefined;
  readonly #sql: SqlStorage;
  /** The Changes of the Workspace's repos (`changes`, `changeFile`). */
  readonly #changes: WorkspaceChangesModule;
  /** This branch of the Workspace's repos (`comparisonSources`, `compare`, `comparisonFile`). */
  readonly #comparison: WorkspaceComparisonModule;
  /** The Run copies of the Workspace's repos and the Run diff (`runStart`, `runEnd`, `runDiff`, `runFile`). */
  readonly #runs: WorkspaceRunsModule;
  /** What the Workspace's clones have not pushed (`workState`). */
  readonly #workState: WorkspaceWorkStateModule;
  /** The Container previews: the Session's browser's requests for the Container's ports (`containerPreview`). */
  readonly #containerPreview: ContainerPreview;
  /** What the Workspace had at the skills' mount before it was mounted, dealt with once (`#ready`). */
  #mountChecked: Promise<void> | undefined;
  /** The Skill set the mount at `SKILLS_MOUNT` serves: empty until one is handed over (`updateSkills`). */
  readonly #skills: ReturnType<typeof skillSetStore>;
  /** Sends the running Container the Workspace's writes promptly, and gives the file-change signal for them (`notify.ts`). */
  readonly #notifier: FileNotifier;

  constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
    super(ctx, env);

    this.#settings = workspaceSettingsStore(ctx.storage);
    this.#environmentBuild = workspaceBuildStore(ctx.storage);
    this.#sql = ctx.storage.sql;

    const skills = (this.#skills = skillSetStore({
      kv: ctx.storage.kv,
      transactionSync: (closure) => ctx.storage.transactionSync(closure),
    }));

    let opened: Promise<KeptVault> | undefined;

    // Derived for the Workspaces, once.
    const vault = () =>
      (opened ??= Effect.runPromise(
        openKeptVault(env.SECRETS_ENCRYPTION_KEY ?? "", "workspace"),
      ).catch((cause: unknown) => {
        opened = undefined;

        throw cause;
      }));

    const environmentSecrets = (this.#environmentSecrets = workspaceSecretsStore({
      storage: ctx.storage,
      // Each value bound to this object's id with its Secret's name.
      vault,
      owner: ctx.id.toString(),
    }));

    // The GitHub tokens: minted for this object as it needs them, each handed out until less than 45 minutes are left,
    // and kept in storage until it expires, since the Container (and a command holding one) can outlive this instance.
    const github = (this.#github =
      env.CLOUDPID_GITHUB_APP_ID === undefined ||
      env.CLOUDPID_GITHUB_APP_ID === "" ||
      env.CLOUDPID_GITHUB_APP_PRIVATE_KEY === undefined ||
      env.CLOUDPID_GITHUB_APP_PRIVATE_KEY === ""
        ? undefined
        : new GitHubApp({
            appId: env.CLOUDPID_GITHUB_APP_ID,
            privateKey: env.CLOUDPID_GITHUB_APP_PRIVATE_KEY,
            fetch: (url, init) => this.githubFetch(url, init),
            now: () => this.clock(),
            kept: {
              load: () => ctx.storage.kv.get<ReadonlyArray<MintedToken>>(GITHUB_TOKENS_KEY),
              save: (minted) => ctx.storage.kv.put(GITHUB_TOKENS_KEY, minted),
            },
          }));

    /** The GitHub tokens this object minted that have not expired. */
    const githubTokens = () => github?.live() ?? [];

    /** `text` with the GitHub tokens and the kept Secrets this instance holds taken out. */
    const redact = (text: string) => redactText(text, githubTokens(), environmentSecrets.known());

    const snapshots = (this.#snapshots = new ContainerSnapshots({
      // The local Container has no real mount, and no snapshots.
      enabled: env.CONTAINER_FUSE !== "false",
      tokens: () => github?.liveMinted() ?? [],
      // The Environment's kept Secrets too: a Workspace that cannot show them takes no snapshot.
      secrets: () => environmentSecrets.read(),
      // What a snapshot's scan searched for, under the Workspaces' key (never a value in the clear).
      fingerprint: async (text) => Effect.runPromise((await vault()).digest(text)),
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
      image: () => ctx.container?.images[WORKSPACE_CONTAINER],
      running: () => ctx.container?.running === true,
      snapshot: (name) => {
        if (ctx.container === undefined) return Promise.reject(new Error("no Container"));

        return ctx.container.snapshotContainer({ name });
      },
      scan: (groups, { sinceStart }) => {
        if (ctx.container === undefined) return Promise.reject(new Error("no Container"));

        return scanContainerDisk(ctx.container, groups, { sinceStart, timeoutMs: SCAN_TIMEOUT_MS });
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

    // A launch record or a resize kept before the sizes were renamed names an old one: each is read as its new name.
    const launchRecord = async () =>
      currentLaunchRecord(await ctx.storage.get<StoredLaunchRecord>(LAUNCH_KEY));

    // The size, idle time and Container-only paths of each launch are the Workspace's settings at that moment (the size
    // the agent's resize recorded instead of theirs), and a snapshot is restored.
    const launch = new ContainerLaunch({
      settings: async () => (await this.#settings.read()).settings,
      resized: () => this.#resizes.recorded(),
      // Dependency directories, build output and caches stay in the Container, out of the Workspace (docs/architecture/container.md):
      // the built-in paths, then the Workspace's own, so its `!` patterns can take one back.
      // mise's Toolchains are on the Container's disk and need no entry. The local Container cannot keep any.
      // The harness's own directory (`/workspace/.cloudpid`: temp files, spills, Attachments) is taken back last, so
      // nothing the Environment adds makes it local (ADR-0018).
      ignore: (settings) =>
        env.CONTAINER_FUSE === "false"
          ? undefined
          : withHarnessKept(containerIgnore(TOOLCHAIN_IGNORE, settings.ignore)),
      snapshots,
      // With no snapshot of its own, a launch starts from the Environment's Build the Workspace was handed.
      builds: {
        current: () => this.#environmentBuild.current(),
        failed: (id) => this.#environmentBuild.failed(id),
      },
      image: () => ctx.container?.images[WORKSPACE_CONTAINER],
      load: launchRecord,
      save: (record) => ctx.storage.put(LAUNCH_KEY, record),
      running: () => ctx.container?.running === true,
      // A command that launches a Container holds it as it may write, before the launch is recorded.
      writing: () => this.#idle.writing(),
      now: () => Date.now(),
      warn: (message) => console.warn(message),
      info: (message) => console.info(message),
      // Cloudflare's usage analytics find the Workspace's Containers by this label.
      labels: workspaceLabels(ctx.id.toString()),
    });

    // Which absolute paths are Container-only for the launch that runs now, or the next one (ADR-0018).
    const containerOnly = async (): Promise<ContainerOnly> => {
      const ignore = await launch.ignore();
      const patterns = ignore === undefined ? undefined : withHarnessKept(ignore);

      return (path) => isContainerOnly(path, patterns);
    };

    // The Skill set's mount is read-only on the Container. Under `alchemy dev` its `/workspace` is no real mount
    // (`CONTAINER_FUSE=false`): nothing can be locked there.
    const readOnly = env.CONTAINER_FUSE === "false" ? [] : [SKILLS_MOUNT];

    // While the Container runs, the Workspace's writes are pushed to it soon after they are made and the file-change
    // signal given for them (docs/architecture/container.md → File-change signals); never on a stopped one.
    this.#notifier = new FileNotifier({
      running: () => this.containerRunning(),
      log: changeLog(ctx.storage.sql, CONTAINER_BACKEND_ID),
      push: () => this.pushContainerChanges(),
      notify: (paths) => this.signalContainer(paths),
      containerOnly,
      readOnly,
      holdsBegun: () => this.#idle.holdsBegun(),
      warn: (message) => console.warn(message),
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
      load: () => ctx.storage.kv.get<StoredUsageRecord>(USAGE_KEY),
      save: (record) => ctx.storage.kv.put(USAGE_KEY, record),
      running: () => ctx.container?.running === true,
      launch: async () => {
        const record = await launchRecord();

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

    // The agent's resize snapshots and stops the Container as the idle stop does, and the idle stop forgets its size.
    const resizes = (this.#resizes = new ContainerResizes({
      settings: async () => (await this.#settings.read()).settings,
      running: () => ctx.container?.running === true,
      launched: async () => (await launchRecord())?.instance,
      load: async () => {
        const size = await ctx.storage.get<StoredInstanceType>(RESIZE_KEY);

        return size === undefined ? undefined : currentInstanceName(size);
      },
      save: (size) => ctx.storage.put(RESIZE_KEY, size),
      clear: async () => {
        await ctx.storage.delete(RESIZE_KEY);
      },
      snapshot: () => launch.snapshot("resize"),
      stop: destroyContainer,
      info: (message) => console.info(message),
    }));

    this.#idle = new IdleStop({
      idleMs: () => launch.idleMs(),
      now: () => Date.now(),
      load: () => ctx.storage.get<number>(LAST_USE_KEY),
      save: (at) => ctx.storage.put(LAST_USE_KEY, at),
      loadActivity: () => ctx.storage.get<number>(LAST_ACTIVITY_KEY),
      saveActivity: (at) => ctx.storage.put(LAST_ACTIVITY_KEY, at),
      running: () => this.containerRunning(),
      // The one alarm is shared with the spare's preparation and a Build, which the idle stop does not put off.
      setAlarm: async (at) =>
        ctx.storage.setAlarm(await this.#builds.alarmAt(await this.#spare.alarmAt(at))),
      // The disk is snapshotted while the Container is idle, so the next launch restores the Toolchains, unless nothing
      // that may change it ran since its restore (`ContainerLaunch.snapshot`). A command that arrives meanwhile keeps the
      // Container (`IdleStop`). A Build's object keeps no snapshot of its own: each Build starts from the image.
      snapshot: async () => {
        if (!(await this.#builds.isBuild())) await launch.snapshot("idle");
      },
      // The size the agent's resize recorded lasts until here.
      stop: () => resizes.stopIdle(),
      // What may change the Container's disk is kept in its launch record, so its idle stop snapshots it.
      wrote: () => launch.noteWrite(),
      // A Container held past the hold cap without activity: logged, and kept for the Sessions' notices.
      held: async (stop) => {
        console.warn(
          `workspace.container.held-stop: stopped after ${heldStopMinutes(stop)} min without owner or agent activity, ${stop.holds} hold(s) dropped (a command handle never released, or a Container preview left open)`,
        );

        const kept = (await ctx.storage.get<ReadonlyArray<HeldStop>>(HELD_STOPS_KEY)) ?? [];

        await ctx.storage.put(HELD_STOPS_KEY, [...kept, stop].slice(-HELD_STOPS_KEPT));
      },
      used: () => void tally(usage.seen()),
      busy: (busy) => void tally(usage.busy(busy)),
    });

    // The Container starts when a command first asks for it, not with the object.
    const container: ContainerBackendOptions = {
      // The launch goes through `launch`, which picks the instance type and the snapshot, and each Container started can
      // report why it stopped (`withExitReports`). The file-change signal's push never launches one (`withNoSignalStart`).
      container: () => ({
        getWorkspaceContainer: () =>
          withNoSignalStart(
            withExitReports(
              launch.wrap(this.workspaceContainer()),
              () => this.#interceptExitReports(),
              (message) => console.warn(message),
            ),
            {
              refuses: () => this.#notifier.refusesLaunch(),
              running: () => this.containerRunning(),
            },
          ),
      }),
      workspace: { binding: WORKSPACE_BINDING, id: ctx.id.toString() },
      name: WORKSPACE_CONTAINER,
      connectTimeoutMs: CONNECT_TIMEOUT_MS,
      // Unrestricted direct egress in v1, not logged (docs/architecture/container.md).
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
    // variables, the GitHub tokens and mise's settings, and the tokens are taken out of its output. The Workspace sees this
    // as the Container's backend.
    const toolchains = new ToolchainBackend({
      backend: this.#container,
      github,
      // A command's `GH_TOKEN` is the token of the account that owns the repos of its working directory.
      repoAccount: (directory) => this.#comparison.githubAccountOf(directory),
      // Taken out of output as the tokens are, each as its Secret Reference.
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
      readOnlyDirectories: readOnly,
      git: { name: env.CLOUDPID_GIT_NAME, email: env.CLOUDPID_GIT_EMAIL },
      warn: (message) => console.warn(message),
      now: () => Date.now(),
    });

    this.#workspace = new ComputerWorkspace({
      storage: ctx.storage,
      // The Skill set the Workspace holds (empty until one is handed over) appears read-only: a write under the mount
      // fails with EROFS, and a set of another hash replaces the copy.
      mounts: {
        [SKILLS_MOUNT]: skillSetMount(
          () => skills.current(),
          (set, api) => this.writeSkillSet(set, api),
        ),
      },
      observer: this.#containerUseObserver(
        this.#notifier.observer(CONTAINER_BACKEND_ID, noopObserver),
      ),
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
      // The daily look asks GitHub (or the remote) from here, so a Build that finds nothing moved starts no Container.
      heads: remoteHeads({ fetch: (url, init) => this.githubFetch(url, init), github }),
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

    // The model's file tools reach Container-only paths through the Container (ADR-0018): by the patterns of the launch
    // that runs now, or of the next one, each operation a script run as any other command on it.
    this.#host = new WorkspaceEnvHost(this.#workspace, {
      patterns: async () => {
        const patterns = await launch.ignore();

        return patterns === undefined ? undefined : withHarnessKept(patterns);
      },
      running: () => ctx.container?.running === true,
      // A write of a Container-only file changes the disk, so the idle stop snapshots it; a read does not.
      run: (script, scriptEnv, options) =>
        this.#runOnContainer(script, scriptEnv, { writes: options?.writes === true }),
    });
    void ctx.blockConcurrencyWhile(() => this.#host.prepare(WORKSPACE_ROOT, Date.now()));

    // The repos' Changes: read here with isomorphic-git, or by the Container's git for a repo that needs it, which only
    // a call that may start the Container starts (ADR-0022).
    this.#changes = new WorkspaceChangesModule({
      files: () => this.#workspace.provider(),
      containerOnly,
      running: () => ctx.container?.running === true,
      run: (script) => this.#runOnContainer(script, {}, { writes: false }),
      kept: {
        load: async (repo) => ctx.storage.kv.get<KeptChanges>(`${CHANGES_KEY}:${repo}`),
        save: async (repo, changes) => ctx.storage.kv.put(`${CHANGES_KEY}:${repo}`, changes),
      },
      warn: (message) => console.warn(message),
    });

    // This branch: the Container's git makes the Comparison (only a call that may start it does), the list is kept by
    // (merge-base, head), and a file's contents are read here (ADR-0022).
    this.#comparison = new WorkspaceComparisonModule({
      files: () => this.#workspace.provider(),
      running: () => this.containerRunning(),
      run: (script) => this.runContainerScript(script),
      store: {
        get: async (key) => ctx.storage.kv.get(key),
        put: async (key, value) => ctx.storage.kv.put(key, value),
        delete: async (key) => {
          ctx.storage.kv.delete(key);
        },
      },
      fetch: (url, init) => this.githubFetch(url, init),
      github,
      now: () => this.clock(),
      redact,
      warn: (message) => console.warn(message),
    });

    // The Run diff: copies of the repos' trees saved as git objects here (or by the Container's git for a repo that needs
    // it, only while it runs), and the Run listed against the start copy with the Changes' own machinery (ADR-0022).
    this.#runs = new WorkspaceRunsModule({
      files: () => this.#workspace.provider(),
      changes: this.#changes,
      containerOnly,
      running: () => this.containerRunning(),
      run: (script) => this.runContainerScript(script),
      store: {
        get: async (key) => ctx.storage.kv.get(key),
        put: async (key, value) => ctx.storage.kv.put(key, value),
        delete: async (key) => {
          ctx.storage.kv.delete(key);
        },
        keys: async (prefix) => Array.from(ctx.storage.kv.list({ prefix }), ([key]) => key),
      },
      warn: (message) => console.warn(message),
    });

    // What the clones have not pushed: read here with isomorphic-git while the Container is stopped, so a report or delete
    // of a Subagent Workspace starts no Container; by the Container's git while it runs, or for a repo that needs it.
    this.#workState = new WorkspaceWorkStateModule({
      files: () => this.#workspace.provider(),
      needsContainer: (repo) => this.#changes.needsContainer(repo),
      containerOnly,
      running: () => this.containerRunning(),
      run: (script) => this.runContainerScript(script),
      warn: (message) => console.warn(message),
    });

    // The Container previews (ADR-0023): never a start of the Container, and each request and open socket a use of it.
    this.#containerPreview = new ContainerPreview({
      running: () => this.containerRunning(),
      port: (port) => this.containerPort(port),
      activity: () => this.containerPreviewActivity(),
      used: () => this.#spare.noteUse(),
      // 256 random bits, as hex.
      newId: () =>
        Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      keepAliveMs: () => this.containerPreviewKeepAliveMs(),
      warn: (message) => console.warn(message),
    });
  }

  /** The Container's port `port`, for a Container preview. A test Worker replaces it. */
  protected containerPort(port: number): Fetcher {
    if (this.ctx.container === undefined) throw new Error("This Workspace has no Container");

    return this.ctx.container.getTcpPort(port);
  }

  /** How often a carried socket's stream is written to, to find a page gone or not reading. A test Worker shortens it. */
  protected containerPreviewKeepAliveMs(): number {
    return CONTAINER_PREVIEW_KEEP_ALIVE_MS;
  }

  /** The uses a Container preview makes of the Container: the idle stop's. A test Worker counts them. */
  protected containerPreviewActivity(): ContainerPreviewActivity {
    return this.#idle;
  }

  /** The platform's Container API, which every launch goes through. A test Worker replaces it. */
  protected workspaceContainer(): IWorkspaceContainerAPI {
    return this.getWorkspaceContainer();
  }

  /** Whether the Container runs now. A test Worker replaces it. */
  protected containerRunning(): boolean {
    return this.ctx.container?.running === true;
  }

  /**
   * Send the Container the Workspace's changes now (computer's push to its backend), for the file-change signal, which
   * calls it only while the Container runs. A test Worker replaces it.
   */
  protected async pushContainerChanges(): Promise<void> {
    for await (const progress of this.#workspace.push(CONTAINER_BACKEND_ID)) {
      if (progress.complete) break;
    }
  }

  /**
   * Tell the Container's file watchers of `paths` (`cloudpid-notify`, through the platform's `exec`: no use of the
   * Container and no activity, docs/architecture/container.md → File-change signals). A test Worker replaces it.
   */
  protected async signalContainer(paths: ReadonlyArray<string>): Promise<void> {
    const container = this.ctx.container;

    if (container?.running !== true) return;

    const reported = await runNotify(container, paths);

    if (reported !== "") console.warn(`file-change signal: ${reported.slice(0, 1_000)}`);
  }

  /**
   * Run `script` on the Container, starting it if it is stopped: the Container's git for the Changes, a Comparison, the
   * Run diff and the work state, which change nothing a snapshot keeps (the repos' files are synced). A test Worker
   * replaces it.
   */
  protected runContainerScript(script: string): Promise<ContainerScriptRun> {
    return this.#runOnContainer(script, {}, { writes: false });
  }

  /** The time in ms, which the pull request list's 60 s are counted by. A test Worker replaces it. */
  protected clock(): number {
    return Date.now();
  }

  /**
   * GitHub's API (the base of a branch's pull request, the pull requests, and the GitHub App's tokens). A test Worker
   * replaces it.
   */
  protected githubFetch(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, init);
  }

  /**
   * Run one of the file tools' scripts on the Container, through this object's own handle, as a command: it starts the
   * Container if it is stopped and keeps it from its idle stop, which snapshots the Container only for one that
   * `writes`. Its two streams come back apart.
   */
  async #runOnContainer(
    script: string,
    scriptEnv: Readonly<Record<string, string>>,
    options: { readonly writes: boolean },
  ): Promise<ContainerScriptRun> {
    const container = new ComputerExecutionEnv({
      workspace: this.#ownStub(options.writes),
      id: `computer:container-files:${this.ctx.id.toString()}`,
      cwd: WORKSPACE_ROOT,
    }).onBackend("container");

    let stdout = "";
    let stderr = "";

    try {
      const result = await container.exec(
        ["bash", "-c", script],
        {
          cwd: WORKSPACE_ROOT,
          timeout: CONTAINER_FILES_TIMEOUT_SECONDS,
          env: { ...scriptEnv },
          onOutput: (text, _context, info) => {
            if (info.stream === "stdout") stdout += text;
            else stderr += text;
          },
        },
        BACKGROUND_CONTEXT,
      );

      return result.ok
        ? { exitCode: result.value.exitCode, stdout, stderr }
        : { exitCode: null, stdout, stderr: result.error.message };
    } finally {
      await container.cleanup(BACKGROUND_CONTEXT);
    }
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
   * This object as a stub of its own: its file operations and Workspace, with no Skills, templates or instructions,
   * which its own work never asks for. Its commands may change the Container's disk unless `writes` is false.
   */
  #ownStub(writes = true): ComputerWorkspaceStub {
    return {
      fileOperation: (request) => this.#fileOperation(request),
      __getWorkspaceStub: () => this.#getWorkspaceStub(writes),
      skills: async () => [],
      prompts: async () => [],
      instructions: async () => [],
    };
  }

  /**
   * The `PreparationHost` of this object over itself, as environment `id`: a spare's preparation and a Build reach it
   * through a handle of their own, so their calls are not taken for a Session's (`SparePreparation.noteUse`).
   */
  #ownHost(id: string): PreparationHost {
    return preparationHost(
      this.#ownStub(),
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
      // Its own work is not a Session's use of the spare.
      { write: (set) => this.#updateSkills(set) },
      (message) => console.warn(message),
    );
  }

  /**
   * Records each use of the Container for the idle stop: computer reports a span around every connect, push and pull on a
   * backend, and a command on the Container is a push before it and a pull after it. The file-change signal's own push
   * (and its connect) is no use: an edit alone keeps no running Container from its idle stop
   * (docs/architecture/container.md → Idle stop). Every span then goes to `next` (the file-change signal's observer).
   */
  #containerUseObserver(next: WorkspaceObserver): WorkspaceObserver {
    const uses = (attributes: Parameters<WorkspaceObserver["span"]>[1]) =>
      attributes["workspace.sync.backend"] === CONTAINER_BACKEND_ID ||
      attributes["workspace.backend.id"] === CONTAINER_BACKEND_ID;

    const touch = () => {
      // A failed write only shortens the idle time: the alarm works from what was stored before.
      this.#idle.touch().catch((cause: unknown) => console.warn("idle stop: touch failed", cause));
    };

    return {
      span: (name, attributes, run) => {
        if (!uses(attributes) || inSignalPush()) return next.span(name, attributes, run);

        touch();

        return next.span(name, attributes, run).finally(touch);
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
   * `text`, a report of this object's Container (`ContainerExitReports`), with the GitHub tokens and the Environment's
   * kept Secrets taken out; null when the copy of them does not open, so it cannot be shown free of them. Not a use of
   * the Workspace: a spare's preparation goes on.
   */
  async redactExitReport(text: string): Promise<string | null> {
    const held = await this.#environmentSecrets.read();

    return held.ok ? redactText(text, this.#github?.live() ?? [], held.secrets) : null;
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
   * Make this object's Environment's Build of `request` (docs/architecture/container.md → Builds; the object is `buildObjectName`'s), or
   * its Test Build of a request marked `test` (the object is `testBuildObjectName`'s): it is kept and begun at the
   * alarm, so this answers at once, with the state then (`BuildRunner`). `secrets`, the
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

  /**
   * This Build object's last good Build, the one in progress or the last failure, and the image a launch would run now;
   * a Test Build object's latest Test Build.
   */
  buildState(): Promise<BuildState> {
    return this.#builds.state();
  }

  /**
   * Stop Test Build `id` (a Test Build object's, `testBuildObjectName`: its call was stopped): one under way has its
   * Container stopped, and one that waits never begins (`BuildRunner.cancel`).
   */
  cancelBuild(id: string): Promise<BuildState> {
    return this.#builds.cancel(id);
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
   * The size the agent's resize recorded is forgotten too: the owner starts the Workspace over, on its Environment's size.
   */
  async restartContainer(): Promise<void> {
    await this.stopContainer({ forgetSnapshot: true });
    await this.#resizes.forget();
  }

  /**
   * Stop the Container if it runs, at once and without a snapshot of its own (the agent's `container_restart`, which
   * works when computerd no longer answers: the platform stops the Container). The next command starts a Container
   * from the snapshot the Workspace holds, as after an idle stop, with what its disk held when that was taken, on the
   * size the agent's resize recorded if there is one, which this keeps; with
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
   * Have the Container start on `size` until its idle stop (the agent's `container_resize`; docs/architecture/container.md → Resize by the
   * agent), within the Environment's size limit: a running Container is snapshotted and stopped (commands running there
   * end), unless it already runs on `size`, and the next launch restores the snapshot on `size`. The resize holds the
   * Container from the idle stop meanwhile, so the idle alarm does not stop it under the snapshot and forget the size.
   */
  async resizeContainer(options: { readonly size: InstanceType }): Promise<ContainerResizeOutcome> {
    this.#spare.noteUse();

    // It snapshots the Container itself, and changes nothing on its disk.
    const hold = this.#idle.hold({ writes: false });

    await hold.begun;

    try {
      return await this.#resizes.resize(options.size);
    } finally {
      await hold.end();
    }
  }

  /**
   * A Session in this Workspace is at work: the owner sent a message, or a Run is live (its heartbeat). The hold cap
   * counts from here (docs/architecture/container.md → Idle stop); it is not a use of the Container, which it neither
   * starts nor keeps from its idle stop.
   */
  async noteSessionActivity(): Promise<void> {
    this.#spare.noteUse();

    await this.#idle.noteActivity();
  }

  /**
   * The held stops of this Workspace's Container after `after` (epoch milliseconds), oldest first: each a stop of a
   * Container kept past the hold cap without owner or agent activity, which its Sessions show as a notice. The latest
   * few are kept. Not a use of the Workspace.
   */
  async containerHeldStops(after: number): Promise<ReadonlyArray<HeldStop>> {
    const kept = (await this.ctx.storage.get<ReadonlyArray<HeldStop>>(HELD_STOPS_KEY)) ?? [];

    return kept.filter((stop) => stop.at > after);
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
   * What this Workspace's clones of `repos` have not pushed of `branch` (`LifecycleHost.workState`): a Subagent
   * Workspace's report and delete, and the warning a spawn from this one gives, as `workStateScript` reads it. Read
   * here while the Container is stopped, which starts it only for a repo this object cannot read
   * (`WorkspaceWorkStateModule`).
   */
  async workState(
    branch: string,
    repos: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<RepoWorkState>> {
    this.#spare.noteUse();

    return this.#workState.read(branch, repos);
  }

  /**
   * Prepare this Workspace as its Environment's spare (docs/architecture/workspace.md → Spare Workspace): `setup` is kept and the work
   * starts at the alarm, so this answers at once (`SparePreparation`).
   */
  async prepareSpare(setup: WorkspaceSetup): Promise<void> {
    // The Secrets are kept sealed, never with the set-up the preparation stores. The Skill set is mounted now, so the
    // set-up stored stays small and a Session that takes the spare before its preparation finds the Skills.
    const { secrets, secretsUnavailable, skills, ...stored } = setup;

    if (secrets !== undefined) await this.#environmentSecrets.replace(secrets);
    else if (secretsUnavailable !== undefined) {
      await this.#environmentSecrets.markUnavailable(secretsUnavailable);
    }

    if (skills !== undefined) {
      const mounted = await this.#updateSkills(skills);

      if (!mounted.ok)
        console.warn(`workspace.spare: its Skill set was refused: ${mounted.message}`);
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

  /**
   * Answer `request`, a page's in the Session's browser, from the Container's `port`: a Container preview (ADR-0023),
   * which the Workspaces Worker's `WorkspaceContainerPreviews` entrypoint hands here. It never starts the Container (a
   * stopped one answers 503, a port with nothing listening 502) and serves the eight Container preview ports only; each
   * request it serves is a use of the Workspace and the Container, and a page's open carried socket holds off the idle
   * stop as a running command does.
   */
  containerPreview(request: Request, port: number): Promise<Response> {
    return this.#containerPreview.serve(request, port);
  }

  /** The Container's egress: computerd dials back here, and `WorkspaceProxy` forwards its WebSocket upgrade. */
  override fetch(request: Request): Promise<Response> {
    return this.#container.handleFetch(request);
  }

  /**
   * The Workspace is ready once computer has indexed its mounts, which copies the Skill set into the files the first
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
   * costs this one call instead of a listing per directory and a read per skill. The Skill set the Workspace holds is
   * known from memory and parsed once per hash, and only the repo's own are read.
   */
  async skills(cwd: string): Promise<ReadonlyArray<Skill>> {
    this.#spare.noteUse();
    await this.#ready();

    return discoverWorkspaceSkills(this.#host.readEnv(cwd), this.#skills.current());
  }

  /** The hash of the Skill set the Workspace holds, so a set is handed over only when its hash differs. */
  skillSetHash(): string {
    this.#spare.noteUse();

    return this.#skills.current().hash;
  }

  /**
   * Keep `set` as the Skill set the mount at `/workspace/.agents/skills` serves (ADR-0026), and copy it into the files
   * at once: computer clears the mount and writes the set, so a file the set lacks is gone. A set with the hash held does
   * nothing. One that is not a set, or whose paths are not the mount's, is refused, and so is one that cannot be
   * written: the set held before is mounted again. No other call of this object runs meanwhile, so each sees the whole
   * old set or the whole new one, never a mount that is cleared or writable (docs/architecture/workspace.md → Filesystem and tools →
   * Skills).
   */
  async updateSkills(set: SkillSet): Promise<SkillSetAnswer> {
    this.#spare.noteUse();

    return this.#updateSkills(set);
  }

  /** `updateSkills`, for this object's own work too: a spare's set-up hands it its set, which is no Session's use. */
  async #updateSkills(set: SkillSet): Promise<SkillSetAnswer> {
    const checked = checkSkillSet(set);

    if (!checked.ok) return checked;

    if (checked.set.hash === this.#skills.current().hash) return { ok: true };

    // The first index (and the move of what the Workspace had at the mount before) happens before any hand-over.
    await this.#ready();

    return this.ctx.blockConcurrencyWhile(() => this.#mountSkills(checked.set));
  }

  /**
   * Keep and mount `set`, inside `blockConcurrencyWhile`, so it never throws: a failure there resets the object. When
   * computer cannot write it, it leaves the mount cleared and writable, so the set held before is kept and mounted again
   * before any other call runs.
   */
  async #mountSkills(set: SkillSet): Promise<SkillSetAnswer> {
    const previous = this.#skills.current();

    if (set.hash === previous.hash) return { ok: true };

    try {
      this.#skills.replace(set);
      await this.#workspace.remount();

      return { ok: true };
    } catch (cause) {
      try {
        this.#skills.replace(previous);
        await this.#workspace.remount();
      } catch (again) {
        // computer indexes the mount again at the next call (`#ready`), from the set kept.
        console.warn("skills: the Skill set held before could not be mounted again", again);
      }

      return {
        ok: false,
        message: `The Skill set could not be mounted, and the Workspace keeps the one it held: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      };
    }
  }

  /** Write a Skill set's files under the mount's root, when computer copies it into the files. A test Worker replaces it. */
  protected writeSkillSet(set: SkillSet, api: MountWriteAPI): Promise<void> {
    return writeSkillSet(set, api);
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

  /**
   * The project instructions for the files of `directory`: the `AGENTS.md` (or `CLAUDE.md`) of it and of each directory
   * above it up to the Workspace root, read next to the files, so a Session's lookup is this one call.
   */
  async instructions(directory: string): Promise<ReadonlyArray<InstructionFile>> {
    this.#spare.noteUse();
    await this.#ready();

    return discoverWorkspaceInstructions(this.#host.readEnv(directory), directory);
  }

  /**
   * The Changes of the repos `request.directory` covers (docs/architecture/diffs-and-review.md → Changes): listed here, or by
   * the Container's git for a repo that needs it, which starts the Container only with `startContainer`; a repo that
   * needs a stopped Container otherwise keeps its last list, marked `stale`.
   */
  async changes(request: ChangesRequest): Promise<WorkspaceChanges> {
    this.#spare.noteUse();
    await this.#ready();

    return this.#changes.list(request);
  }

  /** One changed file's HEAD and working sides. It never starts the Container. */
  async changeFile(request: ChangeFileRequest): Promise<ChangeFile> {
    this.#spare.noteUse();
    await this.#ready();

    return this.#changes.file(request);
  }

  /**
   * The picker's repos (docs/architecture/diffs-and-review.md → Comparisons): the repos `directory` covers, the Session's own
   * first, each with its HEAD, and with `pulls` its open pull requests (GitHub's REST API, kept for 60 s). It never starts
   * the Container.
   */
  async comparisonSources(directory: string, pulls = false): Promise<ComparisonSources> {
    this.#spare.noteUse();
    await this.#ready();

    return this.#comparison.sources(directory, pulls);
  }

  /**
   * The Comparison of `request.repo`'s branch, or why there is none: made by the Container's git, which only a request
   * with `startContainer` starts; kept by (merge-base, head), so one for the HEAD it was made for needs no Container.
   */
  async compare(request: CompareRequest): Promise<CompareResult> {
    this.#spare.noteUse();
    await this.#ready();

    return this.#comparison.compare(request);
  }

  /** One file's two sides of a Comparison. It never starts the Container. */
  async comparisonFile(request: ComparisonFileRequest): Promise<ChangeFile> {
    this.#spare.noteUse();
    await this.#ready();

    return this.#comparison.file(request);
  }

  /**
   * A Run starts writing (docs/architecture/diffs-and-review.md → Run diff): each repo `request.directory` covers is copied
   * before the Run's first writing call, which waits for it; the Session's last Run is replaced. Starts no Container: a
   * repo that needs it while it is stopped is "not captured".
   */
  async runStart(request: RunStartRequest): Promise<LastRun> {
    this.#spare.noteUse();
    await this.#ready();

    return this.#runs.start(request);
  }

  /** The Run ended: copy each captured repo again and keep the Run's diff. Null for a Run that is not the latest. */
  async runEnd(request: RunEndRequest): Promise<LastRun | null> {
    this.#spare.noteUse();
    await this.#ready();

    return this.#runs.end(request);
  }

  /** The Run diff of the Session's latest writing Run, or null. It never starts the Container. */
  async runDiff(scope: string): Promise<RunDiff | null> {
    this.#spare.noteUse();
    await this.#ready();

    return this.#runs.diff(scope);
  }

  /** One file of the Session's latest writing Run: its two sides. It never starts the Container. */
  async runFile(request: RunFileRequest): Promise<ChangeFile> {
    this.#spare.noteUse();
    await this.#ready();

    return this.#runs.file(request);
  }

  /** computer's Workspace RPC, for `getWorkspace()`: the caller disposes the stub. */
  __getWorkspaceStub(): Promise<WorkspaceStub> {
    this.#spare.noteUse();

    return this.#getWorkspaceStub();
  }

  async #getWorkspaceStub(writes = true): Promise<WorkspaceStub> {
    await this.#ready();

    return this.workspaceStub(this.#workspace, writes);
  }

  /** One of `ComputerExecutionEnv`'s file operations, answered as plain data. */
  fileOperation(request: EnvRequest): Promise<EnvResponse<HostOperation>> {
    this.#spare.noteUse();

    return this.#fileOperation(request, { session: true });
  }

  /** A file operation: a Session's (`session`), or this object's own work's (a spare's preparation, a Build). */
  async #fileOperation(
    request: EnvRequest,
    { session = false }: { readonly session?: boolean } = {},
  ): Promise<EnvResponse<HostOperation>> {
    const writes = WRITE_OPERATIONS.has(request.op);

    // A Session's write (a model tool's) is activity in the Workspace, which the hold cap counts from; a read is not, as
    // a watcher polls.
    if (writes && session) {
      this.#idle
        .noteActivity()
        .catch((cause: unknown) => console.warn("idle stop: noting activity failed", cause));
    }

    // The Skill set is copied into the files the first time the mounts are indexed, which `#ready()` does once.
    await this.#ready();

    try {
      return await this.#host.handle(request);
    } finally {
      // A write reaches a running Container soon, with the file-change signal (`FileNotifier`).
      if (writes) this.#notifier.changed();
    }
  }

  /**
   * The RPC stub `__getWorkspaceStub()` hands out, its Container commands counted by the idle stop, as commands that may
   * change the disk unless `writes` is false; tests count them too.
   */
  protected workspaceStub(workspace: ComputerWorkspace, writes = true): WorkspaceStub {
    return new TrackedWorkspaceStub(workspace, this.#idle, CONTAINER_BACKEND_ID, writes);
  }
}
