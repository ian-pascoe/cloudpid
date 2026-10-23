// An Environment's Build on the Container (docs/spec.md → Builds, ADR-0016): the Build's Durable Object clones each of
// the Environment's Repos into a scratch directory outside `/workspace`, so nothing of them syncs into it, installs
// their Toolchains, runs the Environment's and the Repos' Setup Scripts there (what they download stays on the
// Container's disk: pnpm's store, mise's installs, Docker's images), then stops what the scripts left running and
// deletes the clones and every Setup Script record before the Container is snapshotted. These are the bash scripts the
// Container runs, with real git; `apps/server/src/workspace/build.ts` runs them in order.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off
import { HAS_MISE_CONFIG, SETUP_STATE_DIRECTORY, shellQuote } from "./toolchains.ts";
import type { WorkspaceRepo } from "./workspaces.ts";

/** Where a Build clones the Environment's Repos: on the Container's disk, outside `/workspace`, deleted before the snapshot. */
export const BUILD_ROOT = "/var/tmp/cloudpid-build";

/**
 * The variable every process a Build's scripts start carries, set to the Build's run id: what the clean-up looks for to
 * stop what the scripts left running (`buildCleanupScript`). A process that clears its environment is not found.
 */
export const BUILD_RUN_VARIABLE = "CLOUDPID_BUILD_RUN";

/**
 * The lines every script of a Build begins with: the run's tag in the environment (`BUILD_RUN_VARIABLE`), and the scratch
 * root among the configs mise trusts, as `/workspace` is (`toolchainEnv`), so a Repo's `mise.toml` there is used.
 */
export const buildPrelude = (
  run: string,
  root: string = BUILD_ROOT,
): string => `export ${BUILD_RUN_VARIABLE}=${shellQuote(run)}
export MISE_TRUSTED_CONFIG_PATHS="\${MISE_TRUSTED_CONFIG_PATHS:+$MISE_TRUSTED_CONFIG_PATHS:}"${shellQuote(root)}
`;

/**
 * The bash script that makes a Build's scratch clones: the root emptied, then a full clone of each Repo at its default
 * branch in `<root>/<repo>`, with git's hooks off and `SKIP_REFERENCE_REPOS` set (as for a Workspace's clones), then
 * `mise install` in each that declares Toolchains. It stops at the first Repo that fails, with git's or mise's output,
 * and exits 1: a Build that lacks a Repo is no Build.
 */
export const buildCloneScript = (
  repos: ReadonlyArray<WorkspaceRepo>,
  root: string = BUILD_ROOT,
  /** The transports git may use (`GIT_ALLOW_PROTOCOL`), whatever a URL or a redirect asks for. */
  protocols: string = "https",
): string => `set -u -o pipefail
export SKIP_REFERENCE_REPOS=1 GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=${shellQuote(protocols)}
root=${shellQuote(root)}
${HAS_MISE_CONFIG}
rm -rf -- "$root" && mkdir -p -- "$root" || exit 1

# clone <name> <url>: the Repo's clone at $root/<name>, on its default branch, its Toolchains installed.
clone() {
  git -c core.hooksPath=/dev/null clone --quiet -- "$2" "$root/$1" || {
    echo "cloudpid: could not clone $2" >&2
    return 1
  }
  if has_mise_config "$root/$1"; then
    (cd "$root/$1" && mise install) || {
      echo "cloudpid: mise install failed in $root/$1" >&2
      return 1
    }
  fi
}
${repos.map((repo) => `clone ${shellQuote(repo.name)} ${shellQuote(repo.url)} || exit 1`).join("\n")}
exit 0
`;

/** The word a line of `buildCommitsScript` and `remoteHeadsScript` begins with. */
const COMMIT_LINE = "cloudpid-commit";

/**
 * The bash script that prints the commit each scratch clone is at, a `cloudpid-commit <repo> <commit>` line each (`-`
 * for a Repo with no commits yet), for `parseCommits`.
 */
export const buildCommitsScript = (
  repos: ReadonlyArray<WorkspaceRepo>,
  root: string = BUILD_ROOT,
): string => `set -u
root=${shellQuote(root)}
for name in ${repos.map((repo) => shellQuote(repo.name)).join(" ")}; do
  commit=$(git -C "$root/$name" rev-parse --quiet --verify HEAD 2>/dev/null) || commit=-
  printf '${COMMIT_LINE} %s %s\\n' "$name" "$commit"
done
exit 0
`;

/**
 * The bash script that prints the commit each Repo's default branch is at on its remote (`git ls-remote`, which needs no
 * clone), a `cloudpid-commit <repo> <commit>` line each (`-` for a remote with no commits), for `parseCommits`. It exits 1
 * when a remote cannot be asked.
 */
export const remoteHeadsScript = (
  repos: ReadonlyArray<WorkspaceRepo>,
  protocols: string = "https",
): string => `set -u -o pipefail
export GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=${shellQuote(protocols)}
head_of() {
  out=$(git ls-remote -- "$2" HEAD) || { echo "cloudpid: could not ask $2 for its default branch" >&2; return 1; }
  commit=$(printf '%s\\n' "$out" | awk '$2 == "HEAD" { print $1; exit }')
  printf '${COMMIT_LINE} %s %s\\n' "$1" "\${commit:--}"
}
${repos.map((repo) => `head_of ${shellQuote(repo.name)} ${shellQuote(repo.url)} || exit 1`).join("\n")}
exit 0
`;

/**
 * Each Repo's commit, by name, from what `buildCommitsScript` or `remoteHeadsScript` printed: null for a Repo with none
 * yet (an empty repository).
 */
export const parseCommits = (output: string) =>
  Object.fromEntries(
    output.split("\n").flatMap((line) => {
      const [word, name, commit] = line.trim().split(" ");

      return word !== COMMIT_LINE || name === undefined || commit === undefined
        ? []
        : [[name, commit === "-" ? null : commit] as const];
    }),
  );

/** How long the clean-up waits for Docker's daemon, then containerd, to stop once asked, in seconds. */
const DAEMON_STOP_SECONDS = 30;

/** How long it waits for the other processes left to stop once asked, before it kills them, in seconds. */
const STRAY_STOP_SECONDS = 5;

/**
 * The bash script that readies a Build's Container for its snapshot. It stops what the Build's scripts left running (each
 * process whose environment carries run `run`'s tag, `BUILD_RUN_VARIABLE`, but this script and what it runs): Docker's
 * daemon first, then containerd, each asked to stop (SIGTERM, so dockerd stops its containers) and waited for, then the
 * rest, asked and then killed after a few seconds. Then it deletes the scratch clones (`root`) and every Setup Script
 * record (`state`), the Environment's too, so a Workspace started from the Build runs each Setup Script again in its own
 * clones, against the stores the Build filled. It exits 1 when a process could not be stopped or a file deleted.
 */
export const buildCleanupScript = (
  run: string,
  root: string = BUILD_ROOT,
  state: string = SETUP_STATE_DIRECTORY,
  /** How long the processes left other than the daemons get to stop once asked, in seconds. */
  strayStopSeconds: number = STRAY_STOP_SECONDS,
): string => `set -u
tag=${shellQuote(`${BUILD_RUN_VARIABLE}=${run}`)}
self=$$

# parent_of <pid>: its parent's pid, from /proc (the name in parentheses may hold spaces).
parent_of() {
  local stat
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 1
  stat=\${stat##*) }
  set -- $stat
  echo "$2"
}

# ours <pid>: whether it is this script or runs under it (its command substitutions included).
ours() {
  local pid=$1
  while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
    [ "$pid" = "$self" ] && return 0
    pid=$(parent_of "$pid") || return 1
  done
  return 1
}

# left [name]: the pids of the Build's processes still running, but this script's own and its ancestors' (the exec that
# runs it); of those named <name> only, when given.
left() {
  local dir pid
  for dir in /proc/[0-9]*; do
    pid=\${dir#/proc/}
    [ "$pid" = 1 ] && continue
    tr '\\0' '\\n' <"$dir/environ" 2>/dev/null | grep -qxF -- "$tag" || continue
    [ -n "\${1:-}" ] && [ "$(cat "$dir/comm" 2>/dev/null)" != "$1" ] && continue
    ours "$pid" && continue
    ancestor "$pid" && continue
    echo "$pid"
  done
}

ancestors=" "
pid=$(parent_of "$self")
while [ -n "$pid" ] && [ "$pid" -gt 1 ]; do
  ancestors="$ancestors$pid "
  pid=$(parent_of "$pid") || break
done
ancestor() { case "$ancestors" in *" $1 "*) return 0 ;; esac; return 1; }

# stop <seconds> [name]: ask the processes left (named <name>, when given) to stop, and wait up to <seconds> for them.
stop() {
  local pids deadline
  pids=$(left "\${2:-}")
  [ -z "$pids" ] && return 0
  kill -TERM $pids 2>/dev/null
  # By the clock, not by rounds: a look through /proc takes a while on a busy Container.
  deadline=$((SECONDS + $1))
  while [ "$SECONDS" -lt "$deadline" ]; do
    sleep 0.1
    [ -z "$(left "\${2:-}")" ] && return 0
  done
  return 1
}

status=0
stop ${DAEMON_STOP_SECONDS} dockerd || echo "cloudpid: Docker's daemon did not stop in ${DAEMON_STOP_SECONDS} s" >&2
stop ${DAEMON_STOP_SECONDS} containerd || echo "cloudpid: containerd did not stop in ${DAEMON_STOP_SECONDS} s" >&2
if ! stop ${strayStopSeconds}; then
  pids=$(left)
  [ -n "$pids" ] && kill -KILL $pids 2>/dev/null
  sleep 0.5
  if [ -n "$(left)" ]; then
    echo "cloudpid: could not stop what the Setup Scripts left running: $(left | tr '\\n' ' ')" >&2
    status=1
  fi
fi

rm -rf -- ${shellQuote(root)} || status=1
rm -rf -- ${shellQuote(state)} || status=1
exit "$status"
`;
