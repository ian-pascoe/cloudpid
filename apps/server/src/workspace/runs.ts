// Run copies and the Run diff (GLOSSARY.md → Run diff; docs/spec.md → Diffs and review → Run diff; ADR-0022): what the
// Session's latest writing Run changed in the files of its Workspace's repos, as the Workspace DO keeps it. The Session
// DO tells it when a Run starts writing (`start`: the first writing call of the Run waits for it) and when the Run ends
// (`end`), and asks for the Run diff and a file's two sides as it does for the Changes:
//
// - a copy of a repo is a tree and a commit saved as git objects under `refs/cloudpid/runs/<scope>/{start,end}`: HEAD's
//   tree with the files that differ from HEAD replaced by blobs written here (isomorphic-git, over the repo's `.git` in
//   the Workspace DO's files), the commit's parent HEAD. A file that is binary or over 1 MiB is not stored: its size and
//   hash are recorded, so the Run diff can tell it changed and shows it as binary or too large;
// - a repo the Container's git must list (the Changes' guards) is copied by `runCopyScript`, only while the Container
//   runs: a stopped one is never started, and the repo is "not captured". More than 2,000 files differing from HEAD is
//   "not captured: too many changed files";
// - while the Run is live the diff is the start copy against the working tree, listed as the Changes are (against the
//   copy's commit, not HEAD, so a commit or a branch switch hides nothing); at the end the list is made once more and
//   kept, and a file's end side is read from the end copy, so the diff never changes;
// - only the latest Run is kept: the next replaces it, unless the Session says drafts still name it (`keep`), when its
//   copies move under `…/kept/<run>/` until they do not.
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalTimers:off globalDate:off newPromise:off missingPipeableSignature:off
import {
  type ChangeFile,
  type ChangeSide,
  type ConversationId,
  isRepoName,
  type LastRun,
  type LastRunRepo,
  MAX_CHANGE_SIDE_BYTES,
  MAX_RUN_COPY_FILES,
  MAX_RUN_HASHED_BYTES,
  RUN_ID,
  type RunDiff,
  type RunNotCaptured,
  WORKSPACE_ROOT,
} from "@cloudpid/protocol";
import { EMPTY_TREE_ID } from "@cloudpid/sandbox-image/changes";
import {
  parseRunCopy,
  RUN_COPY_TIMEOUT_SECONDS,
  runCopyScript,
} from "@cloudpid/sandbox-image/runs";
import * as git from "isomorphic-git";
import {
  type Against,
  blobId,
  changedFromHead,
  type ChangesFiles,
  type ContainerOnly,
  coveredRepos,
  errorText,
  type GitCache,
  isBinary,
  isNotFound,
  isRepoPath,
  type OwnListing,
  pacer,
  readHead,
  readOnly,
  settled,
  toBytes,
  type UnstoredFile,
  unstoredFile,
  withDeadline,
} from "./changes.ts";

/** What a Session's scope is made of: it names its Runs' hidden refs. */
export const RUN_SCOPE = /^[A-Za-z0-9_-]{1,64}$/;

/** Who the copies' commits are by, where this module makes them. */
const IDENTITY = { name: "cloudpid", email: "cloudpid@localhost" };

/** The files the Workspace DO reads and writes (computer's provider: the writes are logged for the Container's sync). */
export type RunFiles = ChangesFiles & {
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  mkdir(
    path: string,
    options?: { readonly recursive?: boolean },
  ): Promise<string | undefined | void>;
  unlink(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
};

/** What the module asks of the Changes module: the listings and sides against a commit. */
export type RunsChanges = {
  readonly needsContainer: (repo: string) => Promise<boolean>;
  readonly against: (repo: string, against: Against) => Promise<OwnListing | null>;
  readonly againstOnContainer: (
    repo: string,
    commit: string,
    unstored: ReadonlyMap<string, UnstoredFile>,
  ) => Promise<OwnListing | { readonly error: string } | null>;
  readonly fileAgainst: (
    request: { readonly repo: string; readonly path: string; readonly oldPath?: string },
    against: Against,
  ) => Promise<ChangeFile>;
  readonly sideAt: (repo: string, path: string, commit: string) => Promise<ChangeSide | null>;
};

export type RunsOptions = {
  readonly files: () => RunFiles;
  readonly changes: RunsChanges;
  /** Which absolute paths are Container-only: never in the Workspace DO's files, so never copied. */
  readonly containerOnly: () => Promise<ContainerOnly>;
  /** Whether the Container runs now. */
  readonly running: () => boolean;
  /** Run `script` on the Container, which the caller has seen running. */
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
    /** The keys that start with `prefix`. */
    readonly keys: (prefix: string) => Promise<string[]>;
  };
  readonly warn: (message: string) => void;
  /** The clock (a test sets it). */
  readonly now?: () => number;
};

/** A copy of one repo: its commit, and the files it did not store. */
type CopyRecord = { readonly commit: string; readonly unstored: ReadonlyArray<UnstoredFile> };

/** One repo of a Run, as kept. */
type RepoRun = {
  readonly repo: string;
  start?: CopyRecord;
  end?: CopyRecord;
  notCaptured?: RunNotCaptured;
  /** The list kept when the Run ended. */
  frozen?: OwnListing;
  /** The last list made by the Container's git while the Run was live: shown, "may be out of date", with it stopped. */
  last?: OwnListing;
};

/** A Run as kept: its repos are kept apart, under `<key>:repo:<repo>`, since a list may be big. */
type RunMeta = {
  readonly run: string;
  readonly conversationId: number;
  readonly startedAt: number;
  endedAt: number | null;
  readonly firstCall: string;
  until: number | null;
  readonly repos: ReadonlyArray<string>;
};

export type RunStartRequest = {
  readonly scope: string;
  readonly run: string;
  readonly conversationId: number;
  /** The ID of the model's tool call that made the Run's first write: where the Run's entries begin. */
  readonly firstCall: string;
  /** When the Session saw that call (its clock); the Workspace's own when left out. */
  readonly startedAt?: number;
  /** The directory the Session works in: one repo's clone, or the Workspace's root for every repo. */
  readonly directory: string;
  /** The IDs of the Runs the Session's drafts still name: their copies are kept. */
  readonly keep: ReadonlyArray<string>;
};

export type RunEndRequest = {
  readonly scope: string;
  readonly run: string;
  /** The conversation's last entry of the Run. */
  readonly until: number;
  /**
   * The Run's first write did not wait for the start copy (it took too long or failed): the copies are not to be trusted,
   * so every repo is "not captured" and nothing is copied again.
   */
  readonly missed?: boolean;
  readonly keep: ReadonlyArray<string>;
};

export type RunFileRequest = {
  readonly scope: string;
  readonly repo: string;
  readonly path: string;
  readonly oldPath?: string;
};

/** The outcome of copying one repo. */
type Copied =
  | { readonly ok: true; readonly copy: CopyRecord }
  | { readonly ok: false; readonly reason: RunNotCaptured };

/** The key a Run is kept under: the latest's, or a kept one's. */
const keyOf = (scope: string, kept?: string): string =>
  kept === undefined ? `cloudpid:run:${scope}` : `cloudpid:run:${scope}:kept:${kept}`;

const refOf = (scope: string, which: "start" | "end", kept?: string): string =>
  kept === undefined
    ? `refs/cloudpid/runs/${scope}/${which}`
    : `refs/cloudpid/runs/${scope}/kept/${kept}/${which}`;

/** What `Buffer` computer's provider writes takes: the bytes, as a `Buffer` where there is one. */
const forProvider = (data: Uint8Array | string): never =>
  // SAFETY: the provider takes `string | Buffer`; a `Buffer` is a `Uint8Array`, and `nodejs_compat` provides it.
  (data instanceof Uint8Array ? Buffer.from(data) : data) as never;

/**
 * The file system isomorphic-git writes the copies through: `files`' reads (paused every `YIELD_EVERY` calls, as the
 * listing's are) and its writes, which pause the same way, since a copy of 2,000 files is thousands of synchronous
 * SQLite writes. Symbolic links and modes are never written.
 */
const writable = (files: RunFiles) => {
  const reading = readOnly(settled(files));
  const paced = pacer();

  return {
    promises: {
      ...reading.promises,
      writeFile: (path: string, data: Uint8Array | string) =>
        paced(() => files.writeFile(path, forProvider(data))),
      mkdir: (path: string) => paced(() => files.mkdir(path)),
      unlink: (path: string) => paced(() => files.unlink(path)),
      rmdir: (path: string) => paced(() => files.rmdir(path)),
    },
  };
};

type WritableFs = ReturnType<typeof writable>;

/** A change to a repo's tree: the blob a path now holds, or null where the path is gone. */
type Edit = { readonly oid: string; readonly mode: string } | null;

export class WorkspaceRunsModule {
  readonly #options: RunsOptions;
  /** The calls running per scope, so two for one Session run one after the other. */
  readonly #queues = new Map<string, Promise<unknown>>();

  constructor(options: RunsOptions) {
    this.#options = options;
  }

  #now(): number {
    return this.#options.now === undefined ? Date.now() : this.#options.now();
  }

  #serial<A>(scope: string, work: () => Promise<A>): Promise<A> {
    const before = this.#queues.get(scope) ?? Promise.resolve();
    const run = before.then(work, work);

    const tail = run.then(
      () => undefined,
      () => undefined,
    );

    this.#queues.set(scope, tail);
    void tail.then(() => {
      if (this.#queues.get(scope) === tail) this.#queues.delete(scope);
    });

    return run;
  }

  /**
   * A Run starts writing: copy each repo `request.directory` covers, replacing the Session's last Run (kept while its ID
   * is in `keep`), and answer the Run. Called again for the same Run (a tool call replayed after an eviction), it answers
   * the Run as it is.
   */
  start(request: RunStartRequest): Promise<LastRun> {
    const { scope } = request;

    if (
      !RUN_SCOPE.test(scope) ||
      !RUN_ID.test(request.run) ||
      !Number.isInteger(request.conversationId) ||
      (request.startedAt !== undefined && !Number.isFinite(request.startedAt)) ||
      request.firstCall.length === 0 ||
      request.firstCall.length > 200 ||
      !request.keep.every((kept) => RUN_ID.test(kept))
    ) {
      return Promise.reject(new Error("Not a Run"));
    }

    return this.#serial(scope, async () => {
      const before = await this.#meta(scope);

      if (before?.run === request.run) return this.#lastRun(scope, before);

      if (before !== undefined) await this.#replace(scope, before, request.keep);

      await this.#prune(scope, request.keep);

      const repos = await coveredRepos(this.#options.files(), request.directory);
      const records: RepoRun[] = [];

      for (const repo of repos) {
        const copied = await this.#copy(scope, repo, "start");

        records.push(
          copied.ok ? { repo, start: copied.copy } : { repo, notCaptured: copied.reason },
        );
      }

      const meta: RunMeta = {
        run: request.run,
        conversationId: request.conversationId,
        startedAt: request.startedAt ?? this.#now(),
        endedAt: null,
        firstCall: request.firstCall,
        until: null,
        repos,
      };

      await this.#save(scope, undefined, meta, records);

      return toLastRun(meta, records);
    });
  }

  /**
   * The Run ended: copy each captured repo again, list its diff once and keep it, and answer the Run. Null for a Run that
   * is not the Session's latest (a replaced one, or none).
   */
  end(request: RunEndRequest): Promise<LastRun | null> {
    const { scope } = request;

    if (
      !RUN_SCOPE.test(scope) ||
      !RUN_ID.test(request.run) ||
      !Number.isInteger(request.until) ||
      !request.keep.every((kept) => RUN_ID.test(kept))
    ) {
      return Promise.reject(new Error("Not a Run"));
    }

    return this.#serial(scope, async () => {
      const meta = await this.#meta(scope);

      if (meta?.run !== request.run) return null;

      const records = await this.#repoRuns(scope, undefined, meta);

      if (meta.endedAt !== null) return toLastRun(meta, records);

      for (const record of records) {
        if (request.missed === true) {
          record.notCaptured = "failed";
          continue;
        }

        if (record.start === undefined) continue;

        const copied = await this.#copy(scope, record.repo, "end");

        if (!copied.ok) {
          record.notCaptured = copied.reason;
          continue;
        }

        record.end = copied.copy;

        const listed = await this.#listing(record.repo, record.start);

        if ("reason" in listed) record.notCaptured = listed.reason;
        else record.frozen = listed.listing;
      }

      meta.endedAt = this.#now();
      meta.until = request.until;

      await this.#save(scope, undefined, meta, records);
      await this.#prune(scope, request.keep);

      return toLastRun(meta, records);
    });
  }

  /**
   * The Run diff of the Session's latest Run, or null when none has written. While the Run is live each captured repo is
   * listed against the working tree now (the Container's git for a repo that needs it, while it runs; a stopped one keeps
   * its last list, `stale`); once it ended, the list kept at its end. It never starts the Container.
   */
  async diff(scope: string): Promise<RunDiff | null> {
    if (!RUN_SCOPE.test(scope)) throw new Error("Not a Run");

    const meta = await this.#meta(scope);

    if (meta === undefined) return null;

    const files = this.#options.files();
    const fs = readOnly(settled(files));
    const repos: RunDiff["repos"][number][] = [];

    for (const record of await this.#repoRuns(scope, undefined, meta)) {
      if (record.start === undefined || record.notCaptured !== undefined) continue;

      const head = await readHead(fs, `${WORKSPACE_ROOT}/${record.repo}`).catch(() => ({
        commit: null,
        branch: null,
      }));

      if (meta.endedAt !== null) {
        const frozen = record.frozen ?? { files: [], more: 0 };

        repos.push({
          repo: record.repo,
          head,
          files: frozen.files,
          more: frozen.more,
          stale: false,
        });
        continue;
      }

      repos.push({ repo: record.repo, head, ...(await this.#live(scope, record)) });
    }

    return { run: meta.run, live: meta.endedAt === null, repos };
  }

  /**
   * One file of the Session's latest Run: its start copy's side and its end copy's (the working tree while the Run is
   * live). It never starts the Container.
   */
  async file(request: RunFileRequest): Promise<ChangeFile> {
    const { scope, repo, path } = request;
    const oldPath = request.oldPath ?? path;

    if (!RUN_SCOPE.test(scope) || !isRepoName(repo) || !isRepoPath(path) || !isRepoPath(oldPath)) {
      throw new Error("No such file in the Workspace's repos");
    }

    const meta = await this.#meta(scope);
    const record = meta === undefined ? undefined : await this.#repoRun(scope, undefined, repo);

    if (meta === undefined || record?.start === undefined || record.notCaptured !== undefined) {
      throw new Error("The last run has no copy of this repo");
    }

    const against: Against = {
      commit: record.start.commit,
      unstored: new Map(record.start.unstored.map((file) => [file.path, file])),
    };

    const query = request.oldPath === undefined ? { repo, path } : { repo, path, oldPath };

    if (meta.endedAt === null || record.end === undefined) {
      return this.#options.changes.fileAgainst(query, against);
    }

    const ended = new Map(record.end.unstored.map((file) => [file.path, file]));
    const recorded = against.unstored.get(oldPath);
    const finished = ended.get(path);

    return {
      old:
        recorded === undefined
          ? await this.#options.changes.sideAt(repo, oldPath, record.start.commit)
          : unstoredFile(recorded),
      new:
        finished === undefined
          ? await this.#options.changes.sideAt(repo, path, record.end.commit)
          : unstoredFile(finished),
    };
  }

  async #lastRun(scope: string, meta: RunMeta): Promise<LastRun> {
    return toLastRun(meta, await this.#repoRuns(scope, undefined, meta));
  }

  /** The list of a live Run's repo, against the working tree now. */
  async #live(
    scope: string,
    record: RepoRun,
  ): Promise<Pick<RunDiff["repos"][number], "files" | "more" | "stale" | "error">> {
    const { start } = record;

    if (start === undefined) return { files: [], more: 0, stale: false };

    try {
      const listed = await this.#listing(record.repo, start);

      if ("reason" in listed) {
        const last = record.last ?? { files: [], more: 0 };

        if (listed.reason === "container_stopped") {
          return { files: last.files, more: last.more, stale: true };
        }

        return {
          files: last.files,
          more: last.more,
          stale: true,
          error: "The Container could not list the files",
        };
      }

      // A repo the Container's git lists keeps its last list, for when the Container is stopped.
      if (await this.#options.changes.needsContainer(record.repo)) {
        record.last = listed.listing;

        await this.#saveRepo(scope, undefined, record).catch((cause: unknown) => {
          this.#options.warn(`runs: keeping ${record.repo}'s list failed: ${errorText(cause)}`);
        });
      }

      return { files: listed.listing.files, more: listed.listing.more, stale: false };
    } catch (cause) {
      this.#options.warn(`runs: listing ${record.repo} failed: ${errorText(cause)}`);

      return { files: [], more: 0, stale: false, error: errorText(cause) };
    }
  }

  /** The Run's diff of `repo` against the working tree, or why not: the Container is stopped, or its listing failed. */
  async #listing(
    repo: string,
    start: CopyRecord,
  ): Promise<{ readonly listing: OwnListing } | { readonly reason: RunNotCaptured }> {
    const against: Against = {
      commit: start.commit,
      unstored: new Map(start.unstored.map((file) => [file.path, file])),
    };

    const own = await this.#options.changes.against(repo, against);

    if (own !== null) return { listing: own };

    const onContainer = await this.#options.changes.againstOnContainer(
      repo,
      start.commit,
      against.unstored,
    );

    if (onContainer === null) return { reason: "container_stopped" };

    if ("error" in onContainer) {
      this.#options.warn(`runs: the Container's listing of ${repo} failed: ${onContainer.error}`);

      return { reason: "failed" };
    }

    return { listing: onContainer };
  }

  /** A copy of `repo`'s working tree as `which`, by the Workspace DO or the Container's git. */
  async #copy(scope: string, repo: string, which: "start" | "end"): Promise<Copied> {
    try {
      const ref = refOf(scope, which);

      if (!(await this.#options.changes.needsContainer(repo))) {
        try {
          return await this.#copyOwn(repo, ref);
        } catch (cause) {
          // isomorphic-git failing on a repo is a reason for the Container's git, as for the Changes.
          this.#options.warn(`runs: copying ${repo} failed here: ${errorText(cause)}`);
        }
      }

      return await this.#copyOnContainer(repo, ref);
    } catch (cause) {
      this.#options.warn(`runs: copying ${repo} failed: ${errorText(cause)}`);

      return { ok: false, reason: "failed" };
    }
  }

  async #copyOnContainer(repo: string, ref: string): Promise<Copied> {
    if (!this.#options.running()) return { ok: false, reason: "container_stopped" };

    const script = runCopyScript({
      repo,
      ref,
      maxFiles: MAX_RUN_COPY_FILES,
      maxStoredBytes: MAX_CHANGE_SIDE_BYTES,
      maxHashedBytes: MAX_RUN_HASHED_BYTES,
    });

    // The command stops itself first; this is for a command the Container never answers.
    const ran = await withDeadline(
      this.#options.run(script),
      (RUN_COPY_TIMEOUT_SECONDS + 5) * 1_000,
    );

    const parsed = parseRunCopy(ran.stdout);

    if (parsed.ok) return { ok: true, copy: { commit: parsed.commit, unstored: parsed.unstored } };

    if (parsed.kind === "too_many") return { ok: false, reason: "too_many_files" };

    this.#options.warn(`runs: the Container's copy of ${repo} failed: ${parsed.message}`);

    return { ok: false, reason: "failed" };
  }

  /** The working tree of `repo` saved here: HEAD's tree with the files that differ replaced, a commit, and `ref`. */
  async #copyOwn(repo: string, ref: string): Promise<Copied> {
    const files = this.#options.files();
    const fs = writable(files);
    const dir = `${WORKSPACE_ROOT}/${repo}`;
    const containerOnly = await this.#options.containerOnly();
    const head = await readHead(readOnly(settled(files)), dir);
    const cache: GitCache = {};

    // The listing reads through a file system that refuses writes: isomorphic-git would refresh the repo's index otherwise.
    const matrix = await git.statusMatrix({
      fs: readOnly(settled(files)),
      dir,
      cache,
      refresh: false,
    });

    const changed = matrix.flatMap(([path, inHead, inWorkdir]) => {
      if (containerOnly(`${dir}/${path}`)) return [];

      if (!changedFromHead(inHead, inWorkdir)) return [];

      return [{ path, deleted: inWorkdir === 0 }];
    });

    if (changed.length > MAX_RUN_COPY_FILES) return { ok: false, reason: "too_many_files" };

    const edits = new Map<string, Edit>();
    const unstored: UnstoredFile[] = [];

    // Each file is read, stored and let go before the next.
    for (const { path, deleted } of changed) {
      if (deleted) {
        edits.set(path, null);
        continue;
      }

      const full = `${dir}/${path}`;
      let stat: Awaited<ReturnType<typeof fs.promises.lstat>>;

      try {
        stat = await fs.promises.lstat(full);
      } catch (cause) {
        if (!isNotFound(cause)) throw cause;

        // Gone since the listing: as deleted.
        edits.set(path, null);
        continue;
      }

      if (stat.isSymbolicLink()) {
        const bytes = new TextEncoder().encode(await fs.promises.readlink(full));
        const oid = await git.writeBlob({ fs, dir, blob: bytes });

        edits.set(path, { oid, mode: "120000" });
        continue;
      }

      if (stat.size > MAX_CHANGE_SIDE_BYTES) {
        unstored.push({
          path,
          size: stat.size,
          id:
            stat.size > MAX_RUN_HASHED_BYTES
              ? null
              : await blobId(toBytes(await fs.promises.readFile(full))),
          binary: false,
        });
        continue;
      }

      const bytes = toBytes(await fs.promises.readFile(full));

      if (isBinary(bytes)) {
        unstored.push({ path, size: bytes.length, id: await blobId(bytes), binary: true });
        continue;
      }

      edits.set(path, { oid: await git.writeBlob({ fs, dir, blob: bytes }), mode: "100644" });
    }

    const base =
      head.commit === null
        ? null
        : (await git.readCommit({ fs, dir, oid: head.commit, cache })).commit.tree;

    const tree = (await applyEdits(fs, dir, base, edits, cache)) ?? EMPTY_TREE_ID;

    const when = { timestamp: Math.floor(this.#now() / 1000), timezoneOffset: 0 };

    const commit = await git.writeCommit({
      fs,
      dir,
      commit: {
        message: "cloudpid run copy\n",
        tree,
        parent: head.commit === null ? [] : [head.commit],
        author: { ...IDENTITY, ...when },
        committer: { ...IDENTITY, ...when },
      },
    });

    await git.writeRef({ fs, dir, ref, value: commit, force: true });

    return { ok: true, copy: { commit, unstored } };
  }

  /** The Run `before` (the latest's) gives way to the next: its copies move to the kept ones when drafts name it. */
  async #replace(scope: string, before: RunMeta, keep: ReadonlyArray<string>): Promise<void> {
    const records = await this.#repoRuns(scope, undefined, before);

    if (keep.includes(before.run)) {
      await this.#save(scope, before.run, before, records);

      for (const record of records) {
        for (const which of ["start", "end"] as const) {
          const commit = record[which]?.commit;

          if (commit !== undefined) {
            await this.#writeRef(record.repo, refOf(scope, which, before.run), commit);
          }
        }
      }
    }

    await this.#forget(scope, undefined, records);
  }

  /** Forget the kept Runs whose ID is not in `keep`. */
  async #prune(scope: string, keep: ReadonlyArray<string>): Promise<void> {
    const prefix = `${keyOf(scope)}:kept:`;

    for (const key of await this.#options.store.keys(prefix)) {
      const run = key.slice(prefix.length);

      if (!RUN_ID.test(run) || keep.includes(run)) continue;

      const meta = await this.#options.store.get<RunMeta>(key);

      if (meta === undefined) continue;

      await this.#forget(scope, run, await this.#repoRuns(scope, run, meta));
    }
  }

  /** Delete a Run's refs and everything kept of it. */
  async #forget(
    scope: string,
    kept: string | undefined,
    records: ReadonlyArray<RepoRun>,
  ): Promise<void> {
    for (const record of records) {
      for (const which of ["start", "end"] as const) {
        if (record[which] !== undefined) {
          await this.#deleteRef(record.repo, refOf(scope, which, kept));
        }
      }

      await this.#options.store.delete(`${keyOf(scope, kept)}:repo:${record.repo}`);
    }

    await this.#options.store.delete(keyOf(scope, kept));
  }

  async #writeRef(repo: string, ref: string, value: string): Promise<void> {
    try {
      const fs = writable(this.#options.files());

      await git.writeRef({ fs, dir: `${WORKSPACE_ROOT}/${repo}`, ref, value, force: true });
    } catch (cause) {
      this.#options.warn(`runs: writing ${ref} in ${repo} failed: ${errorText(cause)}`);
    }
  }

  async #deleteRef(repo: string, ref: string): Promise<void> {
    try {
      const fs = writable(this.#options.files());

      await git.deleteRef({ fs, dir: `${WORKSPACE_ROOT}/${repo}`, ref });
    } catch (cause) {
      this.#options.warn(`runs: deleting ${ref} in ${repo} failed: ${errorText(cause)}`);
    }
  }

  async #meta(scope: string, kept?: string): Promise<RunMeta | undefined> {
    return this.#options.store.get<RunMeta>(keyOf(scope, kept)).catch(() => undefined);
  }

  async #repoRun(
    scope: string,
    kept: string | undefined,
    repo: string,
  ): Promise<RepoRun | undefined> {
    return this.#options.store
      .get<RepoRun>(`${keyOf(scope, kept)}:repo:${repo}`)
      .catch(() => undefined);
  }

  async #repoRuns(scope: string, kept: string | undefined, meta: RunMeta): Promise<RepoRun[]> {
    const records: RepoRun[] = [];

    for (const repo of meta.repos) {
      records.push((await this.#repoRun(scope, kept, repo)) ?? { repo, notCaptured: "failed" });
    }

    return records;
  }

  async #saveRepo(scope: string, kept: string | undefined, record: RepoRun): Promise<void> {
    await this.#options.store.put(`${keyOf(scope, kept)}:repo:${record.repo}`, record);
  }

  async #save(
    scope: string,
    kept: string | undefined,
    meta: RunMeta,
    records: ReadonlyArray<RepoRun>,
  ): Promise<void> {
    for (const record of records) await this.#saveRepo(scope, kept, record);

    await this.#options.store.put(keyOf(scope, kept), meta);
  }
}

/** `meta` as the Session and its clients see it. */
const toLastRun = (meta: RunMeta, records: ReadonlyArray<RepoRun>): LastRun => {
  const last: LastRun = {
    run: meta.run,
    // SAFETY: the Session passed a conversation ID, which is pi-durable's number.
    conversationId: meta.conversationId as ConversationId,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    firstCall: meta.firstCall,
    until: meta.until,
    repos: records.map((record) => {
      const repo: LastRunRepo = {
        repo: record.repo,
        start: record.start?.commit ?? null,
        end: record.end?.commit ?? null,
      };

      if (record.notCaptured !== undefined) return { ...repo, notCaptured: record.notCaptured };

      return repo;
    }),
  };

  // Ended, and every repo captured without a changed file: nothing to show.
  const empty =
    meta.endedAt !== null &&
    records.every(
      (record) =>
        record.notCaptured === undefined &&
        record.frozen !== undefined &&
        record.frozen.files.length === 0 &&
        record.frozen.more === 0,
    );

  return empty ? { ...last, empty: true } : last;
};

/**
 * The tree of `base` (null: an empty one) with `edits` applied, written: the id of the new tree, or null when it holds
 * nothing. A path's edit replaces what the tree had at it (a file where a directory was, and the other way), and a
 * directory's other entries are kept as they are.
 */
const applyEdits = async (
  fs: WritableFs,
  dir: string,
  base: string | null,
  edits: ReadonlyMap<string, Edit>,
  cache: GitCache,
): Promise<string | null> => {
  const entries = new Map<
    string,
    { mode: string; path: string; oid: string; type: "blob" | "tree" | "commit" }
  >();

  if (base !== null) {
    for (const entry of (await git.readTree({ fs, dir, oid: base, cache })).tree) {
      entries.set(entry.path, entry);
    }
  }

  // The edits of each name at this level: a file's own, and those of the paths below it.
  const leaves = new Map<string, Edit>();
  const below = new Map<string, Map<string, Edit>>();

  for (const [path, edit] of edits) {
    const slash = path.indexOf("/");

    if (slash === -1) {
      leaves.set(path, edit);
      continue;
    }

    const name = path.slice(0, slash);
    const group = below.get(name) ?? new Map<string, Edit>();

    group.set(path.slice(slash + 1), edit);
    below.set(name, group);
  }

  for (const name of new Set([...leaves.keys(), ...below.keys()])) {
    const leaf = leaves.get(name);
    const deeper = below.get(name);

    const existing = entries.get(name);

    // A file that exists now: whatever was below the name (a directory it replaced) is gone with it. A file that was
    // executable stays so.
    if (leaf !== undefined && leaf !== null) {
      const kept = leaf.mode === "100644" && existing?.mode === "100755" ? "100755" : leaf.mode;

      entries.set(name, { mode: kept, path: name, oid: leaf.oid, type: "blob" });
      continue;
    }

    entries.delete(name);

    if (deeper === undefined) continue;

    const tree = await applyEdits(
      fs,
      dir,
      existing?.type === "tree" ? existing.oid : null,
      deeper,
      cache,
    );

    if (tree !== null) entries.set(name, { mode: "040000", path: name, oid: tree, type: "tree" });
  }

  if (entries.size === 0) return null;

  return git.writeTree({ fs, dir, tree: [...entries.values()] });
};
