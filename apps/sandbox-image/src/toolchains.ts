// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
// The Container's Toolchain contract (docs/spec.md → Container and Toolchains, ADR-0004), kept next to the Dockerfile it
// must agree with. The Workspace DO imports it: no Node built-ins here, since it runs in a Worker.

/** The Workspace as the Container mounts it (`MOUNT_POINT` in the Dockerfile). */
export const WORKSPACE_ROOT = "/workspace";

/**
 * The name of the directory pnpm's store is in, under the Container's home directory (`/root/.pnpm-store`): its content-
 * addressed files (`v11/files`) and the global virtual store (`v11/links`). It is a name the token scan before a snapshot
 * skips (`SCAN_SCRIPT`, `apps/server/src/workspace/snapshots.ts`), since it holds only what pnpm installed.
 */
export const PNPM_STORE_DIRECTORY_NAME = ".pnpm-store";

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
  // Cargo's target directory, in a repo (`/<repo>/target`) or at the Workspace's root. Not at any depth: a source
  // directory called `target` is not a build directory.
  "/target",
  "/*/target",
  "**/.cache",
  // pnpm's content-addressed store. The Container's global pnpm configuration puts it on the Container's disk
  // (`PNPM_STORE_DIRECTORY_NAME` under the home directory), but with the home directory on the Container's disk and the
  // project on the FUSE mount, pnpm puts a store nobody configured at the mount's root, `/workspace/.pnpm-store`, where
  // one install synced most of a Workspace's files (docs/spec.md → Container and Toolchains → Snapshots). That is what
  // an install made before the configuration, or one with an older pnpm, leaves; it stays local, on the same side as
  // `node_modules`, so pnpm still hard-links between them.
  `**/${PNPM_STORE_DIRECTORY_NAME}`,
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
  // More caches that regenerate and no repo commits: Cloudflare's wrangler, Astro, Angular, Expo, Nx, Docusaurus, nyc,
  // Hypothesis, Dart and Zig and Haskell's stack. Not `.alchemy` (it can hold real deploy state).
  "**/.wrangler",
  "**/.astro",
  "**/.angular",
  "**/.expo",
  "**/.nx",
  "**/.docusaurus",
  "**/.nyc_output",
  "**/.hypothesis",
  "**/.dart_tool",
  "**/.zig-cache",
  "**/.stack-work",
];

/**
 * What the bootstrap puts in the Container's global pnpm configuration (`config.yaml` in `$XDG_CONFIG_HOME/pnpm` or
 * `~/.config/pnpm`) unless the file already sets the key: the store on the Container's disk (`$HOME/.pnpm-store`: the
 * default is the home directory's too, but pnpm puts the store of a project on another filesystem at that filesystem's
 * root, and `/workspace` is one), the global virtual store (so a repo's `node_modules` is mostly symlinks into the
 * store's `v11/links`, which stays on one filesystem with the store for hard links) and no prompt to purge `node_modules`.
 * The virtual store is switched on under both of its names: `virtualStoreType` (pnpm 11.23 and later) and
 * `enableGlobalVirtualStore` (before that, from 11.0, and still read later), since on 11.0–11.22 the store would else
 * be on the Container's disk and the virtual store on the mount, which copies packages instead of hard-linking them.
 * pnpm 11.0–11.22 ignores `virtualStoreType` and `confirmModulesPurge` here with a warning at each install. A
 * repo's own `pnpm-workspace.yaml` wins over this file; an environment variable would not, so these are not set as
 * one. `virtualStoreDir` is left out on purpose: set globally, it would also be where a repo that chooses the project
 * layout keeps its virtual store, shared with every other repo; unset, the global virtual store is `<store>/v11/links`.
 * The values are YAML scalars; `$HOME` is the shell's.
 */
export const PNPM_GLOBAL_CONFIG: ReadonlyArray<readonly [key: string, value: string]> = [
  ["storeDir", `"$HOME/${PNPM_STORE_DIRECTORY_NAME}"`],
  ["virtualStoreType", "global"],
  ["enableGlobalVirtualStore", "true"],
  ["confirmModulesPurge", "false"],
];

/**
 * Turborepo's cache directory in a command's environment, on the Container's disk next to mise's cache. Its default is
 * `.turbo/cache` in the repo, a Container-only path that FUSE still serves. The environment variable wins over a
 * repo's `turbo.json` `cacheDir` (`--cache-dir` wins over both).
 */
export const TURBO_CACHE_DIR = "/root/.cache/turbo";

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
gh = "2.103.0"
node = "24.22.1"
pnpm = "12.15.0"
python = "3.14.9"
uv = "0.13.5"
`;

/**
 * The image's lockfile of `BASE_MISE_TOML`, made when the image is built. The bootstrap copies it next to the base file
 * it writes: `mise lock` downloads aqua and Python artifacts to checksum them (90 MB for the base Toolchains), which
 * would undo the preinstall.
 */
export const BASE_MISE_LOCK = "/usr/local/share/cloudpid/mise.lock";

/**
 * The line the bootstrap ends its output with when it changed the Container's disk in a way worth a snapshot (it
 * installed a Toolchain), so the Workspace DO snapshots the disk before the first command. A bootstrap that only found
 * what the image or a restored snapshot has prints none, and its Container waits for the idle stop's snapshot. The
 * Setup Scripts, which the Workspace DO runs as execs of their own after this script, count on its side: one that
 * succeeds is an install too (`apps/server/src/workspace/toolchains.ts`).
 */
export const BOOTSTRAP_CHANGED = "cloudpid-bootstrap: the Container's disk changed";

/** Environment variables for a command. */
export type CommandEnv = { [name: string]: string };

/** What `toolchainEnv` sets. */
export type ToolchainEnv = {
  MISE_GLOBAL_CONFIG_FILE: string;
  MISE_TRUSTED_CONFIG_PATHS: string;
  MISE_YES: string;
  GIT_TERMINAL_PROMPT: string;
  TURBO_CACHE_DIR: string;
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
    TURBO_CACHE_DIR,
  };

  if (options.githubToken !== undefined && options.githubToken !== "") {
    env.GH_TOKEN = options.githubToken;
    env.GITHUB_TOKEN = options.githubToken;
  }

  return env;
};

/** git's answer to a credential request for github.com: the token of the environment it runs in. */
const CREDENTIAL_HELPER = String.raw`!f() { if [ "$1" = get ] && [ -n "$GITHUB_TOKEN" ]; then echo username=x-access-token; echo "password=$GITHUB_TOKEN"; fi; }; f`;

/** `value` as one bash word, single-quoted, whatever it holds. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** `storeDir` as pnpm also reads it from a file: `store-dir`. */
const kebab = (key: string): string =>
  key.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/**
 * The bash lines that write `PNPM_GLOBAL_CONFIG`'s keys to `$pnpm_config` where it does not have them, in either
 * spelling (`storeDir`, `store-dir`), quoted or not, so a key the file sets is never added a second time.
 */
const pnpmConfigSteps = PNPM_GLOBAL_CONFIG.map(
  ([key, value]) =>
    `has_pnpm_setting '${key}|${kebab(key)}' || add_pnpm_setting "${key}: ${value.replaceAll('"', '\\"')}"`,
).join("\n");

/** The bash function `has_mise_config <dir>`: whether `dir` has a file mise reads a Toolchain declaration from. */
export const HAS_MISE_CONFIG = `# Every file mise reads a Toolchain declaration from (mise.<env>.toml aside).
has_mise_config() {
  for file in mise.toml .mise.toml mise.local.toml .mise.local.toml .config/mise.toml .config/mise/config.toml .mise/config.toml mise/config.toml .tool-versions; do
    [ -e "$1/$file" ] && return 0
  done

  return 1
}
`;

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
 *    the token,
 * 5. writes the Container's global pnpm configuration (`PNPM_GLOBAL_CONFIG`), each key only when the file does not have it,
 * 6. ends its output with `BOOTSTRAP_CHANGED` when a step set `changed=1` (step 3 does when mise's installs differ
 *    from before it).
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

${HAS_MISE_CONFIG}

if ! has_mise_config "$root"; then
  cat > mise.toml <<'CLOUDPID_BASE_MISE_TOML'
${BASE_MISE_TOML}CLOUDPID_BASE_MISE_TOML
  [ -f ${shellQuote(baseLock)} ] && [ ! -e mise.lock ] && cp ${shellQuote(baseLock)} mise.lock
fi

status=0

# A step that changes the Container's disk in a way worth a snapshot sets changed=1 (BOOTSTRAP_CHANGED).
changed=0

mise_installs() { printf '%s\n' "\${MISE_DATA_DIR:-$HOME/.local/share/mise}"/installs/*/*; }
installs_before=$(mise_installs)

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

[ "$(mise_installs)" = "$installs_before" ] || changed=1

if command -v git >/dev/null 2>&1; then
  git config --global --get user.name >/dev/null || git config --global user.name "\${CLOUDPID_GIT_NAME:-cloudpid}"
  git config --global --get user.email >/dev/null || git config --global user.email "\${CLOUDPID_GIT_EMAIL:-cloudpid@users.noreply.github.com}"
  git config --global credential.https://github.com.helper ${shellQuote(CREDENTIAL_HELPER)}
fi

# pnpm's global configuration (PNPM_GLOBAL_CONFIG), where pnpm reads it: a key the file has is the Container's own.
# Best effort: pnpm then works as it did, with its store at the mount's root.
pnpm_config="\${XDG_CONFIG_HOME:-$HOME/.config}/pnpm/config.yaml"
mkdir -p "\${pnpm_config%/*}" 2>/dev/null
has_pnpm_setting() { grep -qsE "^[[:space:]]*[\\"']?($1)[\\"']?[[:space:]]*:" "$pnpm_config"; }
# A file that does not end in a newline gets one first, so the line is not joined to the last.
add_pnpm_setting() {
  { [ ! -s "$pnpm_config" ] || [ -z "$(tail -c 1 "$pnpm_config")" ] || echo; printf '%s\\n' "$1"; } >>"$pnpm_config" 2>/dev/null
}
${pnpmConfigSteps}

[ "$changed" -eq 1 ] && echo ${shellQuote(BOOTSTRAP_CHANGED)}

exit "$status"
`;

/** A repo's Setup Script, relative to the repo's directory: what prepares the repo on a Container (its dependencies). */
export const SETUP_SCRIPT = ".agents/setup.sh";

/**
 * A repo's Start Script, relative to the repo's directory: what brings up the repo's services (a database, a dev
 * dependency) at each Container start, which a snapshot of the disk cannot hold.
 */
export const START_SCRIPT = ".agents/start.sh";

/**
 * Where the Container records the Setup Scripts that succeeded, one file per script holding its SHA-256: a repo's under
 * the repo's name, the Environment's under `ENVIRONMENT_SETUP_RECORD`. On the Container's disk, outside `/workspace`:
 * nothing syncs it, and a snapshot of the disk carries it.
 */
export const SETUP_STATE_DIRECTORY = "/var/lib/cloudpid/setup";

/**
 * Where the bootstrap writes the Environment's own Setup and Start Scripts (its Container settings) to run them: on the
 * Container's disk, outside `/workspace`, so they never reach the Workspace's files.
 */
export const ENVIRONMENT_SCRIPTS_DIRECTORY = "/var/lib/cloudpid/environment";

/** The file the Environment's Setup Script is written to. */
export const ENVIRONMENT_SETUP_FILE = `${ENVIRONMENT_SCRIPTS_DIRECTORY}/setup.sh`;

/** The file the Environment's Start Script is written to. */
export const ENVIRONMENT_START_FILE = `${ENVIRONMENT_SCRIPTS_DIRECTORY}/start.sh`;

/** The name the Environment's Setup Script is recorded under: no Repo's name starts with `@`. */
export const ENVIRONMENT_SETUP_RECORD = "@environment";

/** Where the Container records the Setup Script that last succeeded under the record name `name` (`setupRecordName`). */
export const setupRecord = (name: string, state: string = SETUP_STATE_DIRECTORY): string =>
  `${state}/${name}`;

/** The name the Setup Script of `directory` (`<root>/<repo>`) is recorded under: the repo's name. */
export const setupRecordName = (directory: string, root: string = WORKSPACE_ROOT): string => {
  const relative = directory.startsWith(`${root}/`) ? directory.slice(root.length + 1) : directory;

  return relative.slice(relative.lastIndexOf("/") + 1);
};

/** A script the Container runs: the directory it runs in, and its file, absolute or relative to that directory. */
export type ContainerScript = { readonly directory: string; readonly file: string };

/** A Setup Script, with the name its success is recorded under (`setupRecord`). */
export type SetupScript = ContainerScript & { readonly record: string };

/** The Setup Script of the repo in `directory` (`<root>/<repo>`). */
export const repoSetupScriptOf = (
  directory: string,
  root: string = WORKSPACE_ROOT,
): SetupScript => ({
  directory,
  file: SETUP_SCRIPT,
  record: setupRecordName(directory, root),
});

/** The Environment's Setup Script, once written to `file` (`pendingSetupScripts`): run in the Workspace root. */
export const environmentSetupScript = (
  root: string = WORKSPACE_ROOT,
  file: string = ENVIRONMENT_SETUP_FILE,
): SetupScript => ({ directory: root, file, record: ENVIRONMENT_SETUP_RECORD });

/** How long a Setup Script may run before it is stopped. */
export const SETUP_TIMEOUT_SECONDS = 15 * 60;

/** How long a Start Script may run before it is stopped: a service it starts must detach to outlive it. */
export const START_TIMEOUT_SECONDS = 5 * 60;

/** The last line a Setup Script's run prints, on stderr, when the script ran past its time and was stopped. */
export const SETUP_TIMED_OUT_MESSAGE =
  "cloudpid: the Setup Script ran past its time and was stopped";

/** The last line a Start Script's run prints, on stderr, when the script ran past its time and was stopped. */
export const START_TIMED_OUT_MESSAGE =
  "cloudpid: the Start Script ran past its time and was stopped";

/** The exit status of a script's run that ran past its time (`timeout`'s); a script may exit with it too. */
const TIMED_OUT_STATUS = 124;

/**
 * Whether a Setup or Start Script's run that exited with `code` and printed `output` (its end will do) was stopped for
 * running past its time, not a script that exited with the same status on its own.
 */
export const scriptTimedOut = (code: number | undefined, output: string): boolean => {
  const end = output.trimEnd();

  return (
    code === TIMED_OUT_STATUS &&
    (end.endsWith(SETUP_TIMED_OUT_MESSAGE) || end.endsWith(START_TIMED_OUT_MESSAGE))
  );
};

/** The SHA-256 of the file at the bash word `file`, in bash: its hex digest alone. */
const sha256 = (file: string): string => `sha256sum < ${file} | cut -d' ' -f1`;

/** `text`'s UTF-8 bytes in base64. */
const base64 = (text: string): string => {
  let binary = "";

  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);

  return btoa(binary);
};

/**
 * The bash lines that write `source` to `file` exactly (through base64, so no quoting or heredoc delimiter can meet
 * the script's text, and the command stays one Linux argument for the largest script), or remove `file` when `source`
 * is empty. They exit 1 when the file cannot be written.
 */
const writeScript = (source: string, file: string): string =>
  source === ""
    ? `rm -f -- ${shellQuote(file)}`
    : `mkdir -p -- ${shellQuote(file.slice(0, file.lastIndexOf("/")) || "/")} && printf '%s' ${shellQuote(base64(source))} | base64 -d > ${shellQuote(file)} || exit 1`;

/** The Environment's script `source`, and the file it is written to. */
export type EnvironmentScript = { readonly source: string; readonly file: string };

/**
 * The bash script that prints, one per line, the Setup Scripts that are due: first the Environment's (its file, once
 * written there), when `environment` has one, then each repo directly below `root` with a `SETUP_SCRIPT` file. A
 * script is due when its content differs from the last one that succeeded under its record (`setupRecord`); one that
 * never ran is due. An Environment with no Setup Script has its old file removed.
 */
export const pendingSetupScripts = (
  root: string = WORKSPACE_ROOT,
  state: string = SETUP_STATE_DIRECTORY,
  environment?: EnvironmentScript,
): string => `
set -u -o pipefail
state=${shellQuote(state)}
root=${shellQuote(root)}
${
  environment === undefined
    ? ""
    : `${writeScript(environment.source, environment.file)}
if [ -f ${shellQuote(environment.file)} ]; then
  hash=$(${sha256(shellQuote(environment.file))}) || exit 1
  [ "$(cat "$state"/${shellQuote(ENVIRONMENT_SETUP_RECORD)} 2>/dev/null)" = "$hash" ] || printf '%s\\n' ${shellQuote(environment.file)}
fi`
}
for dir in "$root"/*/; do
  dir=\${dir%/}
  [ -f "$dir"/${SETUP_SCRIPT} ] || continue
  hash=$(${sha256(`"$dir"/${SETUP_SCRIPT}`)}) || continue
  # setupRecordName's: the repo's name.
  name=\${dir#"$root"/}
  [ "$(cat "$state/$name" 2>/dev/null)" = "$hash" ] && continue
  printf '%s\\n' "$dir"
done
exit 0
`;

/**
 * The bash script that runs `script`: with bash, in its directory, with no input, stopped (with every process it
 * started) after `timeoutSeconds`, then `timedOut` printed on stderr and status 124. `record`, when given, is the bash
 * lines run after a success with `$hash` the SHA-256 of the file that ran. It exits with the script's status.
 */
const scriptRun = (
  { directory, file }: ContainerScript,
  timeoutSeconds: number,
  timedOut: string,
  record?: string,
): string => `
set -u -o pipefail
cd ${shellQuote(directory)} || exit 1
${record === undefined ? "" : `hash=$(${sha256(shellQuote(file))}) || exit 1`}
started=$SECONDS
# timeout puts the script in a process group of its own and signals all of it, so what the script started stops too.
timeout --kill-after=10 ${timeoutSeconds} bash ${shellQuote(file)} </dev/null
status=$?
if [ "$status" -ne 0 ] && [ $((SECONDS - started)) -ge ${timeoutSeconds} ]; then
  printf '%s\\n' ${shellQuote(timedOut)} >&2
  exit ${TIMED_OUT_STATUS}
fi
${record === undefined ? "" : `if [ "$status" -eq 0 ]; then\n${record}\nfi`}
exit "$status"
`;

/**
 * The bash script that runs the Setup Script `script` (`repoSetupScriptOf`, `environmentSetupScript`): with bash, in
 * its directory, with no input, stopped (with every process it started) after `timeoutSeconds`. When it succeeds, the
 * content it ran is recorded (`setupRecord`), so it is not run again until it changes. It exits with the script's
 * status; one stopped for its time ends with `SETUP_TIMED_OUT_MESSAGE` (`scriptTimedOut`).
 */
export const setupScriptRun = (
  script: SetupScript,
  state: string = SETUP_STATE_DIRECTORY,
  timeoutSeconds: number = SETUP_TIMEOUT_SECONDS,
): string =>
  scriptRun(
    script,
    timeoutSeconds,
    SETUP_TIMED_OUT_MESSAGE,
    `  mkdir -p ${shellQuote(state)} && printf '%s\\n' "$hash" > ${shellQuote(setupRecord(script.record, state))} || exit 1`,
  );

/**
 * The bash script that writes the Environment's Setup Script `source` to `file`, then runs it in `root`
 * (`setupScriptRun`, which records it under `ENVIRONMENT_SETUP_RECORD` when it succeeds), whether or not it is due: for
 * a Build, which runs it in its scratch root (`@cloudpid/sandbox-image/builds`). The bootstrap writes it and runs it
 * only when due (`pendingSetupScripts`).
 */
export const environmentSetupScriptRun = (
  source: string,
  root: string = WORKSPACE_ROOT,
  file: string = ENVIRONMENT_SETUP_FILE,
  state: string = SETUP_STATE_DIRECTORY,
  timeoutSeconds: number = SETUP_TIMEOUT_SECONDS,
): string =>
  `${writeScript(source, file)}\n${setupScriptRun(environmentSetupScript(root, file), state, timeoutSeconds)}`;

/**
 * `setupScriptRun` of the repo in `directory`, only when its Setup Script is due: there is one, and it is not the one
 * that last succeeded there. It exits 0 without running anything otherwise. For a repo cloned after the Container
 * started, which the bootstrap did not see.
 */
export const setupScriptRunIfDue = (
  directory: string,
  state: string = SETUP_STATE_DIRECTORY,
  timeoutSeconds: number = SETUP_TIMEOUT_SECONDS,
  root: string = WORKSPACE_ROOT,
): string => `
[ -f ${shellQuote(`${directory}/${SETUP_SCRIPT}`)} ] || exit 0
[ "$(cat ${shellQuote(setupRecord(setupRecordName(directory, root), state))} 2>/dev/null)" = "$(${sha256(shellQuote(`${directory}/${SETUP_SCRIPT}`))})" ] && exit 0
${setupScriptRun(repoSetupScriptOf(directory, root), state, timeoutSeconds)}`;

/** The bash script that prints, one per line, each repo directly below `root` that has a Start Script (`START_SCRIPT`). */
export const startScriptDirectories = (root: string = WORKSPACE_ROOT): string => `
root=${shellQuote(root)}
for dir in "$root"/*/; do
  dir=\${dir%/}
  [ -f "$dir"/${START_SCRIPT} ] && printf '%s\\n' "$dir"
done
exit 0
`;

/**
 * The bash script that runs the Start Script `script` (a repo's: `{ directory, file: START_SCRIPT }`) as
 * `setupScriptRun` runs a Setup Script, bounded by `timeoutSeconds`, but records nothing: it runs at every Container
 * start. One stopped for its time ends with `START_TIMED_OUT_MESSAGE` (`scriptTimedOut`). The run ends when the script
 * and what holds its output have: a service it starts must detach (`setsid nohup cmd >/tmp/cmd.log 2>&1 &`).
 */
export const startScriptRun = (
  script: ContainerScript,
  timeoutSeconds: number = START_TIMEOUT_SECONDS,
): string => scriptRun(script, timeoutSeconds, START_TIMED_OUT_MESSAGE);

/**
 * The bash script that writes the Environment's Start Script `source` to `file`, then runs it in the Workspace root
 * (`startScriptRun`).
 */
export const environmentStartScriptRun = (
  source: string,
  root: string = WORKSPACE_ROOT,
  file: string = ENVIRONMENT_START_FILE,
  timeoutSeconds: number = START_TIMEOUT_SECONDS,
): string =>
  `${writeScript(source, file)}\n${startScriptRun({ directory: root, file }, timeoutSeconds)}`;

/**
 * `startScriptRun` of the repo in `directory`, when it has a Start Script; it exits 0 without running anything
 * otherwise. For a repo cloned after the Container started, which the bootstrap did not see.
 */
export const startScriptRunIfThere = (
  directory: string,
  timeoutSeconds: number = START_TIMEOUT_SECONDS,
): string => `
[ -f ${shellQuote(`${directory}/${START_SCRIPT}`)} ] || exit 0
${startScriptRun({ directory, file: START_SCRIPT }, timeoutSeconds)}`;
