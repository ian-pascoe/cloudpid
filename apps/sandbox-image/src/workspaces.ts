// A Workspace's clones on its Container (docs/spec.md → Workspaces, ADR-0016): one full clone of each of its
// Environment's Repos at `<root>/<repo>`, all on the Workspace's branch, made when a Session first works in it, or ahead
// of it on a spare Workspace's placeholder branch and switched when a Session takes the spare. These are bash scripts the
// Container runs, with real git.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import {
  HAS_MISE_CONFIG,
  SETUP_STATE_DIRECTORY,
  SETUP_TIMEOUT_SECONDS,
  setupScriptRunIfDue,
  shellQuote,
  START_TIMEOUT_SECONDS,
  startScriptRunIfThere,
  WORKSPACE_ROOT,
} from "./toolchains.ts";

/** A Repo a Workspace clones: the address, and the directory below the root it is cloned into. */
export type WorkspaceRepo = { readonly name: string; readonly url: string };

/** What a Workspace's clones are made from: its Repos, its branch, and the branch a new one starts from (null: each Repo's default). */
export type WorkspaceClones = {
  readonly repos: ReadonlyArray<WorkspaceRepo>;
  readonly branch: string;
  readonly base: string | null;
  /**
   * The placeholder branch of a spare Workspace (`SPARE_BRANCH` in `@cloudpid/protocol`): a clone found on it, made
   * while the Workspace was a spare, is switched to `branch` when that is another. Absent, clones that are there are left
   * alone.
   */
  readonly spare?: string | undefined;
};

/**
 * Take the Workspace's lock (`flock`, where the Container has it), so two Sessions that start in the Workspace at once
 * do not both clone: the second finds the clones made.
 */
const locked = (what: string): string => `
if command -v flock >/dev/null 2>&1; then
  exec 9>${shellQuote(`/tmp/cloudpid-${what}.lock`)}
  flock 9
fi
`;

/**
 * Where each new clone under `root` leaves a flag of its name on the Container's disk, outside the Workspace, until its
 * Start Script has been run once (`repoStartScript`): of two Sessions that made the clone at once, only one runs it.
 */
const startDueDirectory = (root: string): string => `/tmp/cloudpid-start-due${root}`;

/**
 * The bash script that clones each of the Workspace's Repos that is not there yet. Each clone is full (switching
 * branches later fetches nothing), made beside the root's repos and moved into place once its branch is checked out.
 * The branch is tracked from `origin` when the remote has it, and otherwise made from `base` (which the remote must
 * have) or from the remote's default branch. git's hooks are off while it runs, and `SKIP_REFERENCE_REPOS` is set, so
 * a Repo's own checkout hooks (installs, reference clones) do not run before its Setup Script does. Then `mise install`
 * runs in each new clone that declares Toolchains, since the bootstrap ran before it was there, and the clone is flagged
 * for its Start Script (`repoStartScript`). A Repo that fails is
 * reported and the others are still made; the script exits 1 when any failed.
 *
 * A clone that is there on `clones.spare` (made while the Workspace was a spare) is switched to the branch instead,
 * under its own lock too, so a Setup or Start Script of the spare's that still runs is waited for: `origin` is fetched,
 * the branch is checked out as a clone's would be, and the spare's branch is deleted. When that moved the commit, the
 * clone's Setup Script record is removed (`state`), so it is due again, and the clone is flagged for its Start Script
 * and gets `mise install`, as a new clone does.
 */
export const prepareWorkspaceScript = (
  clones: WorkspaceClones,
  root: string = WORKSPACE_ROOT,
  /** The transports git may use (`GIT_ALLOW_PROTOCOL`), whatever a URL or a redirect asks for. */
  protocols: string = "https",
  state: string = SETUP_STATE_DIRECTORY,
): string => `set -u -o pipefail
export SKIP_REFERENCE_REPOS=1 GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=${shellQuote(protocols)}
root=${shellQuote(root)}
branch=${shellQuote(clones.branch)}
base=${shellQuote(clones.base ?? "")}
spare=${shellQuote(clones.spare ?? "")}
state=${shellQuote(state)}
start_due=${shellQuote(startDueDirectory(root))}
${locked("workspace")}
${HAS_MISE_CONFIG}
nohooks() { git -c core.hooksPath=/dev/null "$@"; }

# on_spare <dir>: whether the clone at <dir> is on the spare's branch, to switch to $branch.
on_spare() {
  [ -n "$spare" ] && [ "$branch" != "$spare" ] &&
    [ "$(git -C "$1" symbolic-ref --quiet HEAD 2>/dev/null)" = "refs/heads/$spare" ]
}

# switch_from_spare <name>: the clone at $root/<name>, on the spare's branch, put on $branch. A subshell, so the
# clone's lock goes with it.
switch_from_spare() (
  dir="$root/$1"
  if command -v flock >/dev/null 2>&1; then
    exec 8>"/tmp/cloudpid-setup-$1.lock"
    flock 8
  fi
  before=$(git -C "$dir" rev-parse --quiet --verify HEAD 2>/dev/null || echo none)
  nohooks -C "$dir" fetch --quiet origin || exit 1
  start="" track=--no-track
  if git -C "$dir" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    start="origin/$branch" track=--track
  elif [ -n "$base" ]; then
    if ! git -C "$dir" show-ref --verify --quiet "refs/remotes/origin/$base"; then
      echo "cloudpid: $dir's origin has no branch $base to start $branch from" >&2
      exit 1
    fi
    start="origin/$base"
  else
    start=$(git -C "$dir" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) || start=""
  fi
  if [ -z "$start" ]; then
    # A Repo with no commits yet: the branch is born with the first.
    git -C "$dir" symbolic-ref HEAD "refs/heads/$branch" || exit 1
  else
    # What the spare's Setup Script changed in tracked files is kept when it can be, and given up when it is in the way.
    nohooks -C "$dir" checkout --quiet "$track" -b "$branch" "$start" 2>/dev/null ||
      nohooks -C "$dir" checkout --quiet --force "$track" -B "$branch" "$start" || exit 1
  fi
  if git -C "$dir" show-ref --verify --quiet "refs/heads/$spare"; then
    git -C "$dir" branch --quiet -D -- "$spare" || exit 1
  fi
  if [ "$(git -C "$dir" rev-parse --quiet --verify HEAD 2>/dev/null || echo none)" != "$before" ]; then
    # The spare was set up for another commit: its Setup Script is due again, and its Start Script runs once more.
    rm -f -- "$state/$1"
    mkdir -p -- "$start_due" && : > "$start_due/$1"
    if has_mise_config "$dir"; then
      (cd "$dir" && mise install) || echo "cloudpid: mise install failed in $dir; it runs again at the next Container start" >&2
    fi
  fi
  exit 0
)

# clone <name> <url>: the Repo's clone at $root/<name>, on $branch.
clone() {
  dir="$root/$1"
  [ -e "$dir/.git" ] && return 0
  if [ -e "$dir" ]; then
    echo "cloudpid: $dir is there but is not a clone; move it away to clone $2 there" >&2
    return 1
  fi
  # Made beside the repos, then moved into place: a clone that stopped halfway is never taken for one that is there.
  partial="$root/.cloudpid-clone-$1"
  rm -rf -- "$partial"
  nohooks clone --quiet --no-checkout -- "$2" "$partial" || return 1
  if git -C "$partial" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    nohooks -C "$partial" checkout --quiet --track -b "$branch" "origin/$branch" || return 1
  elif [ -n "$base" ]; then
    if ! git -C "$partial" show-ref --verify --quiet "refs/remotes/origin/$base"; then
      echo "cloudpid: $2 has no branch $base to start $branch from" >&2
      return 1
    fi
    nohooks -C "$partial" checkout --quiet --no-track -b "$branch" "origin/$base" || return 1
  elif start=$(git -C "$partial" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null); then
    nohooks -C "$partial" checkout --quiet --no-track -b "$branch" "$start" || return 1
  else
    # A Repo with no commits yet: the branch is born with the first.
    nohooks -C "$partial" checkout --quiet --orphan "$branch" || return 1
  fi
  mv -- "$partial" "$dir" || return 1
  mkdir -p -- "$start_due" && : > "$start_due/$1"
  if has_mise_config "$dir"; then
    (cd "$dir" && mise install) || echo "cloudpid: mise install failed in $dir; it runs again at the next Container start" >&2
  fi
}

status=0
clone_or_report() {
  if [ -e "$root/$1/.git" ] && on_spare "$root/$1"; then
    switch_from_spare "$1" && return 0
    echo "cloudpid: could not switch $root/$1 from $spare to $branch" >&2
    status=1
    return 0
  fi
  clone "$@" && return 0
  rm -rf -- "$root/.cloudpid-clone-$1"
  echo "cloudpid: could not clone $2 into $root/$1" >&2
  status=1
}
${clones.repos.map((repo) => `clone_or_report ${shellQuote(repo.name)} ${shellQuote(repo.url)}`).join("\n")}
exit "$status"
`;

/**
 * The bash script that runs the Setup Script of the Workspace's clone `name` if it is due (`setupScriptRunIfDue`), under
 * a lock of its own: of two Sessions that made the clone at once, the second waits for the first's run, then finds the
 * script done.
 */
export const repoSetupScript = (
  name: string,
  root: string = WORKSPACE_ROOT,
  state: string = SETUP_STATE_DIRECTORY,
  timeoutSeconds: number = SETUP_TIMEOUT_SECONDS,
): string =>
  `${locked(`setup-${name}`)}${setupScriptRunIfDue(`${root}/${name}`, state, timeoutSeconds, root)}`;

/**
 * The bash script that runs the Start Script of the Workspace's clone `name` (`startScriptRunIfThere`) once after the
 * clone was made, since the bootstrap of the Container that was already running did not see it, under the clone's lock:
 * of two Sessions that made the clone at once, the second finds it run. Later starts are the bootstrap's.
 */
export const repoStartScript = (
  name: string,
  root: string = WORKSPACE_ROOT,
  timeoutSeconds: number = START_TIMEOUT_SECONDS,
): string => `${locked(`setup-${name}`)}
rm -- ${shellQuote(`${startDueDirectory(root)}/${name}`)} 2>/dev/null || exit 0
${startScriptRunIfThere(`${root}/${name}`, timeoutSeconds)}`;
