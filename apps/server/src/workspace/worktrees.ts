// The Workspaces' own worktrees on a Machine (docs/spec.md → Workspaces, ADR-0015): made on the Machine's Container when
// a Session first works in one (its Setup Script then run there), removed with the Workspace, and released (removed if
// it holds nothing uncommitted) with its last Session. The scripts are `@cloudpid/sandbox-image/worktrees`'; this runs
// them, and asks the Machine's files first, so a worktree that is there costs no Container.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import * as Arr from "effect/Array";
import { WORKSPACE_ROOT, worktreeDirectory } from "@cloudpid/protocol";
import type { Shell } from "@earendil-works/pi-durable/env";
import {
  SETUP_SCRIPT,
  SETUP_TIMEOUT_SECONDS,
  setupScriptRunIfDue,
} from "@cloudpid/sandbox-image/toolchains";
import {
  prepareWorktreeScript,
  releaseWorktreeScript,
  removeWorktreeScript,
  type Worktree,
  WORKTREE_KEPT,
} from "@cloudpid/sandbox-image/worktrees";
import type { WorkspaceNamespace } from "../session/workspace.ts";
import { computer, isMissing, onContainer } from "./repos.ts";

export type { Worktree };

/** How long making or removing a worktree may take, in seconds: a fetch of a big repo and its checkout, after a cold start. */
export const WORKTREE_TIMEOUT_SECONDS = 10 * 60;

/** How much of a script's output a failure reports, from its end, where the error is. */
const REPORTED_OUTPUT = 2_000;

/** How a script on the Container ended: its exit status (null when it did not run to the end), and its output's end. */
export type ScriptRun = { readonly exitCode: number | null; readonly output: string };

/** What the worktrees of one Machine need: its files, its Container, and somewhere to say what went wrong. */
export type WorktreeHost = {
  /** Whether the Machine's files have `path`. */
  readonly exists: (path: string) => Promise<boolean>;
  /** Run a bash script on the Container, in `/workspace`. */
  readonly run: (script: string, timeoutSeconds: number) => Promise<ScriptRun>;
  readonly warn: (message: string) => void;
};

/** The worktrees of one Machine. */
export type MachineWorktrees = {
  /**
   * Make the worktree unless the Machine's files have it, then run its Setup Script if it is due. Rejects with git's
   * output when the worktree could not be made; a Setup Script that fails is only reported (`warn`), and is due again
   * at the next Container start.
   */
  readonly prepare: (worktree: Worktree) => Promise<void>;
  /** Delete the worktree, uncommitted changes included; its branch stays. Rejects with why when it could not. */
  readonly remove: (worktree: Worktree) => Promise<void>;
  /** Delete the worktree only if it holds nothing uncommitted: whether it is gone. Rejects when it could not tell. */
  readonly release: (worktree: Worktree) => Promise<boolean>;
};

/** Why a script that did not exit 0 failed, in a line with the end of its output. */
const failure = (what: string, ran: ScriptRun): Error => {
  const tail = ran.output.trim().slice(-REPORTED_OUTPUT);
  const status = ran.exitCode === null ? "it did not finish" : `exit ${ran.exitCode}`;

  return new Error(tail === "" ? `${what} (${status})` : `${what} (${status}): ${tail}`);
};

export const worktreesOn = ({ exists, run, warn }: WorktreeHost): MachineWorktrees => ({
  prepare: async (worktree) => {
    const directory = worktreeDirectory(worktree.repo, worktree.id);

    if (await exists(`${directory}/.git`)) return;

    const made = await run(prepareWorktreeScript(worktree), WORKTREE_TIMEOUT_SECONDS);

    if (made.exitCode !== 0) {
      throw failure(`The worktree of branch ${worktree.branch} could not be made`, made);
    }

    const setup = await run(setupScriptRunIfDue(directory), SETUP_TIMEOUT_SECONDS + 60);

    if (setup.exitCode !== 0) {
      warn(
        `${failure(`The Setup Script ${directory}/${SETUP_SCRIPT} failed`, setup).message}. It runs again at the next Container start.`,
      );
    }
  },

  remove: async (worktree) => {
    const removed = await run(removeWorktreeScript(worktree), WORKTREE_TIMEOUT_SECONDS);

    if (removed.exitCode !== 0) {
      throw failure(`The worktree of branch ${worktree.branch} could not be removed`, removed);
    }
  },

  release: async (worktree) => {
    const released = await run(releaseWorktreeScript(worktree), WORKTREE_TIMEOUT_SECONDS);

    if (released.exitCode === 0) return true;

    if (released.exitCode === WORKTREE_KEPT) return false;

    throw failure(`The worktree of branch ${worktree.branch} could not be released`, released);
  },
});

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

/** The worktrees of every Machine whose DO `namespace` holds: files read from the DO, scripts run on its Container. */
export type Worktrees = {
  readonly on: (machine: string) => MachineWorktrees;
};

export const machineWorktrees = (
  namespace: WorkspaceNamespace,
  warn: (message: string) => void,
): Worktrees => ({
  on: (machine) =>
    worktreesOn({
      exists: async (path) => {
        const { ComputerFiles } = await computer();
        const slash = path.lastIndexOf("/");

        try {
          const entries = await new ComputerFiles(namespace.getByName(machine)).readdir(
            path.slice(0, slash),
          );

          return Arr.some(entries, (entry) => entry.name === path.slice(slash + 1));
        } catch (cause) {
          if (isMissing(cause)) return false;

          throw cause;
        }
      },
      run: (script, timeoutSeconds) =>
        onContainer(namespace, machine, (shell) => runScript(shell, script, timeoutSeconds)),
      warn,
    }),
});
