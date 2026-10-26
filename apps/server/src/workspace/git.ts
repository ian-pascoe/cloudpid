// @effect-diagnostics asyncFunction:off preferEffectArray:off missingPipeableSignature:off
import { createGitClient, type GitClientFactory } from "@cloudflare/computer/git";
import type { GitCliInput, GitCliResult } from "@cloudflare/computer/git";
import * as Predicate from "effect/Predicate";

/**
 * The most packfile bytes the Worker Shell's git reads. isomorphic-git reads a whole packfile into memory, and the
 * Workspace DO that hosts it has 128 MB for everything, so a clone with a big pack could take the Workspace down with it.
 */
export const MAX_PACK_BYTES = 16 * 1024 * 1024;

type Provider = ReturnType<Parameters<GitClientFactory>[0]["ws"]["provider"]>;

/** The directory `git` runs in: `cwd`, or what a leading `-C <dir>` makes of it (the one `-C` the router lets through). */
const gitDirectory = ({ argv, cwd = "/" }: GitCliInput) => {
  const directory = argv[0] === "-C" ? argv[1] : undefined;

  const path =
    directory === undefined || directory === ""
      ? cwd
      : directory.startsWith("/")
        ? directory
        : `${cwd}/${directory}`;

  const segments: string[] = [];

  for (const segment of path.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }

  return segments;
};

/** What `packfileBytes` reads a repository's files through. */
type PackFiles = {
  readdir(path: string): Promise<ReadonlyArray<string | { readonly name: string }>>;
  stat(path: string): Promise<{ readonly size: number }>;
};

/**
 * The size of the packfiles of the repository whose `.git` is `gitdir`, which isomorphic-git reads whole. It rejects
 * where there is no pack directory.
 */
export const packfileBytes = async (files: PackFiles, gitdir: string): Promise<number> => {
  const pack = `${gitdir}/objects/pack`;
  let bytes = 0;

  for (const entry of await files.readdir(pack)) {
    const name = Predicate.isString(entry) ? entry : entry.name;

    if (name.endsWith(".pack")) bytes += (await files.stat(`${pack}/${name}`)).size;
  }

  return bytes;
};

/** The size of the packfiles of the repository `segments` is in (the nearest `.git` above it), 0 where there is none. */
const packBytes = async (provider: Provider, segments: readonly string[]) => {
  for (let depth = segments.length; depth >= 0; depth--) {
    const git = `/${segments.slice(0, depth).join("/")}/.git`.replace("//", "/");

    try {
      await provider.stat(git);
    } catch {
      continue;
    }

    return packfileBytes(provider, git).catch(() => 0);
  }

  return 0;
};

const tooLarge = (bytes: number): GitCliResult => ({
  stdout: "",
  stderr: `git: this repository's packfiles are ${Math.ceil(bytes / 1024 / 1024)} MB, more than the Worker Shell can read (limit ${MAX_PACK_BYTES / 1024 / 1024} MB). Rerun with backend: "container".\n`,
  exitCode: 1,
});

/**
 * computer's git client for the Worker Shell, built anew for every call, and refusing a repository with a big pack.
 *
 * One client keeps isomorphic-git's cache for as long as the Workspace lives, and that cache holds the index: a client that
 * read a repository while `.git/index` did not exist (after `git init`) keeps answering as if it still did, so after the
 * Container's git adds and commits, `git status` says every committed file is deleted and `git ls-files` lists nothing.
 * The cost is that each call reads the repository again, including its packfiles, whole, into the DO's memory: so a
 * command (`cli`, which the Worker Shell's `git` calls) in a repository whose packfiles total more than
 * {@link MAX_PACK_BYTES} fails with a message to rerun it on the Container.
 */
export const workerShellGit = (): GitClientFactory => {
  const create = createGitClient();

  return (options) =>
    // SAFETY: every member of a git client is a method, and the proxy forwards each call to a client of its own.
    new Proxy({} as ReturnType<GitClientFactory>, {
      get:
        (_target, name) =>
        async (...args: unknown[]) => {
          if (name === "cli") {
            // SAFETY: `cli` takes the Worker Shell's command.
            const bytes = await packBytes(
              options.ws.provider(),
              gitDirectory(args[0] as GitCliInput),
            );

            if (bytes > MAX_PACK_BYTES) return tooLarge(bytes);
          }

          const client = create(options);

          // SAFETY: `name` is a method of the client, as the proxy's only users call one.
          const method = client[name as keyof typeof client] as (...call: unknown[]) => never;

          return method.call(client, ...args);
        },
    });
};
