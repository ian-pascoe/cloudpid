// @effect-diagnostics preferEffectArray:off asyncFunction:off missingPipeableSignature:off nodeBuiltinImport:off extendsNativeError:off newPromise:off -- native array methods over plain values (the bundle carries no Effect runtime); plain Promises, as pi's extension API and child processes give them; plain functions over values, called directly; runs on node, on the owner's machine; errors the command tells apart with instanceof; wraps a callback API (a child process, a timer).
/**
 * The owner's git (docs/architecture/mcp-endpoint.md → Session import → The working tree): the repo's `origin`, the
 * branch and what of it is on the remote, and the one commit of uncommitted Changes read through a private index and
 * pushed to the import's `carry_ref`. A port of `carryWorkspaceScript`'s `carry()` (`apps/sandbox-image/src/workspaces.ts`),
 * which does the same in a Workspace's clone: the local index and work tree are never touched.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitOptions {
  /** `GIT_INDEX_FILE`: an index of its own. */
  readonly indexFile?: string;
}

/** Runs git in a directory; tests and the command both use the real one. */
export type Git = (args: ReadonlyArray<string>, options?: GitOptions) => Promise<GitResult>;

/** A git command that failed, with git's own words. */
export class GitError extends Error {
  override readonly name = "GitError";
}

/** Git could not be run at all: it is not installed (or not on `PATH`), or the directory is gone. */
export class GitMissing extends Error {
  override readonly name = "GitMissing";
}

/** Git in `cwd`. It never prompts for a credential on the terminal pi owns, and never runs a hook it is told to skip. */
export const gitIn =
  (cwd: string): Git =>
  (args, options = {}) =>
    new Promise((resolve, reject) => {
      const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

      const child = spawn("git", [...args], {
        cwd,
        env: options.indexFile === undefined ? env : { ...env, GIT_INDEX_FILE: options.indexFile },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const out: Array<Buffer> = [];
      const err: Array<Buffer> = [];

      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (error: NodeJS.ErrnoException) => {
        reject(
          error.code === "ENOENT"
            ? new GitMissing(`could not run git in ${cwd}: it is not installed, or not on PATH`, {
                cause: error,
              })
            : error,
        );
      });
      child.on("close", (code) => {
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        });
      });
    });

/** What a push or a read of the remote is run with: hooks off, as the Workspace's own pushes are. */
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"] as const;

/** `git <args>`'s trimmed stdout, or a {@link GitError} with its stderr. */
export const read = async (
  git: Git,
  args: ReadonlyArray<string>,
  options?: GitOptions,
): Promise<string> => {
  const result = await git(args, options);

  if (result.code !== 0) {
    throw new GitError(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }

  return result.stdout.trim();
};

/** `git <args>`'s trimmed stdout when it succeeded, else undefined. */
const tryRead = async (git: Git, args: ReadonlyArray<string>): Promise<string | undefined> => {
  const result = await git(args);

  return result.code === 0 ? result.stdout.trim() : undefined;
};

export interface Checkout {
  readonly root: string;
  /** `origin`'s URL as the repo has it; none for a repo with no `origin`. */
  readonly origin: string | undefined;
}

/** The repo around the working directory, or none when it is not in one. */
export const checkoutOf = async (git: Git): Promise<Checkout | undefined> => {
  const root = await tryRead(git, ["rev-parse", "--show-toplevel"]);

  if (root === undefined || root === "") return undefined;

  // The URL as the repo's config has it, not as `url.<base>.insteadOf` rewrites it: the owner's own `origin`.
  const origin = (await tryRead(git, ["config", "--get", "remote.origin.url"])) ?? "";

  return { root, origin: origin === "" ? undefined : origin };
};

/** `origin`'s URL as git resolves it, with `url.<base>.insteadOf` applied: what a clone of it would use. */
export const expandedOriginOf = (git: Git): Promise<string | undefined> =>
  tryRead(git, ["remote", "get-url", "origin"]);

export interface Head {
  /** HEAD's commit; none in a repo with no commit. */
  readonly commit: string | undefined;
  /** The local branch; none for a detached HEAD. */
  readonly branch: string | undefined;
  /** The branch's upstream when it is on `origin`: its name there. */
  readonly upstream: string | undefined;
}

export const headOf = async (git: Git): Promise<Head> => {
  const commit = await tryRead(git, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  const branch = await tryRead(git, ["symbolic-ref", "--quiet", "--short", "HEAD"]);

  if (branch === undefined) return { commit, branch, upstream: undefined };

  const remote = await tryRead(git, ["config", "--get", `branch.${branch}.remote`]);
  const merge = await tryRead(git, ["config", "--get", `branch.${branch}.merge`]);

  const upstream =
    remote === "origin" && merge?.startsWith("refs/heads/") === true
      ? merge.slice("refs/heads/".length)
      : undefined;

  return { commit, branch, upstream };
};

/** `origin`'s default branch: its `HEAD` as the clone knows it, else as the remote says it, else `main` or `master`. */
export const defaultBranchOf = async (git: Git, head: Head): Promise<string | undefined> => {
  const known = await tryRead(git, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);

  if (known?.startsWith("origin/") === true) return known.slice("origin/".length);

  const asked = await tryRead(git, ["ls-remote", "--symref", "origin", "HEAD"]);
  const match = asked === undefined ? null : /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(asked);

  if (match?.[1] !== undefined) return match[1];

  return head.branch === "main" || head.branch === "master" ? head.branch : undefined;
};

/** Whether `name` is a branch name git takes, and no local branch has it. */
export const branchNameProblem = async (git: Git, name: string): Promise<string | undefined> => {
  if ((await git(["check-ref-format", "--branch", name])).code !== 0) {
    return `${name} is not a branch name git accepts`;
  }

  const taken = await git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`]);

  return taken.code === 0 ? `a local branch ${name} exists already` : undefined;
};

export interface PushPlan {
  /** What is on `origin`'s branch: none when the branch is new. */
  readonly remote: string | undefined;
  /** The commits the push adds, newest first (`<abbreviated sha> <subject>`), at most {@link LISTED_COMMITS}. */
  readonly commits: ReadonlyArray<string>;
  /** How many commits the push adds. */
  readonly count: number;
  /** The remote branch has commits this HEAD lacks (it is ahead, or has diverged): pushing would not fast-forward. */
  readonly behind: boolean;
}

export const LISTED_COMMITS = 5;

/** `ls-remote`'s commit for `refs/heads/<branch>`, none when `origin` lacks the branch. */
const remoteTip = async (git: Git, branch: string): Promise<string | undefined> => {
  const listing = await read(git, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);

  return listing === "" ? undefined : listing.split(/\s+/)[0];
};

/** What pushing HEAD as `origin`'s `branch` would add, and whether it would fast-forward. */
export const planPush = async (git: Git, head: string, branch: string): Promise<PushPlan> => {
  const remote = await remoteTip(git, branch);

  let range: ReadonlyArray<string>;

  if (remote === undefined) {
    range = ["HEAD", "--not", "--remotes=origin"];
  } else if (remote === head) {
    return { remote, commits: [], count: 0, behind: false };
  } else {
    // The tip may be a commit pushed from elsewhere: fetch just it, to compare.
    if ((await git(["cat-file", "-e", `${remote}^{commit}`])).code !== 0) {
      await read(git, [...NO_HOOKS, "fetch", "--quiet", "origin", `refs/heads/${branch}`]);
    }

    if ((await git(["merge-base", "--is-ancestor", remote, head])).code !== 0) {
      return { remote, commits: [], count: 0, behind: true };
    }

    range = [`${remote}..HEAD`];
  }

  const count = Number(await read(git, ["rev-list", "--count", ...range]));

  const listed = await read(git, [
    "log",
    "--format=%h %s",
    `--max-count=${String(LISTED_COMMITS)}`,
    ...range,
  ]);

  return { remote, commits: listed === "" ? [] : listed.split("\n"), count, behind: false };
};

/** Fast-forward push of `head` as `origin`'s `branch`, hooks off: git refuses a push that is not one. */
export const pushBranch = async (git: Git, head: string, branch: string): Promise<void> => {
  const result = await git([
    ...NO_HOOKS,
    "push",
    "--quiet",
    "origin",
    `${head}:refs/heads/${branch}`,
  ]);

  if (result.code === 0) return;

  const said = result.stderr.trim();

  throw new GitError(
    /non-fast-forward|fetch first/.test(said)
      ? `origin's ${branch} has commits this checkout lacks: pull first, then run /cloudpid again.`
      : `git push failed: ${said}`,
  );
};

export interface Carry {
  /** The tree of HEAD's tree with the Changes in it. */
  readonly tree: string;
  /** The files the Changes touch, in git's order. */
  readonly files: ReadonlyArray<string>;
}

/**
 * The uncommitted Changes, tracked and untracked, never ignored, as a tree: HEAD's tree read into an index of its own,
 * everything not ignored added to it and written out. None when the tree is HEAD's own (nothing to carry).
 */
export const readCarry = async (git: Git, head: string): Promise<Carry | undefined> => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cloudpid-"));
  const indexFile = join(directory, "index");

  try {
    await read(git, ["read-tree", head], { indexFile });
    await read(git, ["add", "-A"], { indexFile });

    const tree = await read(git, ["write-tree"], { indexFile });

    if (tree === (await read(git, ["rev-parse", `${head}^{tree}`]))) return undefined;

    // Not `read`: it trims, and a name may begin or end with a space.
    const diff = await git(["diff-tree", "-r", "--no-renames", "--name-only", "-z", head, tree]);

    if (diff.code !== 0) throw new GitError(`git diff-tree failed: ${diff.stderr.trim()}`);

    return { tree, files: diff.stdout.split("\0").filter((name) => name !== "") };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

/** The Changes as one commit on `head` (the owner's name and email, else cloudpid's), and its id. */
export const commitCarry = async (
  git: Git,
  carry: Carry,
  head: string,
  branch: string,
): Promise<string> => {
  const name = (await tryRead(git, ["config", "user.name"])) ?? "cloudpid";

  const email =
    (await tryRead(git, ["config", "user.email"])) ?? "cloudpid@users.noreply.github.com";

  return read(git, [
    "-c",
    `user.name=${name}`,
    "-c",
    `user.email=${email}`,
    "commit-tree",
    carry.tree,
    "-p",
    head,
    "-m",
    `cloudpid: uncommitted changes carried to ${branch}`,
  ]);
};

/** Force-pushes `commit` to `ref`, hooks off. */
export const pushCarry = async (git: Git, commit: string, ref: string): Promise<void> => {
  await read(git, [...NO_HOOKS, "push", "--quiet", "--force", "origin", `${commit}:${ref}`]);
};

/** Takes `ref` off `origin` when it is there; true when it was. */
export const deleteRemoteRef = async (git: Git, ref: string): Promise<boolean> => {
  const listing = await read(git, ["ls-remote", "origin", ref]);

  if (listing === "") return false;

  await read(git, [...NO_HOOKS, "push", "--quiet", "origin", `:${ref}`]);

  return true;
};

/** `git switch -c <name>` from HEAD: the work tree and index come along as they are. */
export const switchNew = async (git: Git, name: string): Promise<void> => {
  await read(git, ["switch", "-c", name]);
};

/** `git stash push -u -m <message>`: the owner's Changes, untracked files included, put aside. */
export const stashAll = async (git: Git, message: string): Promise<void> => {
  await read(git, ["stash", "push", "--include-untracked", "-m", message]);
};
