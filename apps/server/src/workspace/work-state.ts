// What a Workspace's clones have not pushed (docs/architecture/agent-capabilities.md → Subagents; ADR-0021, ADR-0022):
// a Subagent Workspace's report and delete, and the warning a spawn from a Workspace gives. The backend is chosen
// inside, as for the Changes:
//
// - while the Container runs, its git reads every repo (`workStateScript`), as it sees the files the Workspace DO has
//   not synced yet;
// - otherwise the Workspace DO reads each repo itself with isomorphic-git, over the files the last sync left, and
//   starts no Container: `statusMatrix({ refresh: false })` for the uncommitted Changes, counted as `git status
//   --porcelain` lines, and a walk of the commits for `rev-list --count <branch> --not --remotes`;
// - a repo the Workspace DO cannot read (the Changes' guard: rules git applies, a big pack, many files; submodules, a
//   `.git` that is not a directory, a walk past `MAX_WALKED_COMMITS`, or isomorphic-git failing) is read by the
//   Container's git as before, starting it, and the log says why.
// @effect-diagnostics asyncFunction:off preferEffectArray:off missingPipeableSignature:off extendsNativeError:off
import { isRepoName, WORKSPACE_ROOT } from "@cloudpid/protocol";
import {
  parseWorkState,
  type RepoWorkState,
  workStateScript,
} from "@cloudpid/sandbox-image/workspaces";
import * as git from "isomorphic-git";
import {
  type ChangesFiles,
  type ContainerOnly,
  errorText,
  type Fs,
  type GitCache,
  isNotFound,
  readOnly,
  settled,
  toText,
} from "./changes.ts";

/**
 * The most commits the Workspace DO reads to count a branch's unpushed ones before it leaves the repo to the Container's
 * git: a branch with no remote branch below it (a repo with no remote refs) walks its whole history.
 */
export const MAX_WALKED_COMMITS = 10_000;

/** A run of a script on the Container: its exit code (null when it did not run) and its two streams. */
type ContainerRun = {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export type WorkStateOptions = {
  readonly files: () => ChangesFiles;
  /** Whether `repo` is the Container's git's to read, by the Changes' guard (`WorkspaceChangesModule.needsContainer`). */
  readonly needsContainer: (repo: string) => Promise<boolean>;
  /**
   * Which absolute paths are Container-only (ADR-0018): never in the Workspace DO's files, so left out of what it
   * counts.
   */
  readonly containerOnly: () => Promise<ContainerOnly>;
  /** Whether the Container runs now. */
  readonly running: () => boolean;
  /** Run `script` on the Container, starting it if it is stopped. */
  readonly run: (script: string) => Promise<ContainerRun>;
  readonly warn: (message: string) => void;
  /** Defaults to `MAX_WALKED_COMMITS`. */
  readonly maxWalkedCommits?: number | undefined;
};

/** A repo the Workspace DO leaves to the Container's git, and why. */
class NeedsContainer extends Error {}

export class WorkspaceWorkStateModule {
  readonly #options: WorkStateOptions;

  constructor(options: WorkStateOptions) {
    this.#options = options;
  }

  /**
   * What the clones of `repos` have not pushed of `branch`, one state per Repo in order, as `workStateScript` reads it.
   * It starts the Container only for a repo the Workspace DO cannot read. Rejects when the Container's read fails.
   */
  async read(branch: string, repos: ReadonlyArray<string>): Promise<RepoWorkState[]> {
    if (this.#options.running()) return this.#onContainer(branch, repos);

    const read = new Map<string, RepoWorkState>();
    const fallback: string[] = [];

    for (const repo of repos) {
      try {
        read.set(repo, await this.#readOwn(repo, branch));
      } catch (cause) {
        this.#options.warn(
          cause instanceof NeedsContainer
            ? `work state: ${repo} needs the Container's git (${cause.message}); starting it to read the repo`
            : `work state: isomorphic-git failed in ${repo}, starting the Container to read it: ${errorText(cause)}`,
        );
        fallback.push(repo);
      }
    }

    if (fallback.length > 0) {
      for (const state of await this.#onContainer(branch, fallback)) read.set(state.repo, state);
    }

    return repos.map((repo) => read.get(repo) ?? notCloned(repo));
  }

  /** The Container's git's read of `repos` (`workStateScript`), starting it if it is stopped. */
  async #onContainer(branch: string, repos: ReadonlyArray<string>): Promise<RepoWorkState[]> {
    const ran = await this.#options.run(workStateScript(repos, branch));

    if (ran.exitCode !== 0) {
      throw new Error(
        `The workspace's repos could not be read: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`,
      );
    }

    // Its own lines have six tab-separated fields: anything else the run printed is left out, and a Repo it printed no
    // line for is taken as not cloned.
    return parseWorkState(ran.stdout, repos);
  }

  /** The Workspace DO's own read of `repo`, as `workStateScript` reads it. Throws `NeedsContainer` for git's repos. */
  async #readOwn(repo: string, branch: string): Promise<RepoWorkState> {
    if (!isRepoName(repo)) throw new NeedsContainer("not a Repo name");

    const files = settled(this.#options.files());
    const dir = `${WORKSPACE_ROOT}/${repo}`;
    const containerOnly = await this.#options.containerOnly();

    if (containerOnly(dir) || containerOnly(`${dir}/.git`)) {
      throw new NeedsContainer("its clone is on a Container-only path");
    }

    let gitdir: Awaited<ReturnType<ChangesFiles["stat"]>>;

    try {
      gitdir = await files.stat(`${dir}/.git`);
    } catch (cause) {
      // As the script's `[ ! -e "$dir/.git" ]`.
      if (isNotFound(cause)) return notCloned(repo);

      throw cause;
    }

    if (!gitdir.isDirectory()) throw new NeedsContainer("its .git is not a directory");

    if (await this.#options.needsContainer(repo)) {
      throw new NeedsContainer("rules git applies, a big pack or many tracked files");
    }

    if (await exists(files, `${dir}/.gitmodules`)) throw new NeedsContainer("it has submodules");

    const fs = readOnly(files);
    const cache: GitCache = {};

    // `git symbolic-ref --quiet --short HEAD`: the branch HEAD names, with or without commits; none when detached.
    const head = (await git.currentBranch({ fs, dir, fullname: false })) ?? null;

    const matrix = await git.statusMatrix({ fs, dir, cache, refresh: false });
    const uncommitted = porcelainLines(matrix, (path) => containerOnly(`${dir}/${path}`));

    const tip = await refOid(fs, dir, `refs/heads/${branch}`);
    const onRemote = (await refOid(fs, dir, `refs/remotes/origin/${branch}`)) !== null;

    const unpushed =
      tip === null
        ? 0
        : await unpushedCommits({
            fs,
            dir,
            cache,
            tip,
            remotes: await remoteTips(fs, dir),
            shallow: await shallowCommits(files, `${dir}/.git/shallow`),
            max: this.#options.maxWalkedCommits ?? MAX_WALKED_COMMITS,
          });

    return { repo, cloned: true, uncommitted, unpushed, onRemote, head };
  }
}

const notCloned = (repo: string): RepoWorkState => ({
  repo,
  cloned: false,
  uncommitted: 0,
  unpushed: 0,
  onRemote: false,
  head: null,
});

const exists = async (files: ChangesFiles, path: string): Promise<boolean> => {
  try {
    await files.lstat(path);

    return true;
  } catch (cause) {
    if (isNotFound(cause)) return false;

    throw cause;
  }
};

/** The commit `ref` (a full ref name) points at; null when the repo has no such ref. */
const refOid = async (fs: Fs, dir: string, ref: string): Promise<string | null> => {
  try {
    return await git.resolveRef({ fs, dir, ref });
  } catch (cause) {
    if (isNotFound(cause)) return null;

    throw cause;
  }
};

/** The commits every ref under `refs/remotes` points at, loose or packed (`--remotes`). */
const remoteTips = async (fs: Fs, dir: string): Promise<string[]> => {
  const tips = new Set<string>();

  for (const name of await git.listRefs({ fs, dir, filepath: "refs/remotes" })) {
    tips.add(await git.resolveRef({ fs, dir, ref: `refs/remotes/${name}` }));
  }

  return [...tips];
};

/** The commits a shallow clone has no parents of (`.git/shallow`), which git takes as having none. */
const shallowCommits = async (files: ChangesFiles, path: string): Promise<Set<string>> => {
  try {
    return new Set(
      toText(await files.readFile(path, "utf8"))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    );
  } catch (cause) {
    if (isNotFound(cause)) return new Set();

    throw cause;
  }
};

/** A `statusMatrix` row: path, then HEAD, working tree and index (isomorphic-git's numbers). */
export type StatusRow = readonly [string, number, number, number];

/**
 * How many lines `git status --porcelain` prints for `matrix`: one per path the index or HEAD has that is not as HEAD
 * has it, and one per untracked entry, an untracked file in a directory with no tracked file below it counted once as
 * that directory (git's default `--untracked-files=normal`). A path the index lost but the working tree still has is
 * both (`D ` and `??`). Rows `leftOut` names (Container-only paths) are not counted.
 */
export const porcelainLines = (
  matrix: ReadonlyArray<StatusRow>,
  leftOut: (path: string) => boolean,
): number => {
  const trackedDirectories = new Set<string>();

  for (const [path, , , index] of matrix) {
    if (index === 0) continue;

    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      trackedDirectories.add(path.slice(0, slash));
    }
  }

  let lines = 0;
  const untracked = new Set<string>();

  for (const [path, head, workdir, index] of matrix) {
    if (leftOut(path)) continue;

    if ((head !== 0 || index !== 0) && !(head === 1 && workdir === 1 && index === 1)) lines++;

    if (index === 0 && workdir !== 0) untracked.add(untrackedEntry(path, trackedDirectories));
  }

  return lines + untracked.size;
};

/** The entry `git status` shows an untracked file as: its topmost directory with no tracked file below it, or itself. */
const untrackedEntry = (path: string, trackedDirectories: ReadonlySet<string>): string => {
  for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
    const directory = path.slice(0, slash);

    if (!trackedDirectories.has(directory)) return `${directory}/`;
  }

  return path;
};

/** Reached from the branch. */
const BRANCH = 1;

/** Reached from a remote branch. */
const REMOTE = 2;

type Walked = { flags: number; readonly time: number; readonly parents: readonly string[] };

/**
 * How many commits `tip` reaches that no commit of `remotes` reaches (`git rev-list --count <tip> --not --remotes`).
 * The commits are walked newest first by committer date, each marked with what reaches it, until nothing left to walk
 * is reached from the branch alone and all of it is older than every commit counted: git's own walk, which assumes no
 * commit is older than its parents. Throws past `max` commits read, or for a commit the repo lacks.
 */
export const unpushedCommits = async (walk: {
  readonly fs: Fs;
  readonly dir: string;
  readonly cache: GitCache;
  readonly tip: string;
  readonly remotes: ReadonlyArray<string>;
  readonly shallow: ReadonlySet<string>;
  readonly max: number;
}): Promise<number> => {
  const { fs, dir, cache, shallow, max } = walk;
  const seen = new Map<string, Walked>();
  const queue = new Set<string>();

  const mark = async (oid: string, flags: number) => {
    let commit = seen.get(oid);

    if (commit === undefined) {
      if (seen.size >= max) throw new NeedsContainer(`more than ${max} commits to walk`);

      const read = await git.readCommit({ fs, dir, oid, cache });

      commit = {
        flags: 0,
        time: read.commit.committer.timestamp,
        parents: shallow.has(oid) ? [] : read.commit.parent,
      };
      seen.set(oid, commit);
    }

    if ((commit.flags | flags) === commit.flags) return;

    commit.flags |= flags;
    // Walked again when what reaches it grows, so its parents learn of it too.
    queue.add(oid);
  };

  await mark(walk.tip, BRANCH);

  for (const remote of walk.remotes) await mark(remote, REMOTE);

  let oldestCounted = Number.POSITIVE_INFINITY;

  while (queue.size > 0) {
    let next: string | undefined;
    let newest: Walked | undefined;
    let branchOnly = false;

    for (const oid of queue) {
      const commit = seen.get(oid);

      if (commit === undefined) continue;

      if (commit.flags === BRANCH) branchOnly = true;

      if (newest === undefined || commit.time > newest.time) {
        next = oid;
        newest = commit;
      }
    }

    if (next === undefined || newest === undefined) break;

    // Nothing left reaches a counted commit: what is left is reached from a remote branch only and is older.
    if (!branchOnly && newest.time < oldestCounted) break;

    queue.delete(next);

    if (newest.flags === BRANCH) oldestCounted = Math.min(oldestCounted, newest.time);

    for (const parent of newest.parents) await mark(parent, newest.flags);
  }

  let count = 0;

  for (const commit of seen.values()) if (commit.flags === BRANCH) count++;

  return count;
};
