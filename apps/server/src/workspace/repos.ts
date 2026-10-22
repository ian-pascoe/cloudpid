// Repos in a Workspace (`docs/spec.md` → Filesystem and tools): which directories below `/workspace` are git repositories,
// cloning one into the Workspace, and removing one. The clone runs on the Container, which has the network and the GitHub
// token; the Worker Shell has neither. The removal runs there too, so what only the Container's disk holds under the
// directory (its Container-only paths) goes with it. All are for the owner's UI (`RegistryRpcs`), and none starts a Session.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { isRepoName, type RepoSource, repoDirectory, WORKSPACE_ROOT } from "@cloudpid/protocol";
import type { Shell } from "@earendil-works/pi-durable/env";
import type { WorkspaceNamespace } from "../session/workspace.ts";

/** How long a clone may take, in seconds: a big repository over the Container's network, after a cold start. */
export const CLONE_TIMEOUT_SECONDS = 10 * 60;

/** How much of git's output a failure reports, from its end, where the error is. */
const REPORTED_OUTPUT = 2_000;

/** The repos of a Workspace and the means to add one. */
export type Repos = {
  /** The names of the directories below `/workspace` that hold a git repository, in name order. */
  readonly list: (slug: string) => Promise<ReadonlyArray<string>>;
  /** Clone `source.url` into `/workspace/<source.name>`. Rejects with git's message when it does not finish. */
  readonly clone: (slug: string, source: RepoSource) => Promise<void>;
  /** Delete `/workspace/<name>`, on the Container. Rejects with why when the directory is still there. */
  readonly remove: (slug: string, name: string) => Promise<void>;
};

/**
 * `git clone -- <url> <name>` as an argument vector, which `exec` runs without a shell, so neither reaches one. The
 * `--` ends git's options, so a value cannot be taken for one (they are validated not to start with `-` besides).
 */
export const cloneCommand = (source: RepoSource): ReadonlyArray<string> => [
  "git",
  "clone",
  "--",
  source.url,
  source.name,
];

/** How long a removal may take, in seconds: a big tree, dependency directories included, after a cold start. */
export const REMOVE_TIMEOUT_SECONDS = 5 * 60;

/**
 * `rm -rf -- <name>` as an argument vector, run in `/workspace` without a shell. The name is a repo name (`isRepoName`),
 * so it is one directory directly below `/workspace`, never a path, `.`, `..` or an option; `--` ends `rm`'s options
 * besides.
 */
export const removeCommand = (name: string): ReadonlyArray<string> => ["rm", "-rf", "--", name];

/** What a command run in `/workspace` is called in its failures. */
type Doing = {
  /** The noun: "The clone did not finish". */
  readonly noun: string;
  /** The program, in "git clone failed (exit 128)". */
  readonly program: string;
  readonly timeoutSeconds: number;
  readonly env?: Readonly<Record<string, string>>;
};

/** Run `command` in `/workspace` through `shell`. Rejects with the end of its output when it does not exit 0. */
const runInWorkspace = async (
  shell: Pick<Shell, "exec">,
  command: ReadonlyArray<string>,
  doing: Doing,
  context: Context,
): Promise<void> => {
  let output = "";

  const options: NonNullable<Parameters<Shell["exec"]>[1]> = {
    cwd: WORKSPACE_ROOT,
    timeout: doing.timeoutSeconds,
    onOutput: (text) => {
      output = (output + text).slice(-REPORTED_OUTPUT * 2);
    },
  };

  if (doing.env !== undefined) options.env = doing.env;

  const result = await shell.exec(command, options, context);

  if (!result.ok) {
    throw new Error(
      result.error.code === "timeout"
        ? `The ${doing.noun} did not finish in ${doing.timeoutSeconds / 60} minutes`
        : `The ${doing.noun} could not run: ${result.error.message}`,
    );
  }

  if (result.value.exitCode !== 0) {
    const tail = output.trim().slice(-REPORTED_OUTPUT);

    throw new Error(
      tail === ""
        ? `${doing.program} failed (exit ${result.value.exitCode})`
        : `${doing.program} failed (exit ${result.value.exitCode}): ${tail}`,
    );
  }
};

/**
 * Clone `source` into `/workspace/<name>` through `shell` (the Container's). Only `https` is allowed to `git`
 * (`GIT_ALLOW_PROTOCOL`), whatever a URL or a redirect asks for. Rejects with git's last output when it fails.
 */
export const cloneInto = (
  shell: Pick<Shell, "exec">,
  source: RepoSource,
  context: Context = BACKGROUND_CONTEXT,
): Promise<void> =>
  runInWorkspace(
    shell,
    cloneCommand(source),
    {
      noun: "clone",
      program: "git clone",
      timeoutSeconds: CLONE_TIMEOUT_SECONDS,
      env: { GIT_ALLOW_PROTOCOL: "https", GIT_TERMINAL_PROMPT: "0" },
    },
    context,
  );

/**
 * Delete `/workspace/<name>` through `shell` (the Container's), with what only the Container holds under it (the
 * ignored dependency directories and build output), which a deletion in the Workspace's files would leave on its disk.
 * Rejects a name that is not a repo name before anything runs, and with `rm`'s last output when it fails.
 */
export const removeFrom = async (
  shell: Pick<Shell, "exec">,
  name: string,
  context: Context = BACKGROUND_CONTEXT,
): Promise<void> => {
  if (!isRepoName(name)) throw new Error(`"${name}" is not a repo name`);

  await runInWorkspace(
    shell,
    removeCommand(name),
    { noun: "removal", program: "rm", timeoutSeconds: REMOVE_TIMEOUT_SECONDS },
    context,
  );
};

/** What listing needs of the Workspace's files: `ComputerFiles.readdir`. */
export type Directories = {
  readonly readdir: (path: string) => Promise<
    ReadonlyArray<{
      readonly name: string;
      readonly isDirectory: boolean;
      readonly isSymbolicLink: boolean;
    }>
  >;
};

/**
 * Whether `cause` says a path is not there (or is not a directory). The Workspace DO's error reaches here over RPC, which may
 * keep only its message, so the POSIX code is read from the error and, failing that, from the message.
 */
export const isMissing = (cause: unknown): boolean => {
  if (!(cause instanceof Error)) return false;

  const code = "code" in cause ? String(cause.code) : "";

  return (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    /\b(ENOENT|ENOTDIR)\b|no such file/i.test(cause.message)
  );
};

/** `readdir`, where a path that is not there lists nothing; any other failure is the caller's. */
const entriesOf = (files: Directories, path: string) =>
  files.readdir(path).catch((cause: unknown) => {
    if (isMissing(cause)) return [];

    throw cause;
  });

/**
 * The directories below `/workspace` that hold a `.git`, by name: hidden directories and anything that is not a valid repo
 * name are not repos. A `/workspace` that is not there yet holds none; a failure to read anything else rejects, so a
 * Workspace that cannot be read is not mistaken for one with no repos.
 */
export const listRepos = async (files: Directories): Promise<ReadonlyArray<string>> => {
  const root = await entriesOf(files, WORKSPACE_ROOT);

  const candidates = root.filter(
    (entry) => entry.isDirectory && !entry.isSymbolicLink && isRepoName(entry.name),
  );

  const repos = await Promise.all(
    candidates.map(async ({ name }) => {
      const inside = await entriesOf(files, repoDirectory(name));

      return inside.some((entry) => entry.name === ".git") ? name : undefined;
    }),
  );

  return repos.filter((name) => name !== undefined).sort();
};

/**
 * `@cloudpid/computer-env` loads on first use. `@cloudflare/computer` imports `cloudflare:workers`, which Node cannot
 * load, and the deploy loads the Server's module graph, this file included, in Node.
 */
const computer = () => import("@cloudpid/computer-env");

/** The Container's shell of Workspace `slug`, for one call, cleaned up after it. */
const onContainer = async (
  namespace: WorkspaceNamespace,
  slug: string,
  run: (shell: Pick<Shell, "exec">) => Promise<void>,
): Promise<void> => {
  const { ComputerExecutionEnv } = await computer();

  const container = new ComputerExecutionEnv({
    workspace: namespace.getByName(slug),
    // The id the Session's environment has, so both see the same files.
    id: `computer:${slug}`,
    cwd: WORKSPACE_ROOT,
  }).onBackend("container");

  try {
    await run(container);
  } finally {
    await container.cleanup(BACKGROUND_CONTEXT);
  }
};

/**
 * Whether `/workspace` still has an entry `name` once it was removed on the Container: the deletion reaches the
 * Workspace's files through computer's sync after the command, so one still listed did not.
 */
export const stillThere = async (files: Directories, name: string): Promise<boolean> =>
  (await entriesOf(files, WORKSPACE_ROOT)).some((entry) => entry.name === name);

/** The repos of the Workspace DOs `namespace` holds, listed from their files and cloned and removed on their Containers. */
export const workspaceRepos = (namespace: WorkspaceNamespace): Repos => ({
  list: async (slug) => {
    const { ComputerFiles } = await computer();

    return listRepos(new ComputerFiles(namespace.getByName(slug)));
  },
  clone: (slug, source) => onContainer(namespace, slug, (shell) => cloneInto(shell, source)),
  remove: async (slug, name) => {
    await onContainer(namespace, slug, (shell) => removeFrom(shell, name));

    const { ComputerFiles } = await computer();

    if (await stillThere(new ComputerFiles(namespace.getByName(slug)), name)) {
      throw new Error(`${repoDirectory(name)} is still in the Workspace's files`);
    }
  },
});
