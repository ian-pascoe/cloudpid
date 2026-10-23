// A Workspace's set-up (docs/spec.md → Workspaces, ADR-0016): when a Session first works in it, and at most once a
// minute after, the Session readies its Workspace: the Environment's Container settings are handed to the Workspace's
// Durable Object (its Worker cannot reach the Registry), and each Repo the Workspace's files lack is cloned on its
// Container, on the Workspace's branch, then its Setup Script and its Start Script run. A clone made while the Workspace
// was its Environment's spare is on `SPARE_BRANCH` until then, and is switched to the Workspace's branch. A spare
// Workspace's Durable Object readies itself the same way (`spare.ts`). The scripts are
// `@cloudpid/sandbox-image/workspaces`'; this runs them, and reads the Workspace's files first, so a Workspace whose
// clones are there, on its branch, costs no Container.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off
import { ContainerSettings, resolveContainerSettingsLeniently } from "@cloudpid/config";
import { repoDirectory, SPARE_BRANCH, WORKSPACE_ROOT } from "@cloudpid/protocol/repo";
import {
  SETUP_SCRIPT,
  SETUP_TIMEOUT_SECONDS,
  START_SCRIPT,
  START_TIMEOUT_SECONDS,
} from "@cloudpid/sandbox-image/toolchains";
import {
  prepareWorkspaceScript,
  repoSetupScript,
  repoStartScript,
  type WorkspaceClones,
} from "@cloudpid/sandbox-image/workspaces";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ComputerWorkspaceStub } from "@cloudpid/computer-env";
import type { KeptSecret } from "@cloudpid/extensions/secrets/core";
import type { Shell } from "@earendil-works/pi-durable/env";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import type { WorkspaceNamespace } from "../session/workspace.ts";
import type { EnvironmentBuild } from "./build-record.ts";
import { buildSecretEnvironment } from "./environment-secrets.ts";
import type { WorkspaceSettingsAnswer, WriteAnswer } from "./settings.ts";

/**
 * What a Workspace is readied with: its clones' Repos, branch and base, its Environment's Container settings, and its
 * Environment's Build.
 */
export type WorkspaceSetup = WorkspaceClones & {
  /** The Environment's Container settings overrides, which the Workspace applies at its next launch. */
  readonly settings: Schema.Json;
  /**
   * The Environment's last good Build, which the Workspace's next launch with no snapshot of its own starts from; null
   * for none yet. Absent, the Workspace keeps the one it holds.
   */
  readonly build?: EnvironmentBuild | null | undefined;
  /**
   * The Environment's kept Secrets, opened by the Registry, which the Workspace keeps sealed to search its snapshots for
   * and take out of output. Absent (a spare's stored set-up), it keeps those it holds. Never stored with the set-up.
   */
  readonly secrets?: ReadonlyArray<KeptSecret> | undefined;
  /**
   * Why the Registry could not open the Environment's Secrets (a fixed reason, never a value), in place of `secrets`:
   * the Workspace then keeps a copy it cannot show, so its snapshots and Builds are refused until a handover brings
   * them.
   */
  readonly secretsUnavailable?: string | undefined;
};

/** How long cloning a Workspace's Repos may take, in seconds: full clones of big repos, after a cold start. */
export const CLONE_TIMEOUT_SECONDS = 15 * 60;

/**
 * How much longer than a Setup or Start Script's own limit a run of it may take: time for the script's stop
 * (`timeout --kill-after`) and for the result to come back, with room for a lock another Session's run holds.
 */
export const SCRIPT_RUN_MARGIN_SECONDS = 120;

/** How much of a script's output a failure reports, from its end, where the error is. */
const REPORTED_OUTPUT = 2_000;

/** How a script on the Container ended: its exit status (null when it did not run to the end), and its output's end. */
export type ScriptRun = { readonly exitCode: number | null; readonly output: string };

/** What readying one Workspace needs: its files, its Container, its settings, and somewhere to say what went wrong. */
export type PreparationHost = {
  /** The text of the Workspace's file at `path`, or null when its files do not have it. */
  readonly readText: (path: string) => Promise<string | null>;
  /** Run a bash script on the Container, in `/workspace`, with `env` beside the Container's own. */
  readonly run: (
    script: string,
    timeoutSeconds: number,
    env?: Readonly<Record<string, string>>,
  ) => Promise<ScriptRun>;
  /** The Container settings the Workspace's Durable Object holds, and a write of new ones. */
  readonly settings: {
    readonly read: () => Promise<WorkspaceSettingsAnswer>;
    readonly write: (overrides: Schema.Json) => Promise<WriteAnswer>;
  };
  /** The Environment's Build the Workspace's Durable Object holds, and a write of another (null: none). */
  readonly build: {
    readonly read: () => Promise<EnvironmentBuild | null>;
    readonly write: (build: EnvironmentBuild | null) => Promise<void>;
  };
  /**
   * Hand the Workspace's Durable Object its Environment's Secrets, in place of those it holds, or why there are none
   * it can show (`WorkspaceSetup.secretsUnavailable`).
   */
  readonly secrets: {
    readonly write: (secrets: ReadonlyArray<KeptSecret>) => Promise<void>;
    readonly unavailable: (reason: string) => Promise<void>;
    /**
     * The copy the Workspace's Durable Object holds, for a set-up that carries none (a spare's stored one): what its
     * Setup Scripts get. Without it, such a set-up's get none.
     */
    readonly read?: (() => Promise<ReadonlyArray<KeptSecret>>) | undefined;
  };
  readonly warn: (message: string) => void;
};

/** Why a script that did not exit 0 failed, in a line with the end of its output. */
const failure = (what: string, ran: ScriptRun): Error => {
  const tail = ran.output.trim().slice(-REPORTED_OUTPUT);
  const status = ran.exitCode === null ? "it did not finish" : `exit ${ran.exitCode}`;

  return new Error(tail === "" ? `${what} (${status})` : `${what} (${status}): ${tail}`);
};

const sameSettings = Schema.toEquivalence(ContainerSettings);

/** Whether two sets of Container settings overrides give the same settings. */
const sameOverrides = (left: Schema.Json, right: Schema.Json): boolean =>
  sameSettings(
    resolveContainerSettingsLeniently(left).settings,
    resolveContainerSettingsLeniently(right).settings,
  );

/** What a clone's `.git/HEAD` holds while it is on the spare Workspace's placeholder branch. */
const SPARE_HEAD = `ref: refs/heads/${SPARE_BRANCH}`;

/** Whether two Builds (or none) are the same one. */
const sameBuild = (left: EnvironmentBuild | null, right: EnvironmentBuild | null): boolean =>
  left?.snapshot.id === right?.snapshot.id && left?.key === right?.key;

/**
 * Ready the Workspace `host` reaches with `setup`: its Durable Object gets the Environment's Container settings and Build
 * when they differ from what it holds (before any Container starts, so its first launch can start from the Build), and
 * each Repo its files lack is cloned on the Container, and each clone whose
 * `.git/HEAD` is on `SPARE_BRANCH` (the Workspace was a spare) switched to the Workspace's branch; then each of those
 * has its Setup Script run if it is due (a switch that moved the commit makes it due), and its Start Script if it is
 * flagged (the Container is running already, so its bootstrap did not see the clone, or saw the spare's). Rejects with
 * git's output when a Repo could not be cloned or switched (the others still are); a settings write the Workspace
 * refuses, or a Setup or Start Script that fails, is only reported (`warn`): the Workspace is there to work in, and
 * the script runs again at the next Container start. `onHandedOver` is called once the Secrets, settings and Build are
 * the Workspace's, before the clones: what needs no Container is done, so a Container may start (the early start).
 */
export const prepareWorkspace = async (
  { readText, run, settings, build, secrets, warn }: PreparationHost,
  setup: WorkspaceSetup,
  onHandedOver: () => void = () => undefined,
): Promise<void> => {
  // First, so the snapshot of any Container this readying starts is searched for them.
  if (setup.secrets !== undefined) await secrets.write(setup.secrets);
  else if (setup.secretsUnavailable !== undefined) {
    await secrets.unavailable(setup.secretsUnavailable);
  }

  const held = await settings.read();

  if (!sameOverrides(held.overrides, setup.settings)) {
    const written = await settings.write(setup.settings);

    if (!written.ok) warn(`The Workspace refused its Environment's settings: ${written.message}`);
  }

  if (setup.build !== undefined && !sameBuild(await build.read(), setup.build)) {
    await build.write(setup.build);
  }

  onHandedOver();

  // A clone that is there has a `.git/HEAD`; the spare's own clones stay on its branch.
  const missing = Arr.filter(
    await Promise.all(
      Arr.map(setup.repos, async (repo) => {
        const head = await readText(`${repoDirectory(repo.name)}/.git/HEAD`);

        return head === null || (setup.branch !== SPARE_BRANCH && head.trim() === SPARE_HEAD)
          ? repo
          : undefined;
      }),
    ),
    (repo) => repo !== undefined,
  );

  if (missing.length === 0) return;

  const cloned = await run(
    prepareWorkspaceScript({
      repos: missing,
      branch: setup.branch,
      base: setup.base,
      spare: SPARE_BRANCH,
    }),
    CLONE_TIMEOUT_SECONDS,
  );

  // The Setup Scripts get the Secrets marked for the Build, as the bootstrap's do: the Workspace holds what was handed.
  const setupEnv = buildSecretEnvironment(
    setup.secrets ??
      (setup.secretsUnavailable === undefined ? ((await secrets.read?.()) ?? []) : []),
  );

  // Each clone that was made is set up, whatever became of the others: the next readying clones only what is missing.
  for (const repo of missing) {
    // Another Session's run of it is waited for: the lock is held for the script's time.
    const ran = await run(
      repoSetupScript(repo.name),
      SETUP_TIMEOUT_SECONDS + SCRIPT_RUN_MARGIN_SECONDS,
      setupEnv,
    );

    if (ran.exitCode !== 0) {
      warn(
        `${failure(`The Setup Script ${repoDirectory(repo.name)}/${SETUP_SCRIPT} failed`, ran).message}. It runs again at the next Container start.`,
      );
    }

    const started = await run(
      repoStartScript(repo.name),
      START_TIMEOUT_SECONDS + SCRIPT_RUN_MARGIN_SECONDS,
    );

    if (started.exitCode !== 0) {
      warn(
        `${failure(`The Start Script ${repoDirectory(repo.name)}/${START_SCRIPT} failed`, started).message}. It runs again at the next Container start.`,
      );
    }
  }

  if (cloned.exitCode !== 0) {
    throw failure(
      `The Workspace's repos could not all be cloned on, or switched to, branch ${setup.branch}`,
      cloned,
    );
  }
};

/** Run `script` in bash through `shell` (the Container's), in `/workspace`; how it ended. Never throws. */
export const runScript = async (
  shell: Pick<Shell, "exec">,
  script: string,
  timeoutSeconds: number,
  env: Readonly<Record<string, string>> = {},
): Promise<ScriptRun> => {
  let output = "";

  const result = await shell.exec(
    ["bash", "-c", script],
    {
      cwd: WORKSPACE_ROOT,
      timeout: timeoutSeconds,
      // Beside the Container's own (`toolchainEnv`), which the Container's backend puts under it.
      env: { ...env },
      onOutput: (text) => {
        output = (output + text).slice(-REPORTED_OUTPUT * 2);
      },
    },
    BACKGROUND_CONTEXT,
  );

  if (!result.ok) {
    return {
      exitCode: null,
      output:
        result.error.code === "timeout"
          ? `it ran past ${timeoutSeconds / 60} minutes`
          : result.error.message,
    };
  }

  return { exitCode: result.value.exitCode, output };
};

/**
 * `@cloudpid/computer-env` loads on first use. `@cloudflare/computer` imports `cloudflare:workers`, which Node cannot
 * load, and the deploy loads the Server's module graph, this file included, in Node.
 */
export const computer = () => import("@cloudpid/computer-env");

/**
 * The `PreparationHost` of the Workspace whose Durable Object `workspace` reaches (a stub, or the object itself), whose
 * environment is `id`: its files read through `ComputerExecutionEnv`, each script run on its Container in a call of
 * its own, cleaned up after it.
 */
export const preparationHost = (
  workspace: ComputerWorkspaceStub,
  id: string,
  settings: PreparationHost["settings"],
  build: PreparationHost["build"],
  secrets: PreparationHost["secrets"],
  warn: (message: string) => void,
): PreparationHost => {
  const env = async () => {
    const { ComputerExecutionEnv } = await computer();

    return new ComputerExecutionEnv({ workspace, id, cwd: WORKSPACE_ROOT });
  };

  return {
    readText: async (path) => {
      const read = await (await env()).readTextFile(path, BACKGROUND_CONTEXT);

      if (read.ok) return read.value;

      if (read.error.code === "not_found" || read.error.code === "not_directory") return null;

      throw read.error;
    },
    run: async (script, timeoutSeconds, scriptEnv) => {
      const container = (await env()).onBackend("container");

      try {
        return await runScript(container, script, timeoutSeconds, scriptEnv);
      } finally {
        await container.cleanup(BACKGROUND_CONTEXT);
      }
    },
    settings,
    build,
    secrets,
    warn,
  };
};

/**
 * Ready the Workspaces of DO `namespace`, by object name (`workspaceObjectName`): files read from the DO, scripts run
 * on its Container. What goes wrong in a Setup Script is told to `warn`.
 */
export const workspacePreparation =
  (namespace: WorkspaceNamespace, warn: (message: string) => void) =>
  (objectName: string, setup: WorkspaceSetup, onHandedOver?: () => void): Promise<void> =>
    prepareWorkspace(
      preparationHost(
        namespace.getByName(objectName),
        // The id the Session's environment has, so both see the same files.
        `computer:${objectName}`,
        {
          read: () => namespace.getByName(objectName).containerSettings(),
          write: (overrides) => namespace.getByName(objectName).updateContainerSettings(overrides),
        },
        {
          read: () => namespace.getByName(objectName).environmentBuild(),
          write: (build) => namespace.getByName(objectName).updateEnvironmentBuild(build),
        },
        {
          write: (secrets) => namespace.getByName(objectName).updateEnvironmentSecrets(secrets),
          unavailable: (reason) =>
            namespace.getByName(objectName).environmentSecretsUnavailable(reason),
        },
        warn,
      ),
      setup,
      onHandedOver,
    );
