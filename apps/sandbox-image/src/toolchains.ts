// The Container's Toolchain contract (docs/spec.md → Container and Toolchains, ADR-0004), kept next to the Dockerfile it
// must agree with. The Workspace DO imports it: no Node built-ins here, since it runs in a Worker.

/** The Workspace as the Container mounts it (`MOUNT_POINT` in the Dockerfile). */
export const WORKSPACE_ROOT = "/workspace";

/** Where mise keeps what it installs, and its downloads and temp files: all on the container-local side. */
const MISE_DIR = `${WORKSPACE_ROOT}/.mise`;

/**
 * Paths computer keeps container-local (computerd's `MOUNT_IGNORE`): they are never recorded in the Workspace DO's
 * file system, so installs, caches and dependency trees cost no DO storage and no sync. The patterns are computer's:
 * `/…` from the mount root, `**` + `/…` at any depth.
 *
 * Only mise's `data`, `cache` and `tmp` are listed, not `.mise` itself: mise's config and lock sidecars
 * (`.mise/config.toml`, `.mise/locks/`) belong to the project and sync with it. A rename between an ignored and a
 * synced path fails with `EXDEV`, so what installs write is kept on the ignored side: `TMPDIR` is `.mise/tmp`
 * (`toolchainEnv`), next to mise's data and cache.
 */
export const TOOLCHAIN_IGNORE: readonly string[] = [
  "/.mise/data",
  "/.mise/cache",
  "/.mise/tmp",
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
  TMPDIR: string;
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
 * The environment every command on the Container gets, under whatever the caller passes. The token is only ever here,
 * in a process's environment: `bootstrapScript` makes git read it from there, so no file holds it.
 */
export const toolchainEnv = (options: ToolchainEnvOptions): ToolchainEnv => {
  const env: ToolchainEnv = {
    // Temp files go where installs go, so a rename from one to the other stays on the ignored side.
    TMPDIR: `${MISE_DIR}/tmp`,
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
 * 1. writes `BASE_MISE_TOML` if the Workspace has no mise config,
 * 2. runs `mise install` (which installs from `mise.lock` and does nothing for what is present) in the Workspace and
 *    in each repo directory that has its own `mise.toml`, and exits with the first failure's status after trying all,
 * 3. with git installed, sets the commit identity from `CLOUDPID_GIT_NAME` and `CLOUDPID_GIT_EMAIL` unless the
 *    Container's global config has one, and points git's credentials for github.com at `$GITHUB_TOKEN` at the time
 *    git asks. Those go to the Container's `~/.gitconfig`, not the Workspace: nothing here syncs, and no file holds
 *    the token.
 */
export const bootstrapScript = (root: string = WORKSPACE_ROOT): string => `
set -u
root=${shellQuote(root)}
mkdir -p "\${TMPDIR:-${MISE_DIR}/tmp}"
cd "$root" || exit 1

if [ ! -e mise.toml ] && [ ! -e .mise.toml ] && [ ! -e .config/mise.toml ]; then
  cat > mise.toml <<'CLOUDPID_BASE_MISE_TOML'
${BASE_MISE_TOML}CLOUDPID_BASE_MISE_TOML
fi

status=0
for dir in "$root" "$root"/*/; do
  dir=\${dir%/}
  if [ -f "$dir/mise.toml" ] || [ -f "$dir/.mise.toml" ]; then
    (cd "$dir" && mise install)
    code=$?
    if [ "$code" -ne 0 ] && [ "$status" -eq 0 ]; then status=$code; fi
  fi
done

if command -v git >/dev/null 2>&1; then
  git config --global --get user.name >/dev/null || git config --global user.name "\${CLOUDPID_GIT_NAME:-cloudpid}"
  git config --global --get user.email >/dev/null || git config --global user.email "\${CLOUDPID_GIT_EMAIL:-cloudpid@users.noreply.github.com}"
  git config --global credential.https://github.com.helper ${shellQuote(CREDENTIAL_HELPER)}
fi

exit "$status"
`;
