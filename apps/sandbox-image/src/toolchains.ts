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
  "**/__pycache__",
  "**/.pytest_cache",
  "**/.mypy_cache",
  "**/.ruff_cache",
];

/** The Workspace's own mise config: the Toolchains of every command, whatever its directory. */
export const ROOT_MISE_TOML = `${WORKSPACE_ROOT}/mise.toml`;

/** What the Workspace declares when it declares nothing: git and gh, which the image does not carry (ADR-0004). */
export const BASE_MISE_TOML = `# Toolchains of this Workspace. The Container installs them on start, from mise.lock.
# https://mise.jdx.dev/configuration.html

[settings]
lockfile = true
lockfile_platforms = ["linux-x64"]

[tools]
"conda:git" = "2"
gh = "2"
`;

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
/** The identity of the agent's commits when no deploy-time `CLOUDPID_GIT_NAME` / `CLOUDPID_GIT_EMAIL` is set, on the Container and the Worker Shell alike. */
export const DEFAULT_GIT_NAME = "cloudpid";
export const DEFAULT_GIT_EMAIL = "cloudpid@users.noreply.github.com";

const CREDENTIAL_HELPER = String.raw`!f() { if [ "$1" = get ] && [ -n "$GITHUB_TOKEN" ]; then echo username=x-access-token; echo "password=$GITHUB_TOKEN"; fi; }; f`;

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The bash script that makes a freshly started Container ready for commands, run once per Container start before the
 * first command (`apps/server/src/workspace/toolchains.ts`). It
 *
 * 1. writes `BASE_MISE_TOML` if the Workspace root has no mise config of any kind mise reads,
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
export const bootstrapScript = (root: string = WORKSPACE_ROOT): string => `
set -u
root=${shellQuote(root)}
cd "$root" || exit 1

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
  git config --global --get user.name >/dev/null || git config --global user.name "\${CLOUDPID_GIT_NAME:-${DEFAULT_GIT_NAME}}"
  git config --global --get user.email >/dev/null || git config --global user.email "\${CLOUDPID_GIT_EMAIL:-${DEFAULT_GIT_EMAIL}}"
  git config --global credential.https://github.com.helper ${shellQuote(CREDENTIAL_HELPER)}
fi

exit "$status"
`;
