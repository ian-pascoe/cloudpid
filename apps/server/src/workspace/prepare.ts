// A Workspace's set-up (docs/spec.md → Workspaces, ADR-0016): when a Session first works in it, and at most once a
// minute after, the Session readies its Workspace: the Environment's Container settings are handed to the Workspace's
// Durable Object (its Worker cannot reach the Registry), and each Repo the Workspace's files lack is cloned on its
// Container, on the Workspace's branch, then its Setup Script run. The scripts are `@cloudpid/sandbox-image/workspaces`';
// this runs them, and asks the Workspace's files first, so a Workspace whose clones are there costs no Container.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off
import { ContainerSettings, resolveContainerSettingsLeniently } from "@cloudpid/config";
import { repoDirectory, WORKSPACE_ROOT } from "@cloudpid/protocol";
import { SETUP_SCRIPT, SETUP_TIMEOUT_SECONDS } from "@cloudpid/sandbox-image/toolchains";
import {
  prepareWorkspaceScript,
  repoSetupScript,
  type WorkspaceClones,
} from "@cloudpid/sandbox-image/workspaces";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Shell } from "@earendil-works/pi-durable/env";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import type { WorkspaceNamespace } from "../session/workspace.ts";
import type { WorkspaceSettingsAnswer, WriteAnswer } from "./settings.ts";

/** What a Workspace is readied with: its clones' Repos, branch and base, and its Environment's Container settings. */
export type WorkspaceSetup = WorkspaceClones & {
  /** The Environment's Container settings overrides, which the Workspace applies at its next launch. */
  readonly settings: Schema.Json;
};

/** How long cloning a Workspace's Repos may take, in seconds: full clones of big repos, after a cold start. */
export const CLONE_TIMEOUT_SECONDS = 15 * 60;

/** How much of a script's output a failure reports, from its end, where the error is. */
const REPORTED_OUTPUT = 2_000;

/** How a script on the Container ended: its exit status (null when it did not run to the end), and its output's end. */
export type ScriptRun = { readonly exitCode: number | null; readonly output: string };

/** What readying one Workspace needs: its files, its Container, its settings, and somewhere to say what went wrong. */
export type PreparationHost = {
  /** Whether the Workspace's files have `path`. */
  readonly exists: (path: string) => Promise<boolean>;
  /** Run a bash script on the Container, in `/workspace`. */
  readonly run: (script: string, timeoutSeconds: number) => Promise<ScriptRun>;
  /** The Container settings the Workspace's Durable Object holds, and a write of new ones. */
  readonly settings: {
    readonly read: () => Promise<WorkspaceSettingsAnswer>;
    readonly write: (overrides: Schema.Json) => Promise<WriteAnswer>;
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

/**
 * Ready the Workspace `host` reaches with `setup`: its Durable Object gets the Environment's Container settings when
 * they differ from what it holds, and each Repo its files lack is cloned on the Container, then has its Setup Script
 * run if it is due. Rejects with git's output when a Repo could not be cloned (the others still are); a settings write
 * the Workspace refuses, or a Setup Script that fails, is only reported (`warn`): the Workspace is there to work in,
 * and the script is due again at the next Container start.
 */
export const prepareWorkspace = async (
  { exists, run, settings, warn }: PreparationHost,
  setup: WorkspaceSetup,
): Promise<void> => {
  const held = await settings.read();

  if (!sameOverrides(held.overrides, setup.settings)) {
    const written = await settings.write(setup.settings);

    if (!written.ok) warn(`The Workspace refused its Environment's settings: ${written.message}`);
  }

  const missing = Arr.filter(
    await Promise.all(
      Arr.map(setup.repos, async (repo) =>
        (await exists(`${repoDirectory(repo.name)}/.git`)) ? undefined : repo,
      ),
    ),
    (repo) => repo !== undefined,
  );

  if (missing.length === 0) return;

  const cloned = await run(
    prepareWorkspaceScript({ repos: missing, branch: setup.branch, base: setup.base }),
    CLONE_TIMEOUT_SECONDS,
  );

  // Each clone that was made is set up, whatever became of the others: the next readying clones only what is missing.
  for (const repo of missing) {
    // Another Session's run of it is waited for: the lock is held for the script's time.
    const ran = await run(repoSetupScript(repo.name), SETUP_TIMEOUT_SECONDS + 120);

    if (ran.exitCode !== 0) {
      warn(
        `${failure(`The Setup Script ${repoDirectory(repo.name)}/${SETUP_SCRIPT} failed`, ran).message}. It runs again at the next Container start.`,
      );
    }
  }

  if (cloned.exitCode !== 0) {
    throw failure(
      `The Workspace's repos could not all be cloned on branch ${setup.branch}`,
      cloned,
    );
  }
};

/** Run `script` in bash through `shell` (the Container's), in `/workspace`; how it ended. Never throws. */
export const runScript = async (
  shell: Pick<Shell, "exec">,
  script: string,
  timeoutSeconds: number,
): Promise<ScriptRun> => {
  let output = "";

  const result = await shell.exec(
    ["bash", "-c", script],
    {
      cwd: WORKSPACE_ROOT,
      timeout: timeoutSeconds,
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
 * Whether `cause` says a path is not there (or is not a directory). The Workspace DO's error reaches here over RPC,
 * which may keep only its message, so the POSIX code is read from the error and, failing that, from the message.
 */
export const isMissing = (cause: unknown): boolean => {
  if (!(cause instanceof Error)) return false;

  const code = "code" in cause ? String(cause.code) : "";

  return (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    /\b(ENOENT|ENOTDIR)\b|no such file/i.test(cause.message)
  );
};

/**
 * `@cloudpid/computer-env` loads on first use. `@cloudflare/computer` imports `cloudflare:workers`, which Node cannot
 * load, and the deploy loads the Server's module graph, this file included, in Node.
 */
export const computer = () => import("@cloudpid/computer-env");

/** The Container's shell of the Workspace whose object is `objectName`, for one call, cleaned up after it. */
export const onContainer = async <A>(
  namespace: WorkspaceNamespace,
  objectName: string,
  run: (shell: Pick<Shell, "exec">) => Promise<A>,
): Promise<A> => {
  const { ComputerExecutionEnv } = await computer();

  const container = new ComputerExecutionEnv({
    workspace: namespace.getByName(objectName),
    // The id the Session's environment has, so both see the same files.
    id: `computer:${objectName}`,
    cwd: WORKSPACE_ROOT,
  }).onBackend("container");

  try {
    return await run(container);
  } finally {
    await container.cleanup(BACKGROUND_CONTEXT);
  }
};

/**
 * Ready the Workspaces of DO `namespace`, by object name (`workspaceObjectName`): files read from the DO, scripts run
 * on its Container. What goes wrong in a Setup Script is told to `warn`.
 */
export const workspacePreparation =
  (namespace: WorkspaceNamespace, warn: (message: string) => void) =>
  (objectName: string, setup: WorkspaceSetup): Promise<void> =>
    prepareWorkspace(
      {
        exists: async (path) => {
          const { ComputerFiles } = await computer();
          const slash = path.lastIndexOf("/");

          try {
            const entries = await new ComputerFiles(namespace.getByName(objectName)).readdir(
              path.slice(0, slash),
            );

            return Arr.some(entries, (entry) => entry.name === path.slice(slash + 1));
          } catch (cause) {
            if (isMissing(cause)) return false;

            throw cause;
          }
        },
        run: (script, timeoutSeconds) =>
          onContainer(namespace, objectName, (shell) => runScript(shell, script, timeoutSeconds)),
        settings: {
          read: () => namespace.getByName(objectName).containerSettings(),
          write: (overrides) => namespace.getByName(objectName).updateContainerSettings(overrides),
        },
        warn,
      },
      setup,
    );
