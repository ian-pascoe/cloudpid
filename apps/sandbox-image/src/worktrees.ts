// A Workspace's own worktree on the Container (docs/spec.md → Workspaces, ADR-0015): a git worktree of a Repo at
// `<root>/.worktrees/<repo>/<id>` on the Workspace's branch, made when a Session first works in it, and removed with the
// Workspace (or with its last Session, when it holds no uncommitted changes). The branch outlives the worktree, so a
// Workspace whose worktree was removed is made again from it. These are bash scripts the Container runs, with real git.
// @effect-diagnostics missingPipeableSignature:off
import {
  SETUP_STATE_DIRECTORY,
  SETUP_TIMEOUT_SECONDS,
  setupRecord,
  setupRecordName,
  setupScriptRunIfDue,
  shellQuote,
  WORKSPACE_ROOT,
  WORKTREES_DIRECTORY,
} from "./toolchains.ts";

/** A Workspace's worktree: its Repo (a directory name below the root), its id and its branch. */
export type Worktree = { readonly repo: string; readonly id: string; readonly branch: string };

/** Where the worktree of Workspace `id` of Repo `repo` is. */
export const worktreePath = (repo: string, id: string, root: string = WORKSPACE_ROOT): string =>
  `${root}/${WORKTREES_DIRECTORY}/${repo}/${id}`;

/** The exit status of `releaseWorktreeScript` when the worktree has uncommitted changes, and was kept. */
export const WORKTREE_KEPT = 3;

/** The variables every script starts with: the Repo's main checkout, the worktree and its Setup Script's record. */
const preamble = (worktree: Worktree, root: string, state: string): string => {
  const dir = worktreePath(worktree.repo, worktree.id, root);

  return `set -u -o pipefail
repo=${shellQuote(`${root}/${worktree.repo}`)}
dir=${shellQuote(dir)}
branch=${shellQuote(worktree.branch)}
record=${shellQuote(setupRecord(setupRecordName(dir, root), state))}
`;
};

/**
 * Take a lock of the worktree's own (`flock`, where the Container has it), so two Sessions that start in the Workspace
 * at once do not both make it: the second finds it made.
 */
const locked = (worktree: Worktree, what = "worktree"): string => `
if command -v flock >/dev/null 2>&1; then
  exec 9>${shellQuote(`/tmp/cloudpid-${what}-${worktree.repo}-${worktree.id}.lock`)}
  flock 9
fi
`;

/**
 * The bash script that runs the worktree's Setup Script if it is due (`setupScriptRunIfDue`), under a lock of its own
 * (not the worktree's, which a removal takes): of two Sessions that made the worktree at once, the second waits for the
 * first's run, then finds the script done.
 */
export const worktreeSetupScript = (
  worktree: Worktree,
  root: string = WORKSPACE_ROOT,
  state: string = SETUP_STATE_DIRECTORY,
  timeoutSeconds: number = SETUP_TIMEOUT_SECONDS,
): string =>
  `${locked(worktree, "setup")}${setupScriptRunIfDue(worktreePath(worktree.repo, worktree.id, root), state, timeoutSeconds, root)}`;

/**
 * The bash script that makes the worktree unless it is there. The branch is checked out when the Repo has it, tracked
 * from `origin` when only the remote has it, and otherwise made from the remote's default branch (fetched first), or
 * from the main checkout's HEAD when there is no remote. A worktree git knows whose `.git` file is gone is repaired; a
 * directory git does not know (what a removal left) is cleared first, with its Setup Script's record, so the script
 * runs again in the new worktree.
 */
export const prepareWorktreeScript = (
  worktree: Worktree,
  root: string = WORKSPACE_ROOT,
  state: string = SETUP_STATE_DIRECTORY,
): string => `${preamble(worktree, root, state)}${locked(worktree)}
[ -e "$dir/.git" ] && exit 0
cd "$repo" || exit 1
# A worktree git still knows whose .git file is gone is repaired, its changes kept; never cleared.
if [ -e "$dir" ] && git worktree list --porcelain | grep -qxF "worktree $dir"; then
  git worktree repair "$dir" >/dev/null 2>&1
  [ -e "$dir/.git" ] && exit 0
  echo "cloudpid: $dir is a worktree git cannot repair; move what it holds away, or remove the workspace" >&2
  exit 1
fi
rm -rf -- "$dir" "$record"
git worktree prune
mkdir -p -- "\${dir%/*}" || exit 1
if git show-ref --verify --quiet "refs/heads/$branch"; then
  git worktree add "$dir" "$branch"
else
  git fetch --quiet origin 2>/dev/null || echo "cloudpid: could not fetch origin; the worktree starts from what the Repo has" >&2
  if git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    git worktree add --track -b "$branch" "$dir" "origin/$branch"
  else
    # Older gits do not learn the remote's default branch from a fetch: ask the remote.
    git symbolic-ref --quiet refs/remotes/origin/HEAD >/dev/null 2>&1 || git remote set-head origin --auto >/dev/null 2>&1
    base=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) || base=HEAD
    git worktree add --no-track -b "$branch" "$dir" "$base"
  fi
fi
`;

/** The part of a script that deletes the worktree and its Setup Script's record, keeping the branch. */
const removal = `
if [ -e "$repo/.git" ]; then
  git -C "$repo" worktree remove --force --force "$dir" 2>/dev/null
fi
rm -rf -- "$dir" "$record"
if [ -e "$repo/.git" ]; then git -C "$repo" worktree prune; fi
[ ! -e "$dir" ]
`;

/**
 * The bash script that deletes the worktree, uncommitted changes and what only the Container held there (its
 * dependency directories) included, with its Setup Script's record. The branch and its commits stay in the Repo.
 */
export const removeWorktreeScript = (
  worktree: Worktree,
  root: string = WORKSPACE_ROOT,
  state: string = SETUP_STATE_DIRECTORY,
): string => `${preamble(worktree, root, state)}${locked(worktree)}${removal}`;

/**
 * The bash script that deletes the worktree as `removeWorktreeScript` does, only when `git status` shows nothing in it:
 * no change to a tracked file and no untracked file (ignored ones, such as dependencies, do not count). It exits with
 * `WORKTREE_KEPT` and keeps everything otherwise. A worktree that is not there is released already.
 */
export const releaseWorktreeScript = (
  worktree: Worktree,
  root: string = WORKSPACE_ROOT,
  state: string = SETUP_STATE_DIRECTORY,
): string => `${preamble(worktree, root, state)}${locked(worktree)}
[ -e "$dir/.git" ] || exit 0
changes=$(git -C "$dir" status --porcelain) || exit 1
[ -z "$changes" ] || exit ${WORKTREE_KEPT}
${removal}`;
