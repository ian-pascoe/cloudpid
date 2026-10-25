// An Environment's Build (docs/spec.md → Builds, ADR-0016), made by a Workspace DO of its own (`buildObjectName`): a
// Snapshot of a Container with the Environment's Toolchains installed and what its Setup Scripts download cached outside
// `/workspace`, which new Workspaces start their first Container from. The main Worker asks for one (`request`) when the
// Environment's Repos or Container settings or the image changed, or for the daily look at the Repos' default branches;
// its `waitUntil` lasts far less than a Build, so the object does the work on its alarm, as a spare's preparation does
// (`spare.ts`). A Build hands the Environment's settings to the object (its Setup Script left to the Build, its Start
// Script out: no service runs in a Build), starts the Container (its bootstrap installs the Toolchains), clones each Repo
// into a scratch directory outside `/workspace`, installs their Toolchains, runs the Environment's Setup Script, then each
// Repo's, records each Repo's commit, stops what the scripts left running, deletes the clones and every Setup Script
// record, snapshots the Container (after the scan for the token and the Environment's Secrets) and stops it. The
// Setup Scripts get the Environment's Secrets marked for the Build, as `$PI_SECRET_<NAME>` (the name a Session's
// commands get them under), in their environment only. The last good Build is kept with the state of the one in
// progress or the last failure; a Build that fails keeps the last good one.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import {
  containerOverridesFrom,
  type ContainerSettings,
  resolveContainerSettingsLeniently,
} from "@cloudpid/config";
import {
  BUILD_ROOT,
  buildCleanupScript,
  buildCloneScript,
  buildCommitsScript,
  buildPrelude,
  parseCommits,
  remoteHeadsScript,
} from "@cloudpid/sandbox-image/builds";
import {
  environmentSetupScriptRun,
  SETUP_SCRIPT,
  SETUP_STATE_DIRECTORY,
  SETUP_TIMEOUT_SECONDS,
  setupScriptRunIfDue,
} from "@cloudpid/sandbox-image/toolchains";
import type * as Schema from "effect/Schema";
import type {
  BuildRequest,
  BuildState,
  EnvironmentBuild,
  TestBuildState,
} from "./build-record.ts";
import { buildSecretEnvironment, type HeldSecrets } from "./environment-secrets.ts";
import type { IdleStop } from "./idle.ts";
import { CLONE_TIMEOUT_SECONDS, SCRIPT_RUN_MARGIN_SECONDS, type ScriptRun } from "./prepare.ts";

/** What the object keeps: its Builds, and the request a Build waits to begin or runs for, until it ends. */
export type StoredBuilds = Omit<BuildState, "image"> & {
  readonly pending: (BuildRequest & { readonly id: string; readonly attempts: number }) | null;
};

/** How many times a Build cut off by an eviction is begun before it is given up on. */
export const BUILD_ATTEMPTS = 3;

/** How old a good Build may get before the daily look makes a new one anyway: well within a snapshot's 30 days. */
export const BUILD_REFRESH_MS = 20 * 24 * 60 * 60_000;

/** How long asking the remotes for their default branches, reading the commits, or the clean-up may take, in seconds. */
const SHORT_STEP_SECONDS = 5 * 60;

/** How much of a step's output a failure keeps, from its end. */
const REPORTED_OUTPUT = 1_000;

export type BuildRunnerDeps = {
  /** Off where the Container has no snapshots (`alchemy dev`): a request then fails at once. */
  readonly enabled: boolean;
  readonly load: () => Promise<StoredBuilds | undefined>;
  readonly save: (stored: StoredBuilds) => Promise<void>;
  /** Have the object's alarm fire by `at`, keeping one set for earlier. */
  readonly wake: (at: number) => Promise<void>;
  /** The reference of the image a Container launched now would run. */
  readonly image: () => string | undefined;
  /** Keep `overrides` as the object's Container settings, which its Container's launch and bootstrap use. */
  readonly handOver: (overrides: Schema.Json) => Promise<void>;
  /** Run a bash script on the object's own Container (starting it, and its bootstrap, first), with `env` beside its own. */
  readonly run: (
    script: string,
    timeoutSeconds: number,
    env?: Readonly<Record<string, string>>,
  ) => Promise<ScriptRun>;
  /** The Environment's kept Secrets the object was handed with the request, or why it cannot show them. */
  readonly secrets: () => Promise<HeldSecrets>;
  /** Snapshot the running Container, after the scan for the token: the Build's snapshot, or why there is none. */
  readonly snapshot: () => Promise<
    | {
        readonly ok: true;
        readonly snapshot: { readonly id: string; readonly size: number };
        readonly image: string;
        readonly ignore: ReadonlyArray<string> | undefined;
      }
    | { readonly ok: false; readonly reason: string }
  >;
  /** Stop the Container. */
  readonly stop: () => Promise<void>;
  /** The idle stop: it holds the Container while a Build runs. */
  readonly idle: Pick<IdleStop, "begin" | "end">;
  /** `text` with the GitHub token and the Environment's Secrets taken out. */
  readonly redact: (text: string) => string;
  /** A fresh id for a request, which tags the processes its scripts start. */
  readonly newId: () => string;
  readonly now: () => number;
  readonly info: (message: string) => void;
  readonly warn: (message: string) => void;
};

/** The key of a Build's log lines. */
const LOG_KEY = "workspace.build";

/** Why a Build or Test Build fails at once under `alchemy dev`. */
const BUILDS_OFF = "Builds are off where the Container takes no snapshots (alchemy dev)";

/** What a Build of `request` came to. */
type Outcome =
  | { readonly kind: "built"; readonly build: EnvironmentBuild }
  | { readonly kind: "unchanged" }
  | { readonly kind: "failed"; readonly reason: string };

/** A Test Build's state once it ended with `outcome`. */
const testEnded = (test: TestBuildState, outcome: Outcome, at: number): TestBuildState => {
  const { id, key, startedAt } = test;

  return outcome.kind === "failed"
    ? { id, key, startedAt, status: "failed", reason: outcome.reason, finishedAt: at }
    : { id, key, startedAt, status: "succeeded", finishedAt: at };
};

const NOTHING: StoredBuilds = { last: null, progress: null, attemptedAt: null, pending: null };

/**
 * The Container settings a Build's object runs with: the Environment's, but for its Setup Script, which the Build runs
 * itself in its scratch root, and its Start Script, since no service runs in a Build. Its commands get the variables;
 * the Secrets do not join them here, since the settings are stored in the clear: `buildSecretEnvironment`.
 */
export const buildContainerSettings = (settings: ContainerSettings): Schema.Json =>
  containerOverridesFrom({ ...settings, setupScript: "", startScript: "" });

export class BuildRunner {
  readonly #deps: BuildRunnerDeps;
  #inflight: Promise<void> | undefined;
  /** The request (`pending.id`) of the Test Build a cancel stopped while it ran: none of its steps runs after that. */
  #cancelled: string | undefined;

  constructor(deps: BuildRunnerDeps) {
    this.#deps = deps;
  }

  /** Whether this object is a Build's: it was ever asked for one. Its Container then takes no snapshots of its own. */
  async isBuild(): Promise<boolean> {
    return (await this.#deps.load()) !== undefined;
  }

  /** The object's Builds, and the image a launch would run now. */
  async state(): Promise<BuildState> {
    const { pending: _pending, ...stored } = (await this.#deps.load()) ?? NOTHING;

    return { image: this.#deps.image(), ...stored };
  }

  /**
   * Ask for a Build of `request`, begun at the next alarm (woken for now); answers the state then. A Build of the same
   * key that is under way or waits is left to go on. Another, that runs, finishes first, then this one begins.
   */
  async request(request: BuildRequest): Promise<BuildState> {
    if (request.test !== undefined) return this.#requestTest(request, request.test);

    const deps = this.#deps;
    const stored = (await deps.load()) ?? NOTHING;
    const running = stored.pending;

    if (
      running !== null &&
      running.key === request.key &&
      (running.check !== true || request.check === true)
    ) {
      return this.state();
    }

    const now = deps.now();

    if (!deps.enabled) {
      await deps.save({
        ...stored,
        progress: { status: "failed", key: request.key, reason: BUILDS_OFF, at: now },
        attemptedAt: now,
      });

      return this.state();
    }

    await deps.save({
      ...stored,
      pending: { ...request, id: deps.newId(), attempts: 0 },
      progress: {
        status: request.check === true ? "checking" : "building",
        key: request.key,
        startedAt: now,
      },
    });
    await deps.wake(now);

    return this.state();
  }

  /**
   * Ask for Test Build `id` of `request` (a Test Build object's): begun at the next alarm, as a Build is. A request of
   * the same id (its call's rerun after an eviction) finds the one asked for, under way or ended; while another runs,
   * nothing is asked for, and the state answered shows that one (one at a time).
   */
  async #requestTest(request: BuildRequest, id: string): Promise<BuildState> {
    const deps = this.#deps;
    const stored = (await deps.load()) ?? NOTHING;

    if (stored.test?.id === id || stored.pending !== null) return this.state();

    const now = deps.now();
    const asked = { id, key: request.key, startedAt: now } as const;

    if (!deps.enabled) {
      await deps.save({
        ...stored,
        test: { ...asked, status: "failed", reason: BUILDS_OFF, finishedAt: now },
      });

      return this.state();
    }

    await deps.save({
      ...stored,
      pending: { ...request, id: deps.newId(), attempts: 0 },
      test: { ...asked, status: "building" },
    });
    await deps.wake(now);

    return this.state();
  }

  /**
   * Stop Test Build `id` (its call was stopped): one that waits for the alarm never begins, and one that runs has its
   * Container stopped, which ends the step under way, and runs no step after. A Test Build of another id, or one that
   * ended, is left as it is. Answers the state then.
   */
  async cancel(id: string): Promise<BuildState> {
    const deps = this.#deps;
    const stored = (await deps.load()) ?? NOTHING;
    const { test, pending } = stored;

    if (test?.id !== id || test.status !== "building") return this.state();

    const mine = pending?.test === id ? pending : null;

    await deps.save({
      ...stored,
      pending: mine === null ? pending : null,
      test: { ...test, status: "cancelled", finishedAt: deps.now() },
    });

    if (mine !== null && this.#inflight !== undefined) {
      this.#cancelled = mine.id;

      try {
        await deps.stop();
      } catch (cause) {
        deps.warn(`${LOG_KEY}: stopping the cancelled Test Build's Container failed: ${String(cause)}`);
      }
    }

    deps.info(`${LOG_KEY}: the Test Build was cancelled`);

    return this.state();
  }

  /**
   * When an alarm the idle stop wants at `at` should be set instead: no later than now while a request waits for the
   * alarm that begins it, so the idle stop does not put it off.
   */
  async alarmAt(at: number): Promise<number> {
    if (this.#inflight !== undefined || ((await this.#deps.load())?.pending ?? null) === null) {
      return at;
    }

    return Math.min(at, this.#deps.now());
  }

  /** The alarm: begin the Build a request waits for, unless one runs. Answers once it has begun. */
  async alarm(): Promise<void> {
    if (this.#inflight !== undefined) return;

    const stored = await this.#deps.load();
    const pending = stored?.pending ?? null;

    if (stored === undefined || pending === null || this.#inflight !== undefined) return;

    if (pending.attempts >= BUILD_ATTEMPTS) {
      const reason = `it was cut off ${pending.attempts} times before it finished`;
      const now = this.#deps.now();

      await this.#deps.save(
        pending.test === undefined
          ? {
              ...stored,
              pending: null,
              progress: { status: "failed", key: pending.key, reason, at: now },
              attemptedAt: now,
            }
          : {
              ...stored,
              pending: null,
              test:
                stored.test?.id === pending.test
                  ? testEnded(stored.test, { kind: "failed", reason }, now)
                  : stored.test,
            },
      );
      this.#deps.warn(`${LOG_KEY}: given up after ${pending.attempts} Builds that did not finish`);

      return;
    }

    const request = { ...pending, attempts: pending.attempts + 1 };

    await this.#deps.save({ ...stored, pending: request });

    // Not awaited: the work outlasts the alarm, and the Container's connection keeps the object in memory meanwhile.
    this.#inflight = this.#run(request).finally(() => {
      this.#inflight = undefined;
    });
  }

  /**
   * Run step `what` of request `run`: `script` on the Container, with `env` beside its own, which must exit 0. Its
   * output when it did. A Test Build cancelled meanwhile runs no step, and its step under way counts as failed.
   */
  async #step(
    run: string,
    what: string,
    script: string,
    timeoutSeconds: number,
    env?: Readonly<Record<string, string>>,
  ): Promise<string> {
    const cancelled = () => {
      if (this.#cancelled === run) throw new Error("The Test Build was cancelled");
    };

    cancelled();

    const ran = await this.#deps.run(script, timeoutSeconds, env);

    cancelled();

    if (ran.exitCode === 0) return ran.output;

    const tail = ran.output.trim().slice(-REPORTED_OUTPUT);
    const status = ran.exitCode === null ? "it did not finish" : `exit ${ran.exitCode}`;

    throw new Error(tail === "" ? `${what} (${status})` : `${what} (${status}): ${tail}`);
  }

  /** Whether the daily look finds nothing to build for: no default branch moved since `last`, which is recent. */
  async #unchanged(
    request: BuildRequest & { readonly id: string },
    last: EnvironmentBuild | null,
  ): Promise<boolean> {
    if (last === null || last.key !== request.key) return false;

    if (this.#deps.now() - last.finishedAt > BUILD_REFRESH_MS) return false;

    const heads = parseCommits(
      await this.#step(
        request.id,
        "Asking the repos' remotes for their default branches failed",
        remoteHeadsScript(request.repos),
        SHORT_STEP_SECONDS,
      ),
    );

    return request.repos.every((repo) => heads[repo.name] === (last.commits[repo.name] ?? null));
  }

  async #run(request: StoredBuilds["pending"] & {}): Promise<void> {
    const deps = this.#deps;
    const started = deps.now();
    const prelude = buildPrelude(request.id);

    const trackingFailed = (cause: unknown) => {
      deps.warn(`idle stop: tracking the Build failed: ${String(cause)}`);
    };

    // Held from the start, so the idle stop never stops the Container midway, and its alarm is armed.
    deps.idle.begin().catch(trackingFailed);

    let outcome: Outcome;

    try {
      const { settings } = resolveContainerSettingsLeniently(request.settings);

      await deps.handOver(buildContainerSettings(settings));

      const last = (await deps.load())?.last ?? null;

      if (request.check === true && (await this.#unchanged(request, last))) {
        outcome = { kind: "unchanged" };
      } else {
        // The snapshot is searched for every one of them, so a Build that cannot show them is not made.
        const held = await deps.secrets();

        if (!held.ok) throw new Error(held.reason);

        const secretEnv = buildSecretEnvironment(held.secrets);

        await this.#mark(request, "building");
        await this.#step(
          request.id,
          "Cloning the repos failed",
          `${prelude}${buildCloneScript(request.repos)}`,
          CLONE_TIMEOUT_SECONDS,
        );

        if (settings.setupScript !== "") {
          await this.#step(
            request.id,
            "The environment's Setup Script failed",
            `${prelude}${environmentSetupScriptRun(settings.setupScript, BUILD_ROOT)}`,
            SETUP_TIMEOUT_SECONDS + SCRIPT_RUN_MARGIN_SECONDS,
            secretEnv,
          );
        }

        for (const repo of request.repos) {
          await this.#step(
            request.id,
            `The Setup Script ${repo.name}/${SETUP_SCRIPT} failed`,
            `${prelude}${setupScriptRunIfDue(`${BUILD_ROOT}/${repo.name}`, SETUP_STATE_DIRECTORY, SETUP_TIMEOUT_SECONDS, BUILD_ROOT)}`,
            SETUP_TIMEOUT_SECONDS + SCRIPT_RUN_MARGIN_SECONDS,
            secretEnv,
          );
        }

        const commits = parseCommits(
          await this.#step(
            request.id,
            "Reading the repos' commits failed",
            buildCommitsScript(request.repos),
            SHORT_STEP_SECONDS,
          ),
        );

        await this.#step(
          request.id,
          "Stopping what the Setup Scripts started failed",
          buildCleanupScript(request.id),
          SHORT_STEP_SECONDS,
        );

        if (this.#cancelled === request.id) throw new Error("The Test Build was cancelled");

        // A Test Build's snapshot is taken too, for its scan; its handle is then dropped (`#finish`).
        const taken = await deps.snapshot();

        if (!taken.ok) throw new Error(`The snapshot was not taken: ${taken.reason}`);

        outcome = {
          kind: "built",
          build: {
            key: request.key,
            snapshot: taken.snapshot,
            image: taken.image,
            ignore: taken.ignore === undefined ? null : [...taken.ignore],
            commits,
            finishedAt: deps.now(),
          },
        };
      }
    } catch (cause) {
      outcome = {
        kind: "failed",
        reason: deps.redact(cause instanceof Error ? cause.message : String(cause)),
      };
    }

    try {
      await deps.stop();
    } catch (cause) {
      deps.warn(`${LOG_KEY}: stopping the Container failed: ${String(cause)}`);
    }

    await deps.idle.end().catch(trackingFailed);

    if (this.#cancelled === request.id) this.#cancelled = undefined;

    const took = deps.now() - started;
    const what = request.test === undefined ? "" : " (a Test Build)";

    switch (outcome.kind) {
      case "built":
        deps.info(
          `${LOG_KEY}: built in ${took} ms${what}, snapshot ${Math.round(outcome.build.snapshot.size / 1e6)} MB`,
        );
        break;
      case "unchanged":
        deps.info(`${LOG_KEY}: no default branch moved; the Build stays`);
        break;
      case "failed":
        deps.warn(`${LOG_KEY}: failed after ${took} ms${what}: ${outcome.reason}`);
        break;
    }

    await this.#finish(request, outcome);
  }

  /** Show the Build of `request` as `status`, unless a newer request replaced it meanwhile. */
  async #mark(
    request: { readonly id: string; readonly key: string; readonly test?: string | undefined },
    status: "building",
  ) {
    // A Test Build shows only in its own state, which says it is under way from its request on.
    if (request.test !== undefined) return;

    const stored = (await this.#deps.load()) ?? NOTHING;

    if (stored.pending?.id !== request.id) return;

    await this.#deps.save({
      ...stored,
      progress: { status, key: request.key, startedAt: this.#deps.now() },
    });
  }

  /**
   * Keep what the Build of `request` came to: a good one replaces the last good one. Its request is done, unless a newer
   * one replaced it meanwhile, which then begins at the next alarm.
   */
  async #finish(
    request: { readonly id: string; readonly key: string; readonly test?: string | undefined },
    outcome: Outcome,
  ): Promise<void> {
    const deps = this.#deps;
    const stored = (await deps.load()) ?? NOTHING;
    const now = deps.now();
    const current = stored.pending?.id === request.id;

    if (request.test !== undefined) {
      // Answered to its call, never kept as the last good Build: its snapshot's handle is dropped here. One cancelled
      // meanwhile stays cancelled.
      const { test } = stored;
      const mine = test?.id === request.test && test.status === "building";

      await deps.save({
        ...stored,
        pending: current ? null : stored.pending,
        test: mine ? testEnded(test, outcome, now) : test,
      });

      if (!current) await deps.wake(now);

      return;
    }

    const last = outcome.kind === "built" ? outcome.build : stored.last;

    await deps.save({
      ...stored,
      last,
      attemptedAt: now,
      pending: current ? null : stored.pending,
      progress: !current
        ? stored.progress
        : outcome.kind === "failed"
          ? { status: "failed", key: request.key, reason: outcome.reason, at: now }
          : null,
    });

    if (!current) await deps.wake(now);
  }
}
