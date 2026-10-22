// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
// The Container's Toolchain contract (docs/spec.md → Container and Toolchains, ADR-0004), kept next to the Dockerfile it
// must agree with. The Workspace DO imports it: no Node built-ins here, since it runs in a Worker.

/** The Workspace as the Container mounts it (`MOUNT_POINT` in the Dockerfile). */
export const WORKSPACE_ROOT = "/workspace";

/**
 * Paths computer keeps container-local (computerd's `MOUNT_IGNORE`): they are never recorded in the Workspace DO's
 * file system, so dependency trees, build output and caches cost no DO storage and no sync. The patterns are computer's:
 * `/…` from the mount root, `**` + `/…` at any depth.
 *
 * mise's own directories are not here, because they are not under `/workspace`: mise keeps its Toolchains and
 * downloads where it does by default, on the Container's disk (`/root/.local/share/mise`, `/root/.cache/mise`), and
 * its temp files go to `/tmp` on the same disk. That makes a rename between them one filesystem's (no `EXDEV`), and
 * it never crosses the ignore boundary at all. Putting them under `/workspace/.mise` on this list, as docs/spec.md
 * first planned, works for installs (gh, git, node, python install there) but computerd 0.5.1's FUSE answers
 * `listxattr` on an ignored path with `ENOENT` where a synced path answers `[]`, which makes Python's
 * `shutil.copystat` fail: `python -m venv` could not copy ensurepip's wheels out of a Toolchain on such a path.
 * Python copying files out of a `node_modules` or `.venv` is subject to the same limit, so it is a computerd
 * issue to raise; keeping the Toolchains off the ignored FUSE path keeps it to files in those directories.
 */
export const TOOLCHAIN_IGNORE: readonly string[] = [
  "**/node_modules",
  "**/.venv",
  // Cargo's target directory, in a repo (`/<repo>/target`) or at the Workspace root. Not at any depth: a source
  // directory called `target` is not a build directory.
  "/target",
  "/*/target",
  "**/.cache",
  // pnpm's content-addressed store. With the home directory on the Container's disk and the project on the FUSE mount,
  // pnpm puts it at the mount's root, `/workspace/.pnpm-store`, where one install synced most of a Workspace's files
  // (docs/spec.md → Container and Toolchains → Snapshots). Local-only, it sits on the same side as `node_modules`, so
  // pnpm still hard-links between them.
  "**/.pnpm-store",
  "**/__pycache__",
  "**/.pytest_cache",
  "**/.mypy_cache",
  "**/.ruff_cache",
  // Build tools' caches and environments, regenerated on demand: Turborepo's (this repo's `pnpm check` writes thousands
  // of files there), web frameworks', Terraform's providers, Gradle's, and Python and Nix environments other than
  // `.venv`. Names like `dist`, `build`, `coverage`, `vendor` or `.yarn` stay synced: some repos commit them, and a
  // tracked file on an ignored path shows as deleted in the Worker Shell's git.
  "**/.turbo",
  "**/.next",
  "**/.nuxt",
  "**/.svelte-kit",
  "**/.parcel-cache",
  "**/.terraform",
  "**/.gradle",
  "**/.tox",
  "**/.nox",
  "**/.direnv",
];

/** The Workspace's own mise config: the Toolchains of every command, whatever its directory. */
export const ROOT_MISE_TOML = `${WORKSPACE_ROOT}/mise.toml`;

/**
 * What the Workspace declares when it declares nothing: git and gh, and Node, pnpm, Python and uv. These are the
 * versions the image preinstalls in mise's system directory: the image holds a copy of this file (`image/mise.toml`;
 * a test keeps the two equal) and installs its tools, so a new Workspace downloads none of them (ADR-0004). They are
 * exact: mise locks a prefix such as `"24"` to the newest release, which the image would soon not have. The Workspace
 * owns the file from then on, and a version it changes to is installed on the Container's disk as before.
 */
export const BASE_MISE_TOML = `# Toolchains of this Workspace. The Container installs them on start, from mise.lock.
# https://mise.jdx.dev/configuration.html

[settings]
lockfile = true
lockfile_platforms = ["linux-x64"]

[tools]
"conda:git" = "2.56.0"
gh = "2.102.1"
node = "24.22.1"
pnpm = "12.15.0"
python = "3.14.8"
uv = "0.13.4"
`;

/**
 * The image's lockfile of `BASE_MISE_TOML`, made when the image is built. The bootstrap copies it next to the base file
 * it writes: `mise lock` downloads aqua and Python artifacts to checksum them (90 MB for the base Toolchains), which
 * would undo the preinstall.
 */
export const BASE_MISE_LOCK = "/usr/local/share/cloudpid/mise.lock";

/** Environment variables for a command. */
export type CommandEnv = { [name: string]: string };

/** What `toolchainEnv` sets. */
export type ToolchainEnv = {
  MISE_GLOBAL_CONFIG_FILE: string;
  MISE_TRUSTED_CONFIG_PATHS: string;
  MISE_YES: string;
  GIT_TERMINAL_PROMPT: string;
  GH_TOKEN?: string;
  GITHUB_TOKEN?: string;
};

/** What the Workspace DO knows that commands need. */
export type ToolchainEnvOptions = {
  /** The GitHub token for git and gh; none leaves a command's own alone. */
  readonly githubToken?: string | undefined;
};

/**
 * The environment every command on the Container gets, under whatever the caller passes. computerd starts a command
 * with PATH (the image's, which has mise's shims first) and HOME but none of the image's other variables, so mise's
 * settings are here. The token is only ever here, in a process's environment: `bootstrapScript` makes git read it from
 * there, so no file holds it.
 */
export const toolchainEnv = (options: ToolchainEnvOptions): ToolchainEnv => {
  const env: ToolchainEnv = {
    // The Workspace's mise.toml is also mise's global config: a mise shim resolves its version from the working
    // directory's config and the global one, so without this git and gh would fail ("No version is set for shim")
    // anywhere but under /workspace: in a scratch clone in /tmp, or in the git calls pip and npm make from their own
    // temp directories. The image has no other git to fall back on.
    MISE_GLOBAL_CONFIG_FILE: ROOT_MISE_TOML,
    // Every repo's mise.toml is the agent's own, in its own Workspace: trusted, and nothing to ask about. (A project's
    // mise.toml cannot set these two, so they are the environment's.)
    MISE_TRUSTED_CONFIG_PATHS: WORKSPACE_ROOT,
    MISE_YES: "1",
    // A prompt nobody answers would hang the command.
    GIT_TERMINAL_PROMPT: "0",
  };

  if (options.githubToken !== undefined && options.githubToken !== "") {
    env.GH_TOKEN = options.githubToken;
    env.GITHUB_TOKEN = options.githubToken;
  }

  return env;
};

/** git's answer to a credential request for github.com: the token of the environment it runs in. */
const CREDENTIAL_HELPER = String.raw`!f() { if [ "$1" = get ] && [ -n "$GITHUB_TOKEN" ]; then echo username=x-access-token; echo "password=$GITHUB_TOKEN"; fi; }; f`;

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The bash script that makes a freshly started Container ready for commands, run once per Container start before the
 * first command (`apps/server/src/workspace/toolchains.ts`). It
 *
 * 0. makes each of `readOnlyDirectories` (absolute paths: the Workspace's read-only mounts) read-only here too, when the
 *    Container can mount,
 * 1. writes `BASE_MISE_TOML` if the Workspace root has no mise config of any kind mise reads, with the image's
 *    lockfile for it (`baseLock`, by default `BASE_MISE_LOCK`) next to it when the image has one,
 * 2. makes sure `mise.lock` is there and current for the root's `mise.toml`, which is mise's global config
 *    (`toolchainEnv`) and so is only locked by `mise lock --global`: when the lockfile is missing or older than the
 *    config, to the one platform the Container is,
 * 3. runs `mise install` (which installs from `mise.lock` and does nothing for what is present) in the Workspace and
 *    in each repo directory that has a mise config, and exits with the first failure's status after trying all,
 * 4. with git installed, sets the commit identity from `CLOUDPID_GIT_NAME` and `CLOUDPID_GIT_EMAIL` unless the
 *    Container's global config has one, and points git's credentials for github.com at `$GITHUB_TOKEN` at the time
 *    git asks. Those go to the Container's `~/.gitconfig`, not the Workspace: nothing here syncs, and no file holds
 *    the token.
 */
export const bootstrapScript = (
  root: string = WORKSPACE_ROOT,
  readOnlyDirectories: readonly string[] = [],
  baseLock: string = BASE_MISE_LOCK,
): string => `
set -u
root=${shellQuote(root)}
cd "$root" || exit 1

# Directories the Workspace holds read-only (the bundled skills): the Workspace DO refuses a write there, so one made
# here would stay on this Container, which would then differ from the Workspace until it restarts. Make them read-only
# here too, with a bind mount of each over itself, remounted read-only, which fails a write with EROFS. Best effort: a
# Container that may not mount (\`alchemy dev\`'s, without FUSE) keeps the directory as it was, and the bootstrap goes on.
for dir in ${readOnlyDirectories.map(shellQuote).join(" ")}; do
  [ -d "$dir" ] || continue
  grep -qs " $dir " /proc/self/mountinfo && continue
  if mount --bind "$dir" "$dir" 2>/dev/null; then
    mount -o remount,bind,ro "$dir" 2>/dev/null || umount "$dir" 2>/dev/null
  fi
done

# Every file mise reads a Toolchain declaration from (mise.<env>.toml aside).
has_mise_config() {
  for file in mise.toml .mise.toml mise.local.toml .mise.local.toml .config/mise.toml .config/mise/config.toml .mise/config.toml mise/config.toml .tool-versions; do
    [ -e "$1/$file" ] && return 0
  done

  return 1
}

if ! has_mise_config "$root"; then
  cat > mise.toml <<'CLOUDPID_BASE_MISE_TOML'
${BASE_MISE_TOML}CLOUDPID_BASE_MISE_TOML
  [ -f ${shellQuote(baseLock)} ] && [ ! -e mise.lock ] && cp ${shellQuote(baseLock)} mise.lock
fi

status=0

note_failure() {
  if [ "$1" -ne 0 ] && [ "$status" -eq 0 ]; then status=$1; fi
}

if [ -f mise.toml ] && { [ ! -e mise.lock ] || [ mise.toml -nt mise.lock ]; }; then
  mise lock --global --platform linux-x64
  note_failure $?
fi

for dir in "$root" "$root"/*/; do
  dir=\${dir%/}
  if has_mise_config "$dir"; then
    (cd "$dir" && mise install)
    note_failure $?
  fi
done

if command -v git >/dev/null 2>&1; then
  git config --global --get user.name >/dev/null || git config --global user.name "\${CLOUDPID_GIT_NAME:-cloudpid}"
  git config --global --get user.email >/dev/null || git config --global user.email "\${CLOUDPID_GIT_EMAIL:-cloudpid@users.noreply.github.com}"
  git config --global credential.https://github.com.helper ${shellQuote(CREDENTIAL_HELPER)}
fi

exit "$status"
`;

/** A repo's Setup Script, relative to the repo's directory: what prepares the repo on a Container (its dependencies). */
export const SETUP_SCRIPT = ".agents/setup.sh";

/**
 * Where the Container records the Setup Scripts that succeeded, one file per repo directory holding the script's SHA-256.
 * On the Container's disk, outside `/workspace`: nothing syncs it, and a snapshot of the disk carries it.
 */
export const SETUP_STATE_DIRECTORY = "/var/lib/cloudpid/setup";

/** Where the Container records the Setup Script of the repo directory `repo` (a name, not a path) that last succeeded. */
export const setupRecord = (repo: string, state: string = SETUP_STATE_DIRECTORY): string =>
  `${state}/${repo}`;

/** How long a Setup Script may run before it is stopped. */
export const SETUP_TIMEOUT_SECONDS = 15 * 60;

/** The last line a Setup Script's run prints, on stderr, when the script ran past its time and was stopped. */
export const SETUP_TIMED_OUT_MESSAGE =
  "cloudpid: the Setup Script ran past its time and was stopped";

/** The exit status of a Setup Script's run that ran past its time (`timeout`'s); a script may exit with it too. */
const SETUP_TIMED_OUT_STATUS = 124;

/**
 * Whether a Setup Script's run that exited with `code` and printed `output` (its end will do) was stopped for running
 * past its time, not a script that exited with the same status on its own.
 */
export const setupScriptTimedOut = (code: number | undefined, output: string): boolean =>
  code === SETUP_TIMED_OUT_STATUS && output.trimEnd().endsWith(SETUP_TIMED_OUT_MESSAGE);

/** The SHA-256 of the file at the bash word `file`, in bash: its hex digest alone. */
const sha256 = (file: string): string => `sha256sum < ${file} | cut -d' ' -f1`;

/**
 * The bash script that prints, one per line, the directories of the repos in `root` whose Setup Script is due: each
 * directory directly below `root` with a `SETUP_SCRIPT` file whose content differs from the last one that succeeded
 * there (`setupRecord`). A repo that never ran its script is due.
 */
export const pendingSetupScripts = (
  root: string = WORKSPACE_ROOT,
  state: string = SETUP_STATE_DIRECTORY,
): string => `
set -u -o pipefail
state=${shellQuote(state)}
for dir in ${shellQuote(root)}/*/; do
  dir=\${dir%/}
  [ -f "$dir"/${SETUP_SCRIPT} ] || continue
  hash=$(${sha256(`"$dir"/${SETUP_SCRIPT}`)}) || continue
  # setupRecord's path.
  [ "$(cat "$state/\${dir##*/}" 2>/dev/null)" = "$hash" ] && continue
  printf '%s\\n' "$dir"
done
exit 0
`;

/**
 * The bash script that runs the Setup Script of the repo in `directory`: with bash, in that directory, with no input,
 * stopped (with every process it started) after `timeoutSeconds`. When it succeeds, the content it ran is recorded
 * (`setupRecord`), so it is not run again until it changes. It exits with the script's status; one stopped for its time
 * ends with `SETUP_TIMED_OUT_MESSAGE` (`setupScriptTimedOut`).
 */
export const setupScriptRun = (
  directory: string,
  state: string = SETUP_STATE_DIRECTORY,
  timeoutSeconds: number = SETUP_TIMEOUT_SECONDS,
): string => `
set -u -o pipefail
cd ${shellQuote(directory)} || exit 1
hash=$(${sha256(SETUP_SCRIPT)}) || exit 1
started=$SECONDS
# timeout puts the script in a process group of its own and signals all of it, so what the script started stops too.
timeout --kill-after=10 ${timeoutSeconds} bash ${SETUP_SCRIPT} </dev/null
status=$?
if [ "$status" -ne 0 ] && [ $((SECONDS - started)) -ge ${timeoutSeconds} ]; then
  printf '%s\\n' ${shellQuote(SETUP_TIMED_OUT_MESSAGE)} >&2
  exit ${SETUP_TIMED_OUT_STATUS}
fi
if [ "$status" -eq 0 ]; then
  mkdir -p ${shellQuote(state)} && printf '%s\\n' "$hash" > ${shellQuote(setupRecord(directory.slice(directory.lastIndexOf("/") + 1), state))} || exit 1
fi
exit "$status"
`;
