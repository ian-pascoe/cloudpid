// Subagent Workspaces (GLOSSARY.md; `docs/spec.md` → Subagents): a Workspace of the Session's Environment made for one
// subagent, on a branch of its own, with a Container of its own. The Session makes, reads and removes them
// (`SubagentWorkspaces`); this module says what the subagent tools tell the model about them.
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- the hand-back runs in a reporter task's Promise code.
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import type { AgentWorkspace } from "./state.ts";

/** What one clone of a Workspace has not pushed, as the Workspace reads it (`workStateScript`). */
export type RepoWorkState = {
  readonly repo: string;
  /** False for a Repo with no clone there yet. */
  readonly cloned: boolean;
  /** Uncommitted Changes, untracked files that are not ignored included. */
  readonly uncommitted: number;
  /** Commits of the branch that no remote branch has. */
  readonly unpushed: number;
  /** Whether `origin` has the branch, as the clone last saw it. */
  readonly onRemote: boolean;
};

/** A Subagent Workspace asked for at a spawn. */
export type SubagentWorkspaceRequest = {
  /** The canonical ID of the subagent it is for. */
  readonly agent: string;
  /** The Subagent Workspace the spawner works in, or null for the Session's Workspace. */
  readonly parent: AgentWorkspace | null;
  /** The remote branch to start from; the spawner's Workspace's branch when undefined. */
  readonly base: string | undefined;
  /** The subagent's own branch; `cloudpid/<id>` when undefined. */
  readonly branch: string | undefined;
  /** How many Subagent Workspaces the Session may have at once (the Subagent Workspace limit). */
  readonly limit: number;
};

/** A Subagent Workspace made, and what the spawner should know: unpushed work of its own that does not reach it. */
export type SubagentWorkspaceMade = {
  readonly workspace: AgentWorkspace;
  readonly warnings: ReadonlyArray<string>;
};

/**
 * The Session's Subagent Workspaces. `create` rejects with an `Error` whose message is the refusal the model is shown
 * (the limit, a Session the Registry does not list, a branch another Workspace is on); the subagent it names has the
 * same one again when it is asked twice, so a spawn run again after an eviction makes no other.
 */
export interface SubagentWorkspaceHost {
  create(request: SubagentWorkspaceRequest): Promise<SubagentWorkspaceMade>;
  /** What the Workspace's clones have not pushed of its branch; runs on its Container, starting it if needed. */
  workState(workspace: AgentWorkspace): Promise<ReadonlyArray<RepoWorkState>>;
  /** Remove the Workspace (its Container, files and record): Workspace removal. */
  remove(workspace: AgentWorkspace): Promise<void>;
}

/** The Session's Subagent Workspaces; a host without them refuses `workspace: "new"`. */
export class SubagentWorkspaces extends Context.Service<
  SubagentWorkspaces,
  SubagentWorkspaceHost
>()("@cloudpid/extensions/subagents/workspaces/SubagentWorkspaces") {}

/** The default Subagent Workspace limit (GLOSSARY.md → Limit): Subagent Workspaces one Session may have at once. */
export const DEFAULT_MAX_SUBAGENT_WORKSPACES = 3;

/** The Repos that hold work not pushed: uncommitted Changes, or commits no remote branch has. */
export const unpushedWork = (states: ReadonlyArray<RepoWorkState>): RepoWorkState[] =>
  Arr.filter(states, (state) => state.cloned && (state.uncommitted > 0 || state.unpushed > 0));

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One Repo's work not pushed, in words: `app: 2 commits not pushed, 1 uncommitted change`. */
export const describeRepoWork = (state: RepoWorkState): string =>
  `${state.repo}: ${Arr.join(
    [
      ...(state.unpushed > 0
        ? [count(state.unpushed, "commit not pushed", "commits not pushed")]
        : []),
      ...(state.uncommitted > 0
        ? [count(state.uncommitted, "uncommitted change", "uncommitted changes")]
        : []),
    ],
    ", ",
  )}`;

/** What a Workspace has not pushed, in words, or that everything is pushed. */
export const describeWork = (states: ReadonlyArray<RepoWorkState>): string => {
  const pending = unpushedWork(states);

  return pending.length === 0
    ? "everything is committed and pushed"
    : Arr.join(Arr.map(pending, describeRepoWork), "; ");
};

/** The line a Subagent Workspace's report ends with: its branch, and what it has not pushed. */
export const handBackText = (
  workspace: AgentWorkspace,
  states: ReadonlyArray<RepoWorkState> | Error,
): string =>
  `[Subagent Workspace ${workspace.id} | branch ${workspace.branch} | ${
    states instanceof Error
      ? `what is not pushed could not be read: ${states.message}`
      : describeWork(states)
  }]`;

/** What the Workspace has not pushed, read now, as the line its report ends with; a read that fails says so. */
export const handBackLine = async (
  host: SubagentWorkspaceHost,
  workspace: AgentWorkspace,
): Promise<string> => {
  try {
    return handBackText(workspace, await host.workState(workspace));
  } catch (error) {
    return handBackText(workspace, error instanceof Error ? error : new Error(String(error)));
  }
};

/**
 * What a child with a Workspace of its own is told in its first input: where it works, that its parent sees its work
 * only through the remote, and to push its branch.
 */
export const workspacePreamble = (workspace: AgentWorkspace): string =>
  Arr.join(
    [
      `You work in a Workspace of your own (${workspace.id}), with its own files and Container, on the branch ${workspace.branch}.`,
      "Your parent cannot see your files: it sees your work only through the remote.",
      `Commit your work and push ${workspace.branch} (git push -u origin ${workspace.branch}) before you answer.`,
    ],
    " ",
  );
