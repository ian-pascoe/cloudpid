// Repos in a Workspace (`docs/spec.md` → Filesystem and tools): which directories below `/workspace` are git repositories,
// and cloning one into the Workspace. The clone runs on the Container, which has the network and the GitHub token; the
// Worker Shell has neither. Both are for the owner's UI (`RegistryRpcs`), and neither starts a Session.
// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { REPO_NAME, type RepoSource, repoDirectory, WORKSPACE_ROOT } from "@cloudpid/protocol";
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

/**
 * Clone `source` into `/workspace/<name>` through `shell` (the Container's). Only `https` is allowed to `git`
 * (`GIT_ALLOW_PROTOCOL`), whatever a URL or a redirect asks for. Rejects with git's last output when it fails.
 */
export const cloneInto = async (
  shell: Pick<Shell, "exec">,
  source: RepoSource,
  context: Context = BACKGROUND_CONTEXT,
): Promise<void> => {
  let output = "";

  const result = await shell.exec(
    cloneCommand(source),
    {
      cwd: WORKSPACE_ROOT,
      env: { GIT_ALLOW_PROTOCOL: "https", GIT_TERMINAL_PROMPT: "0" },
      timeout: CLONE_TIMEOUT_SECONDS,
      onOutput: (text) => {
        output = (output + text).slice(-REPORTED_OUTPUT * 2);
      },
    },
    context,
  );

  if (!result.ok) {
    throw new Error(
      result.error.code === "timeout"
        ? `The clone did not finish in ${CLONE_TIMEOUT_SECONDS / 60} minutes`
        : `The clone could not run: ${result.error.message}`,
    );
  }

  if (result.value.exitCode !== 0) {
    const tail = output.trim().slice(-REPORTED_OUTPUT);

    throw new Error(
      tail === ""
        ? `git clone failed (exit ${result.value.exitCode})`
        : `git clone failed (exit ${result.value.exitCode}): ${tail}`,
    );
  }
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

/** The directories below `/workspace` that hold a `.git`, by name: hidden directories and anything that is not a plain name are not repos. */
export const listRepos = async (files: Directories): Promise<ReadonlyArray<string>> => {
  const root = await files.readdir(WORKSPACE_ROOT).catch(() => []);

  const candidates = root.filter(
    (entry) => entry.isDirectory && !entry.isSymbolicLink && REPO_NAME.test(entry.name),
  );

  const repos = await Promise.all(
    candidates.map(async ({ name }) => {
      const inside = await files.readdir(repoDirectory(name)).catch(() => []);

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

/** The repos of the Workspace DOs `namespace` holds, listed from their files and cloned on their Containers. */
export const workspaceRepos = (namespace: WorkspaceNamespace): Repos => ({
  list: async (slug) => {
    const { ComputerFiles } = await computer();

    return listRepos(new ComputerFiles(namespace.getByName(slug)));
  },
  clone: async (slug, source) => {
    const { ComputerExecutionEnv } = await computer();

    const container = new ComputerExecutionEnv({
      workspace: namespace.getByName(slug),
      // The id the Session's environment has, so both see the same files.
      id: `computer:${slug}`,
      cwd: WORKSPACE_ROOT,
    }).onBackend("container");

    try {
      await cloneInto(container, source);
    } finally {
      await container.cleanup(BACKGROUND_CONTEXT);
    }
  },
});
