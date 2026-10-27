// Comparisons (GLOSSARY.md → Diffs and review; docs/spec.md → Diffs and review → Comparisons; ADR-0022): This branch, a
// branch's commits since it left its base, as the Workspace DO serves it, beside the Changes module and behind the same
// kind of seam. Three calls, the picker's repos, one repo's Comparison, and one file's two sides; no caller knows which
// backend ran:
//
// - the Container's git makes the Comparison in one command (`comparisonScript`): the remote, the base, a fetch of the
//   base into a private ref, the merge-base and the file list. Only a call that may start the Container does so;
// - the list is kept in the Workspace DO's storage, by (merge-base, head), so reopening it after the Container's idle
//   stop starts nothing;
// - a file's contents are read here with isomorphic-git's `readBlob` on the blob ids the list named, and the Container's
//   `git cat-file` is the fallback under Changes' guards (a pack over 16 MB, an object the DO does not have).
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalTimers:off globalFetch:off
import {
  type ChangeFile,
  type ChangeSide,
  type Comparison,
  type ComparisonError,
  type ComparisonSources,
  type CompareResult,
  isRepoName,
  MAX_CHANGE_SIDE_BYTES,
  MAX_CHANGED_FILES,
  OBJECT_ID,
  WORKSPACE_ROOT,
} from "@cloudpid/protocol";
import {
  blobsScript,
  comparisonScript,
  type ContainerComparison,
  parseBlobs,
  parseComparison,
} from "@cloudpid/sandbox-image/comparison";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as git from "isomorphic-git";
import { readAttributes } from "./attributes.ts";
import {
  type ChangesFiles,
  coveredRepos,
  entryOf,
  errorText,
  type Fs,
  isNotFound,
  isRepoPath,
  readHead,
  readOnly,
  settled,
  sideOf,
  toText,
  withFlags,
} from "./changes.ts";
import { MAX_PACK_BYTES, packfileBytes } from "./git.ts";

/** How many Comparisons of a repo are kept, by (merge-base, head); the oldest are dropped. */
export const KEPT_COMPARISONS = 5;

/** The largest list kept (JSON bytes): a bigger one is made again when asked for, as the storage's values are limited. */
const MAX_KEPT_BYTES = 1_500_000;

/** How long GitHub's REST API is waited for. */
const GITHUB_TIMEOUT_MS = 8_000;

/** The most characters of git's output an error shows (its end). */
const MAX_ERROR_CHARS = 2_000;

/** Where Comparisons are kept, under `<key>:<repo>` and `<key>:<repo>:<merge-base>:<head>`. */
export const COMPARISON_KEY = "cloudpid:comparison";

/** A file's blobs, as the list named them: their ids and sizes, null where there is no such side. */
type Blobs = {
  readonly oldId: string | null;
  readonly newId: string | null;
  readonly oldBytes: number | null;
  readonly newBytes: number | null;
};

/** A Comparison as kept: what the client is sent, and the blobs behind each file. */
export type KeptComparison = {
  readonly comparison: Comparison;
  readonly blobs: ReadonlyArray<readonly [string, Blobs]>;
};

/** The Comparison a repo last made: which one is the repo's now, and what chose its base. */
export type LastComparison = {
  readonly mergeBase: string;
  readonly head: string;
  readonly branch: string | null;
  readonly base: string;
};

export type ComparisonOptions = {
  readonly files: () => ChangesFiles;
  /** Whether the Container runs now. */
  readonly running: () => boolean;
  /** Run `script` on the Container, starting it if it is stopped. */
  readonly run: (script: string) => Promise<{
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  /** The Workspace DO's storage. */
  readonly store: {
    readonly get: <A>(key: string) => Promise<A | undefined>;
    readonly put: <A>(key: string, value: A) => Promise<void>;
    readonly delete: (key: string) => Promise<void>;
  };
  /** GitHub's REST API (the base of the branch's open pull request). */
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
  /** The GitHub token (`CLOUDPID_GITHUB_TOKEN`); absent, the API is asked without one. */
  readonly token: () => string | undefined;
  /** `text` with the GitHub token and the Environment's kept Secrets taken out. */
  readonly redact: (text: string) => string;
  readonly warn: (message: string) => void;
};

export type CompareRequest = {
  readonly repo: string;
  /** Whether the Container may be started (the owner's pick or Refresh). */
  readonly startContainer: boolean;
  /** Fetch the base again (the owner's Refresh). */
  readonly fetch: boolean;
};

export type ComparisonFileRequest = {
  readonly repo: string;
  readonly mergeBase: string;
  readonly head: string;
  readonly path: string;
  readonly oldPath?: string;
};

/** A repo on GitHub, from a remote's URL. */
export type GitHubRepo = { readonly owner: string; readonly name: string };

const GITHUB_URL =
  /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git@)github\.com[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/i;

/** The GitHub repo a remote URL names, or undefined for another host. */
export const githubRepoOf = (url: string): GitHubRepo | undefined => {
  const match = GITHUB_URL.exec(url.trim());

  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { owner: match[1], name: match[2] };
};

/**
 * Whether `name` is a branch name the Container's command may be given as the base: the characters branch names
 * are made of, never an option, a range or a path.
 */
export const isSafeBase = (name: string): boolean =>
  /^[A-Za-z0-9._/+@-]+$/.test(name) &&
  !name.startsWith("-") &&
  !name.startsWith("/") &&
  !name.endsWith("/") &&
  !name.endsWith(".lock") &&
  !name.includes("..") &&
  !name.includes("//") &&
  name.length <= 256;

const OpenPulls = Schema.Array(Schema.Struct({ base: Schema.Struct({ ref: Schema.String }) }));

const decodePulls = Schema.decodeUnknownOption(OpenPulls);

/** The error a result carries; its message has no secret and at most `MAX_ERROR_CHARS` characters, from the end. */
const problem = (
  kind: ComparisonError["kind"],
  message: string,
  redact: (text: string) => string,
  base?: string,
): CompareResult => {
  const redacted = redact(message).trim();
  const cut = redacted.length > MAX_ERROR_CHARS ? `…${redacted.slice(-MAX_ERROR_CHARS)}` : redacted;

  const error: ComparisonError =
    base === undefined ? { kind, message: cut } : { kind, message: cut, base };

  return { status: "error", error };
};

export class WorkspaceComparisonModule {
  readonly #options: ComparisonOptions;
  /** The calls running per repo, so two for one repo run one after the other (and the second finds the first's list). */
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: ComparisonOptions) {
    this.#options = options;
  }

  #files(): ChangesFiles {
    return settled(this.#options.files());
  }

  /** `work`, after the calls for `repo` that are already running. */
  #serial<A>(repo: string, work: () => Promise<A>): Promise<A> {
    const before = this.#queues.get(repo) ?? Promise.resolve();
    const run = before.then(work, work);

    const tail = run.then(
      () => undefined,
      () => undefined,
    );

    this.#queues.set(repo, tail);
    void tail.then(() => {
      if (this.#queues.get(repo) === tail) this.#queues.delete(repo);
    });

    return run;
  }

  /** What the picker lists: the repos `directory` covers, the Session's own first, each with its HEAD. */
  async sources(directory: string): Promise<ComparisonSources> {
    const files = this.#files();
    const fs = readOnly(files);
    const covered = await coveredRepos(files, directory);

    // The Session's own repo comes first by construction: a directory inside a repo covers that repo alone, and the
    // Workspace's root every repo, in order of name.
    const repos: Array<ComparisonSources["repos"][number]> = [];

    for (const repo of covered) {
      repos.push({ repo, head: await readHead(fs, `${WORKSPACE_ROOT}/${repo}`) });
    }

    return { repos };
  }

  /** The Comparison of `repo`'s branch, or why there is none. */
  async compare(request: CompareRequest): Promise<CompareResult> {
    const { repo } = request;

    if (!isRepoName(repo)) throw new Error("No such repo in the Workspace");

    const files = this.#files();
    const fs = readOnly(files);
    const dir = `${WORKSPACE_ROOT}/${repo}`;

    await files.stat(`${dir}/.git`).catch(() => {
      throw new Error(`${repo} is not a repo of the Workspace`);
    });

    return this.#serial(repo, () => this.#compare(request, files, fs, dir));
  }

  async #compare(
    request: CompareRequest,
    files: ChangesFiles,
    fs: Fs,
    dir: string,
  ): Promise<CompareResult> {
    const { repo } = request;
    const { redact } = this.#options;
    const head = await readHead(fs, dir);

    if (head.commit === null) return problem("failed", "This repo has no commits yet", redact);

    const last = await this.#options.store
      .get<LastComparison>(`${COMPARISON_KEY}:${repo}`)
      .catch(() => undefined);

    const kept = last === undefined ? undefined : await this.#kept(repo, last.mergeBase, last.head);

    // The HEAD is the one the last Comparison was made for: nothing to run, nothing to start.
    if (
      kept !== undefined &&
      last !== undefined &&
      last.head === head.commit &&
      last.branch === head.branch &&
      !request.fetch
    ) {
      return { status: "ok", comparison: kept.comparison };
    }

    const moved = head.commit;

    const stopped = (): CompareResult => {
      // HEAD moved and the Container is stopped: the last result stands, marked, for the Pane's "New commits".
      if (kept !== undefined && !request.fetch) {
        return { status: "ok", comparison: { ...kept.comparison, behind: moved } };
      }

      return problem(
        "needs_container",
        "Comparing needs the Container, which is stopped",
        redact,
        last?.base,
      );
    };

    if (!request.startContainer && !this.#options.running()) return stopped();

    const base = await this.#chooseBase(fs, dir, head.branch, request.fetch, last);

    // Looked at again right before the command: the base lookup waits on GitHub, and the Container may have stopped
    // meanwhile. The Workspace DO has no call that runs a command only if the Container runs (Changes has none either), so
    // what is left is the gap between this check and the command's start.
    if (!request.startContainer && !this.#options.running()) return stopped();

    const input =
      base === undefined ? { repo, fetch: request.fetch } : { repo, base, fetch: request.fetch };

    let parsed: ReturnType<typeof parseComparison>;

    try {
      const ran = await this.#options.run(comparisonScript(input));

      parsed =
        ran.stdout.trim() === "" && ran.exitCode !== 0
          ? {
              ok: false,
              kind: "failed",
              message: ran.stderr.trim() || `The command exited ${ran.exitCode}`,
            }
          : parseComparison(ran.stdout);
    } catch (cause) {
      this.#options.warn(`comparison: the Container's command failed: ${errorText(cause)}`);

      return problem("failed", `The Container could not compare: ${errorText(cause)}`, redact);
    }

    if (!parsed.ok) return problem(parsed.kind, parsed.message, redact, parsed.base);

    const made = await this.#made(files, dir, repo, parsed.comparison);

    await this.#keep(repo, made, parsed.comparison);

    return { status: "ok", comparison: made.comparison };
  }

  /**
   * The base to compare with: the base of the branch's open pull request on GitHub (so a stacked branch compares with
   * the branch under it), looked up when the base is fetched again or was never chosen; a recomputation without a fetch
   * keeps the base it had. Undefined: the Container uses the remote's default branch.
   */
  async #chooseBase(
    fs: Fs,
    dir: string,
    branch: string | null,
    fetching: boolean,
    last: LastComparison | undefined,
  ): Promise<string | undefined> {
    // A branch that changed (a checkout) has another pull request, and so maybe another base.
    if (!fetching && last !== undefined && last.branch === branch) return last.base;

    if (branch === null) return undefined;

    try {
      const url = await this.#remoteUrl(fs, dir, branch);
      const repo = url === undefined ? undefined : githubRepoOf(url);

      if (repo === undefined) return undefined;

      return await this.#pullBase(repo, branch);
    } catch (cause) {
      this.#options.warn(`comparison: GitHub's pull request lookup failed: ${errorText(cause)}`);

      return undefined;
    }
  }

  /** The URL of the branch's tracked remote, else `origin`, else the only remote. */
  async #remoteUrl(fs: Fs, dir: string, branch: string): Promise<string | undefined> {
    const remotes = await git.listRemotes({ fs, dir });
    const tracked = await git.getConfig({ fs, dir, path: `branch.${branch}.remote` });
    const named = (name: string | undefined) => remotes.find((remote) => remote.remote === name);

    const chosen =
      named(tracked) ?? named("origin") ?? (remotes.length === 1 ? remotes[0] : undefined);

    return chosen?.url;
  }

  async #pullBase(repo: GitHubRepo, branch: string): Promise<string | undefined> {
    const token = this.#options.token();

    const query = new URLSearchParams({
      state: "open",
      head: `${repo.owner}:${branch}`,
      per_page: "1",
    });

    const headers = new Headers({
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "cloudpid",
    });

    if (token !== undefined && token !== "") headers.set("authorization", `Bearer ${token}`);

    const response = await this.#options.fetch(
      `https://api.github.com/repos/${repo.owner}/${repo.name}/pulls?${query.toString()}`,
      { headers, signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS) },
    );

    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);

    const pulls = decodePulls(await response.json());

    if (Option.isNone(pulls)) throw new Error("GitHub's answer was not a list of pull requests");

    const base = pulls.value[0]?.base.ref;

    if (base === undefined) return undefined;

    if (!isSafeBase(base)) {
      this.#options.warn(`comparison: the pull request's base ${base} is not a usable name`);

      return undefined;
    }

    return base;
  }

  /** The Comparison `made` by the Container, as the client is sent it, with the blobs behind each file. */
  async #made(
    files: ChangesFiles,
    dir: string,
    repo: string,
    made: ContainerComparison,
  ): Promise<KeptComparison> {
    const attributes = readAttributes(
      await files.readFile(`${dir}/.gitattributes`, "utf8").then(toText, () => undefined),
    );

    const listed = made.files.slice(0, MAX_CHANGED_FILES);

    const entries = listed.map((file) =>
      withFlags(
        entryOf({
          path: file.path,
          oldPath: file.oldPath,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          approximate: false,
          binary: file.binary,
          tooLarge:
            (file.oldBytes ?? 0) > MAX_CHANGE_SIDE_BYTES ||
            (file.newBytes ?? 0) > MAX_CHANGE_SIDE_BYTES,
        }),
        attributes,
      ),
    );

    return {
      comparison: {
        repo,
        base: made.base,
        branch: made.branch,
        mergeBase: made.mergeBase,
        head: made.head,
        commits: made.commits,
        files: entries,
        more: made.files.length - listed.length,
      },
      blobs: listed.map((file) => [
        file.path,
        {
          oldId: file.oldId,
          newId: file.newId,
          oldBytes: file.oldBytes,
          newBytes: file.newBytes,
        },
      ]),
    };
  }

  /** Keep `made` by its (merge-base, head), make it the repo's last, and drop the oldest past `KEPT_COMPARISONS`. */
  async #keep(repo: string, made: KeptComparison, ran: ContainerComparison): Promise<void> {
    const { store } = this.#options;
    const { mergeBase, head } = made.comparison;
    const key = `${COMPARISON_KEY}:${repo}:${mergeBase}:${head}`;
    const keys = `${COMPARISON_KEY}-keys:${repo}`;

    // A list too big to store is made again when asked for. The repo's last pointer stays at the list before it: a pointer
    // to a list that is not there would make a reopening after the idle stop answer `needs_container`.
    if (JSON.stringify(made).length > MAX_KEPT_BYTES) return;

    try {
      await store.put(key, made);

      const before = ((await store.get<string[]>(keys)) ?? []).filter((each) => each !== key);
      const after = [...before, key];

      for (const old of after.slice(0, Math.max(after.length - KEPT_COMPARISONS, 0))) {
        await store.delete(old);
      }

      await store.put(keys, after.slice(-KEPT_COMPARISONS));

      const last: LastComparison = {
        mergeBase,
        head,
        branch: ran.branch,
        base: made.comparison.base,
      };

      await store.put(`${COMPARISON_KEY}:${repo}`, last);
    } catch (cause) {
      this.#options.warn(`comparison: keeping ${repo}'s list failed: ${errorText(cause)}`);
    }
  }

  async #kept(repo: string, mergeBase: string, head: string): Promise<KeptComparison | undefined> {
    return this.#options.store
      .get<KeptComparison>(`${COMPARISON_KEY}:${repo}:${mergeBase}:${head}`)
      .catch(() => undefined);
  }

  /** One file's two sides of a Comparison. It never starts the Container. */
  async file(request: ComparisonFileRequest): Promise<ChangeFile> {
    const { repo, mergeBase, head, path } = request;
    const oldPath = request.oldPath ?? path;

    if (
      !isRepoName(repo) ||
      !OBJECT_ID.test(mergeBase) ||
      !OBJECT_ID.test(head) ||
      !isRepoPath(path) ||
      !isRepoPath(oldPath)
    ) {
      throw new Error("No such file in the Workspace's repos");
    }

    const files = this.#files();
    const fs = readOnly(files);
    const dir = `${WORKSPACE_ROOT}/${repo}`;

    await files.stat(`${dir}/.git`).catch(() => {
      throw new Error(`${repo} is not a repo of the Workspace`);
    });

    const kept = await this.#kept(repo, mergeBase, head);
    const known = kept?.blobs.find(([each]) => each === path)?.[1];

    const wanted: [Wanted, Wanted] = [
      {
        commit: mergeBase,
        path: oldPath,
        id: known === undefined ? undefined : known.oldId,
        bytes: known?.oldBytes ?? null,
      },
      {
        commit: head,
        path,
        id: known === undefined ? undefined : known.newId,
        bytes: known?.newBytes ?? null,
      },
    ];

    const bigPack = (await packfileBytes(files, `${dir}/.git`).catch(() => 0)) > MAX_PACK_BYTES;
    const sides: Array<ChangeSide | null | undefined> = [];

    for (const side of wanted) sides.push(await this.#ownSide(fs, dir, side, bigPack));

    const missing = wanted.flatMap((side, index) =>
      sides[index] === undefined && side.id !== undefined && side.id !== null ? [side.id] : [],
    );

    if (sides.some((side) => side === undefined) && missing.length === 0) {
      throw new Error("This Comparison is no longer kept: compare again");
    }

    const fetched = missing.length > 0 ? await this.#fromContainer(repo, missing) : new Map();

    const resolved = wanted.map((side, index): ChangeSide | null => {
      const own = sides[index];

      if (own !== undefined) return own;

      const read = side.id === undefined || side.id === null ? undefined : fetched.get(side.id);

      if (read === undefined) throw new Error("Git could not read this file's contents");

      return read;
    });

    return { old: resolved[0] ?? null, new: resolved[1] ?? null };
  }

  /**
   * One side read here: null when there is none, its text, binary or too large; undefined when this module cannot read
   * it (a pack over the guard, an object it does not have) and the Container must.
   */
  async #ownSide(
    fs: Fs,
    dir: string,
    wanted: Wanted,
    bigPack: boolean,
  ): Promise<ChangeSide | null | undefined> {
    // The list says there is no such side (an addition has no old one, a deletion no new one).
    if (wanted.id === null) return null;

    if (wanted.bytes !== null && wanted.bytes > MAX_CHANGE_SIDE_BYTES) {
      return { kind: "too_large", bytes: wanted.bytes };
    }

    if (bigPack) return undefined;

    try {
      const { blob } =
        wanted.id === undefined
          ? await git.readBlob({ fs, dir, oid: wanted.commit, filepath: wanted.path })
          : await git.readBlob({ fs, dir, oid: wanted.id });

      return sideOf(blob, blob.length);
    } catch (cause) {
      // Found by its id: an object the Workspace DO does not have yet. Found by its path: no such file at that commit is
      // a side that does not exist, but a commit the Workspace DO does not have is not (it must not read as an added or
      // deleted file): this module cannot say, and the caller compares again.
      if (isNotFound(cause))
        return wanted.id === undefined && fileIsMissing(cause) ? null : undefined;

      this.#options.warn(`comparison: readBlob failed in ${dir}: ${errorText(cause)}`);

      return undefined;
    }
  }

  /** The blobs `ids`, read by the Container's git; fails while it is stopped. */
  async #fromContainer(repo: string, ids: readonly string[]): Promise<Map<string, ChangeSide>> {
    if (!this.#options.running()) {
      throw new Error(
        "This file's contents need the Container, which is stopped: refresh the Comparison by hand",
      );
    }

    const ran = await this.#options.run(blobsScript(repo, ids, MAX_CHANGE_SIDE_BYTES));
    const read = parseBlobs(ran.stdout);
    const sides = new Map<string, ChangeSide>();

    for (const [id, blob] of read) {
      sides.set(
        id,
        blob.blob === undefined
          ? { kind: "too_large", bytes: blob.bytes }
          : sideOf(blob.blob, blob.bytes),
      );
    }

    return sides;
  }
}

/** Whether isomorphic-git's not-found error is about the file at a commit, rather than the commit itself. */
const fileIsMissing = (cause: unknown): boolean =>
  Predicate.hasProperty(cause, "data") &&
  Predicate.hasProperty(cause.data, "what") &&
  Predicate.isString(cause.data.what) &&
  cause.data.what.startsWith("file or directory found at");

/** One side of a file asked for: where to find it, and what the list says of it. */
type Wanted = {
  readonly commit: string;
  readonly path: string;
  /** Its blob id; null when the list says it has none; undefined when the list is not kept. */
  readonly id: string | null | undefined;
  readonly bytes: number | null;
};
