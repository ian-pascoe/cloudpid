// A Workspace's clones on its Container (docs/spec.md → Workspaces, ADR-0016): one full clone of each of its
// Environment's Repos at `<root>/<repo>`, all on the Workspace's branch, made when a Session first works in it. These are
// bash scripts the Container runs, with real git.
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
 */
export const prepareWorkspaceScript = (
  clones: WorkspaceClones,
  root: string = WORKSPACE_ROOT,
  /** The transports git may use (`GIT_ALLOW_PROTOCOL`), whatever a URL or a redirect asks for. */
  protocols: string = "https",
): string => `set -u -o pipefail
export SKIP_REFERENCE_REPOS=1 GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=${shellQuote(protocols)}
root=${shellQuote(root)}
branch=${shellQuote(clones.branch)}
base=${shellQuote(clones.base ?? "")}
start_due=${shellQuote(startDueDirectory(root))}
${locked("workspace")}
${HAS_MISE_CONFIG}
nohooks() { git -c core.hooksPath=/dev/null "$@"; }

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
