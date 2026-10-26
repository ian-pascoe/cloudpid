// Changes (GLOSSARY.md → Diffs and review; docs/spec.md → Diffs and review → Changes; ADR-0022): each repo's working
// tree against its HEAD, as the Workspace DO lists it. Two calls, a list of the repos a directory covers and one file's
// two sides, and the backend is chosen inside, so no caller knows which ran:
//
// - by default the Workspace DO reads the repo itself with isomorphic-git: `statusMatrix({ refresh: false })` over a
//   read-only view of its files, so `.git/index` (the Container's git owns it too) is never written, `readBlob` for HEAD
//   and the file for the working side;
// - the Container's git (`changesScript`) takes over for a repo with more tracked files than the guard, a pack over
//   16 MB, root `.gitattributes` rules git applies when it compares (`text`, `eol`, `binary`, `filter`), or one
//   isomorphic-git fails on. Only a call that may start the Container does so: otherwise a running Container is used,
//   and a stopped one leaves the repo's last list, kept in storage, marked "may be out of date".
// @effect-diagnostics asyncFunction:off preferEffectArray:off globalTimers:off newPromise:off
import {
  BINARY_SNIFF_BYTES,
  type ChangeEntry,
  type ChangeFile,
  type ChangeSide,
  type ChangeStatus,
  isRepoName,
  MAX_CHANGE_SIDE_BYTES,
  MAX_CHANGED_FILES,
  type RepoChanges,
  type RepoHead,
  WORKSPACE_ROOT,
  type WorkspaceChanges,
} from "@cloudpid/protocol";
import {
  changesScript,
  type ContainerRepoChanges,
  headBlobScript,
  parseChanges,
  parseHeadBlob,
} from "@cloudpid/sandbox-image/changes";
import { diffLines } from "diff";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import type * as Types from "effect/Types";
import * as git from "isomorphic-git";
import { type LinguistFlags, readAttributes, type RootAttributes } from "./attributes.ts";
import { MAX_PACK_BYTES, packfileBytes } from "./git.ts";

/**
 * The most tracked files a repo may have for the Workspace DO to list its Changes itself; past it, the Container's git
 * does. A listing reads and hashes every tracked file, about 1.2 ms and 5 KB of heap each in workerd: 2,000 is about
 * 2.5 s and 10 MB (docs/spec.md → Known risks and spikes → Changes in the Workspace DO), during which the listing lets
 * the Workspace DO's other calls in every `YIELD_EVERY` reads.
 */
export const MAX_TRACKED_FILES = 2_000;

/**
 * How many reads of the files a listing makes between two pauses, in which the Workspace DO serves its other calls (the
 * agent's file tools): the reads are synchronous SQLite under their promises, so without a pause a listing would hold
 * the object for its whole length. 50 reads are about 60 ms.
 */
export const YIELD_EVERY = 50;

/**
 * The most edits lining up one file's two sides looks for (jsdiff's `maxEditLength`) before its counts are whole-file
 * numbers ("≈"). The work of lining up grows with the square of the edits, so 500 is about 70 ms at worst.
 */
export const MAX_COUNT_EDITS = 500;

/**
 * The work lining up one file may take, in lines times the edits looked for: a file of many lines is looked at for
 * fewer edits, so a 15,000-line rewrite is about 30 ms, not the 50 s an unbounded lining up takes.
 */
export const COUNT_WORK = 5_000_000;

/**
 * The work lining up all of a listing's files may take, counted as `COUNT_WORK` is: the files past it get whole-file
 * numbers without being lined up, so many big rewrites are at most about half a second. It is counted, not timed, as
 * workerd's clock stands still while code runs.
 */
export const LISTING_COUNT_WORK = 25_000_000;

/**
 * A second guard on one file's lining up, by the clock (jsdiff's `timeout`). It only fires where the clock moves while
 * code runs (Node, the local tests), never deployed: the bounds above are what hold there.
 */
const COUNT_TIMEOUT_MS = 1_000;

/** How many pairs' counts are kept, by their blob ids, so an unchanged pair is never lined up twice. */
const COUNTS_CACHED = 10_000;

/** The files the Workspace DO reads, as computer's provider serves them (`Workspace.provider()`). */
export type ChangesFiles = {
  readFile(path: string, options?: ReadFileOptions): Promise<string | Uint8Array>;
  stat(path: string): Promise<{ readonly size: number; isFile(): boolean; isDirectory(): boolean }>;
  lstat(path: string): Promise<{
    readonly size: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }>;
  /** Without `withFileTypes`, the names. */
  readdir(path: string): Promise<ReadonlyArray<string | { readonly name: string }>>;
  readlink(path: string): Promise<string>;
  readRangeSync?(path: string, offset: number, length: number): Uint8Array;
};

/** How isomorphic-git asks for a file: as text, or its bytes. */
type ReadFileOptions = "utf8" | { readonly encoding?: "utf8" | null };

/** isomorphic-git's cache of what it parsed (the index, packs), shared by the calls of one listing. */
type GitCache = NonNullable<Parameters<typeof git.statusMatrix>[0]["cache"]>;

/** Whether an absolute path is Container-only. */
export type ContainerOnly = (path: string) => boolean;

/** A repo's last list from the Container's git, kept for when it cannot run. */
export type KeptChanges = { readonly files: ReadonlyArray<ChangeEntry>; readonly more: number };

export type ChangesOptions = {
  readonly files: () => ChangesFiles;
  /**
   * Which absolute paths are Container-only for the launch that runs now, or the next one (ADR-0018): never in the
   * Workspace DO's files, so never listed.
   */
  readonly containerOnly: () => Promise<ContainerOnly>;
  /** Whether the Container runs now. */
  readonly running: () => boolean;
  /** Run `script` on the Container, starting it if it is stopped. */
  readonly run: (script: string) => Promise<{
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  readonly kept: {
    readonly load: (repo: string) => Promise<KeptChanges | undefined>;
    readonly save: (repo: string, changes: KeptChanges) => Promise<void>;
  };
  readonly warn: (message: string) => void;
  /** Defaults to `MAX_TRACKED_FILES`. */
  readonly maxTrackedFiles?: number | undefined;
};

export type ChangesRequest = {
  /** The directory the Session works in: one repo's clone, or the Workspace's root for every repo. */
  readonly directory: string;
  /** Whether the Container may be started for a repo that needs it (the owner's Refresh). */
  readonly startContainer: boolean;
};

/** One changed file, as a client asks for its two sides: `path` in `repo`, and `oldPath` for a rename. */
export type ChangeFileRequest = {
  readonly repo: string;
  readonly path: string;
  readonly oldPath?: string;
};

/** A turn of the event loop, in which the Workspace DO's other calls run. */
const pause = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

/**
 * `files` with each call's failure a rejection, and a pause every `YIELD_EVERY` calls. computer's provider throws some
 * synchronously (a path it cannot resolve), and isomorphic-git takes a file system whose `readFile()` throws for a
 * callback one, whose calls never end.
 */
const settled = (files: ChangesFiles): ChangesFiles => {
  let calls = 0;
  // The pause every call waits for while it lasts: isomorphic-git reads a directory's files at once, so a pause of one
  // read alone would leave the others running and the Workspace DO as busy as before.
  let paused: Promise<void> | undefined;

  const paced = async <A>(read: () => Promise<A>): Promise<A> => {
    if (++calls % YIELD_EVERY === 0 && paused === undefined) {
      paused = pause().then(() => {
        paused = undefined;
      });
    }

    if (paused !== undefined) await paused;

    return read();
  };

  const wrapped: Types.Mutable<ChangesFiles> = {
    readFile: (path, options) => paced(() => files.readFile(path, options)),
    stat: (path) => paced(() => files.stat(path)),
    lstat: (path) => paced(() => files.lstat(path)),
    readdir: (path) => paced(() => files.readdir(path)),
    readlink: (path) => paced(() => files.readlink(path)),
  };

  if (files.readRangeSync !== undefined) wrapped.readRangeSync = files.readRangeSync.bind(files);

  return wrapped;
};

/** What isomorphic-git reads the files through: `settled` files, with every write refused. */
const readOnly = (files: ChangesFiles) => {
  const refuse = (path: string) =>
    Promise.reject(
      Object.assign(new Error(`EROFS: Changes read the files only, ${String(path)}`), {
        code: "EROFS",
      }),
    );

  return {
    promises: {
      readFile: (path: string, options?: ReadFileOptions) => files.readFile(path, options),
      stat: (path: string) => files.stat(path),
      lstat: (path: string) => files.lstat(path),
      readdir: (path: string) => files.readdir(path),
      readlink: (path: string) => files.readlink(path),
      writeFile: refuse,
      mkdir: refuse,
      rmdir: refuse,
      unlink: refuse,
      symlink: refuse,
      chmod: refuse,
    },
  };
};

type Fs = ReturnType<typeof readOnly>;

/** The read-only file system isomorphic-git reads `files` through, as the listing does (for the measurements). */
export const gitFs = (files: ChangesFiles): Fs => readOnly(settled(files));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toBytes = (data: string | Uint8Array): Uint8Array =>
  data instanceof Uint8Array ? data : encoder.encode(data);

const toText = (data: string | Uint8Array): string =>
  data instanceof Uint8Array ? decoder.decode(data) : data;

/** The names `readdir` lists. */
const namesOf = (entries: ReadonlyArray<string | { readonly name: string }>): string[] =>
  Arr.map(entries, (entry) => (Predicate.isString(entry) ? entry : entry.name));

/** git's blob id of `bytes`. */
const blobId = async (bytes: Uint8Array): Promise<string> => {
  const header = encoder.encode(`blob ${bytes.length}\0`);
  const object = new Uint8Array(header.length + bytes.length);

  object.set(header);
  object.set(bytes, header.length);

  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", object));

  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** git's rule: a NUL in the first 8,000 bytes. */
const isBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);

/** The number of lines `bytes` holds, a last one without its newline included. */
const lineCount = (bytes: Uint8Array): number => {
  let count = 0;

  for (const byte of bytes) if (byte === 10) count++;

  return bytes.length > 0 && bytes[bytes.length - 1] !== 10 ? count + 1 : count;
};

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const isNotFound = (cause: unknown): boolean =>
  Predicate.hasProperty(cause, "code") &&
  (cause.code === "NotFoundError" || cause.code === "ENOENT");

/** One side of a file as the listing read it: never its bytes, which are let go as each file is done. */
type SideFacts = {
  readonly bytes: number;
  /** Its blob id; undefined when it was too large to read. */
  readonly id?: string;
  readonly binary: boolean;
  readonly lines: number;
};

type Row = {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted";
  readonly old: SideFacts | undefined;
  readonly new: SideFacts | undefined;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly approximate?: boolean;
};

type Counted = {
  readonly additions: number;
  readonly deletions: number;
  readonly approximate?: boolean;
};

/** The Workspace DO's own listing of a repo: its first entries by path, and how many changed files it did not read. */
type OwnListing = { readonly files: ChangeEntry[]; readonly more: number };

type RepoPlan = {
  readonly repo: string;
  readonly head: RepoHead;
  readonly attributes: RootAttributes;
  /** The Workspace DO's own listing, or null when the Container's git must list the repo. */
  readonly listed: OwnListing | null;
};

/** What is left of a listing's lining-up work (`LISTING_COUNT_WORK`). */
type CountBudget = { left: number };

/** One side as read: its facts, and its bytes while the file is being counted (none past `MAX_CHANGE_SIDE_BYTES`). */
type ReadSide = { readonly bytes?: Uint8Array; readonly facts: SideFacts };

export class WorkspaceChangesModule {
  readonly #options: ChangesOptions;
  readonly #counts = new Map<string, Counted>();

  constructor(options: ChangesOptions) {
    this.#options = options;
  }

  #files(): ChangesFiles {
    return settled(this.#options.files());
  }

  /** The repos `directory` covers: its own repo, or every repo directly below the Workspace's root. */
  async #repos(directory: string): Promise<string[]> {
    const files = this.#files();

    const below = directory.startsWith(`${WORKSPACE_ROOT}/`)
      ? directory.slice(WORKSPACE_ROOT.length + 1).split("/")[0]
      : undefined;

    const names =
      below !== undefined && below !== ""
        ? [below]
        : namesOf(await files.readdir(WORKSPACE_ROOT).catch(() => []));

    const repos: string[] = [];

    for (const name of [...names].sort()) {
      if (!isRepoName(name)) continue;

      try {
        await files.stat(`${WORKSPACE_ROOT}/${name}/.git`);
        repos.push(name);
      } catch {
        // Not a repo.
      }
    }

    return repos;
  }

  /** The Changes of the repos `request` covers, in order of name, at most `maxFiles` across them. */
  async list(request: ChangesRequest): Promise<WorkspaceChanges> {
    const repos = await this.#repos(request.directory);
    const containerOnly = await this.#options.containerOnly();
    const budget: CountBudget = { left: LISTING_COUNT_WORK };
    const plans: RepoPlan[] = [];

    for (const repo of repos) plans.push(await this.#plan(repo, containerOnly, budget));

    const fallback = Arr.flatMap(plans, (plan) => (plan.listed === null ? [plan.repo] : []));

    const container =
      fallback.length > 0 && (request.startContainer || this.#options.running())
        ? await this.#onContainer(fallback)
        : new Map<string, ContainerRepoChanges>();

    let room = MAX_CHANGED_FILES;
    const listed: RepoChanges[] = [];

    for (const plan of plans) {
      const repo = await this.#assemble(plan, container.get(plan.repo), containerOnly);
      const files = repo.files.slice(0, Math.max(room, 0));

      room -= files.length;
      listed.push({ ...repo, files, more: repo.more + (repo.files.length - files.length) });
    }

    return { repos: listed };
  }

  /** Where `repo` stands and how it is listed: by the Workspace DO itself, or by the Container's git and why. */
  async #plan(repo: string, containerOnly: ContainerOnly, budget: CountBudget): Promise<RepoPlan> {
    const files = this.#files();
    const fs = readOnly(files);
    const dir = `${WORKSPACE_ROOT}/${repo}`;
    const head = await readHead(fs, dir);

    const attributes = readAttributes(
      await files.readFile(`${dir}/.gitattributes`, "utf8").then(toText, () => undefined),
    );

    if (await this.#needsContainer(files, dir, attributes)) {
      return { repo, head, attributes, listed: null };
    }

    try {
      return {
        repo,
        head,
        attributes,
        listed: await this.#listOwn(fs, dir, head, attributes, containerOnly, budget),
      };
    } catch (cause) {
      this.#options.warn(`changes: isomorphic-git failed in ${repo}: ${errorText(cause)}`);

      return { repo, head, attributes, listed: null };
    }
  }

  /** Whether the repo at `dir` is the Container's git's to list: rules git applies, a big pack, or many files. */
  async #needsContainer(
    files: ChangesFiles,
    dir: string,
    attributes: RootAttributes,
  ): Promise<boolean> {
    if (attributes.compares) return true;

    if ((await packfileBytes(files, `${dir}/.git`).catch(() => 0)) > MAX_PACK_BYTES) return true;

    const tracked = await trackedFiles(files, `${dir}/.git/index`);

    return tracked > (this.#options.maxTrackedFiles ?? MAX_TRACKED_FILES);
  }

  /**
   * The Workspace DO's own listing of the repo at `dir`: its changed files by path, read until they make
   * `MAX_CHANGED_FILES` entries (a rename is one), and how many it did not read.
   */
  async #listOwn(
    fs: Fs,
    dir: string,
    head: RepoHead,
    attributes: RootAttributes,
    containerOnly: ContainerOnly,
    budget: CountBudget,
  ): Promise<OwnListing> {
    const cache: GitCache = {};
    const matrix = await git.statusMatrix({ fs, dir, cache, refresh: false });

    const changed = matrix
      .filter(([path, inHead, inWorkdir]) => {
        if (containerOnly(`${dir}/${path}`)) return false;

        return (inHead === 1 && inWorkdir !== 1) || (inHead === 0 && inWorkdir === 2);
      })
      .map(([path, inHead, inWorkdir]) => ({
        path,
        status:
          inHead === 0
            ? ("added" as const)
            : inWorkdir === 0
              ? ("deleted" as const)
              : ("modified" as const),
      }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

    const rows: Row[] = [];
    const renames = new RenameCount();

    // Each file is read, counted and let go before the next; only what the list says of it is kept.
    for (const { path, status } of changed) {
      if (rows.length - renames.pairs >= MAX_CHANGED_FILES) break;

      const old =
        status === "added" ? undefined : await this.#headSide(fs, dir, head.commit, path, cache);

      const now = status === "deleted" ? undefined : await this.#workingSide(fs, dir, path);

      const row: Row = {
        path,
        status,
        old: old?.facts,
        new: now?.facts,
        ...this.#counted(old, now, budget),
      };

      renames.add(row);
      rows.push(row);
    }

    return {
      files: withRenames(rows).map((entry) => withFlags(entry, attributes)),
      // A rename among the files not read counts as two: pairing them would mean reading them.
      more: changed.length - rows.length,
    };
  }

  async #headSide(fs: Fs, dir: string, commit: string | null, path: string, cache: GitCache) {
    if (commit === null) return undefined;

    const { blob } = await git.readBlob({ fs, dir, oid: commit, filepath: path, cache });

    return this.#facts(blob);
  }

  async #workingSide(fs: Fs, dir: string, path: string): Promise<ReadSide> {
    const read = await readWorking(fs, `${dir}/${path}`);

    if ("tooLarge" in read) return { facts: { bytes: read.tooLarge, binary: false, lines: 0 } };

    return this.#facts(read.bytes);
  }

  /** `bytes`' facts, and the bytes themselves unless they are too large to count (a HEAD side read whole). */
  async #facts(bytes: Uint8Array): Promise<ReadSide> {
    const binary = isBinary(bytes);

    const facts: SideFacts = {
      bytes: bytes.length,
      id: await blobId(bytes),
      binary,
      lines: binary ? 0 : lineCount(bytes),
    };

    return bytes.length > MAX_CHANGE_SIDE_BYTES ? { facts } : { bytes, facts };
  }

  /**
   * `+a −d` of a pair, lined up within the bounds (`MAX_COUNT_EDITS`, `COUNT_WORK`, what is left of the listing's
   * `budget`), or whole-file numbers ("≈") past them; null when not known (binary, or a side too large).
   */
  #counted(
    old: ReadSide | undefined,
    now: ReadSide | undefined,
    budget: CountBudget,
  ): Pick<Row, "additions" | "deletions" | "approximate"> {
    const unknown = { additions: null, deletions: null };
    const sides = [old?.facts, now?.facts].filter((side) => side !== undefined);

    const uncountable = (side: SideFacts) =>
      side.binary || side.id === undefined || side.bytes > MAX_CHANGE_SIDE_BYTES;

    if (sides.some(uncountable)) return unknown;

    if (old === undefined) return { additions: now?.facts.lines ?? 0, deletions: 0 };

    if (now === undefined) return { additions: 0, deletions: old.facts.lines };

    const key = `${old.facts.id}:${now.facts.id}`;
    const cached = this.#counts.get(key);

    if (cached !== undefined) {
      // Most recently used last, so the oldest is dropped first.
      this.#counts.delete(key);
      this.#counts.set(key, cached);

      return cached;
    }

    const whole = { additions: now.facts.lines, deletions: old.facts.lines, approximate: true };
    const lines = old.facts.lines + now.facts.lines;
    const maxEditLength = Math.min(MAX_COUNT_EDITS, Math.floor(COUNT_WORK / Math.max(lines, 1)));
    // At most `lines` edits are ever looked for, whatever the bound.
    const work = lines * Math.min(maxEditLength, lines);

    // Past the listing's budget: whole-file numbers, not kept, as the next listing may line the pair up.
    if (work > budget.left || old.bytes === undefined || now.bytes === undefined) return whole;

    budget.left -= work;

    const lined = diffLines(decoder.decode(old.bytes), decoder.decode(now.bytes), {
      maxEditLength,
      timeout: COUNT_TIMEOUT_MS,
    });

    let counted: Counted = whole;

    if (lined !== undefined) {
      let additions = 0;
      let deletions = 0;

      for (const part of lined) {
        if (part.added) additions += part.count;
        else if (part.removed) deletions += part.count;
      }

      counted = { additions, deletions };
    }

    this.#counts.set(key, counted);

    if (this.#counts.size > COUNTS_CACHED) {
      const oldest = this.#counts.keys().next();

      if (oldest.done !== true) this.#counts.delete(oldest.value);
    }

    return counted;
  }

  /** The Container's git's listing of `repos`, by repo; empty when it could not run (each repo then has an error). */
  async #onContainer(repos: ReadonlyArray<string>): Promise<Map<string, ContainerRepoChanges>> {
    const listed = new Map<string, ContainerRepoChanges>();

    try {
      const ran = await this.#options.run(changesScript(repos));

      for (const repo of parseChanges(ran.stdout)) listed.set(repo.repo, repo);

      if (ran.exitCode !== 0) {
        this.#options.warn(
          `changes: the Container's listing exited ${ran.exitCode}: ${ran.stderr}`,
        );
      }

      // A repo it printed nothing for was not listed: say why rather than keep the last list as if nothing happened.
      for (const repo of repos) {
        if (!listed.has(repo)) {
          listed.set(repo, {
            repo,
            error: `The Container could not list the Changes: ${ran.stderr.trim() || `exit ${ran.exitCode}`}`,
          });
        }
      }
    } catch (cause) {
      this.#options.warn(`changes: the Container's listing failed: ${errorText(cause)}`);

      for (const repo of repos)
        listed.set(repo, {
          repo,
          error: `The Container could not list the Changes: ${errorText(cause)}`,
        });
    }

    return listed;
  }

  /** `plan`'s repo as the list shows it, with the Container's git's listing when it ran for the repo. */
  async #assemble(
    plan: RepoPlan,
    container: ContainerRepoChanges | undefined,
    containerOnly: ContainerOnly,
  ): Promise<RepoChanges> {
    const { repo, head } = plan;

    if (plan.listed !== null) return { repo, head, ...plan.listed, stale: false };

    const kept = await this.#options.kept.load(repo).catch(() => undefined);

    const stale = {
      repo,
      head,
      files: [...(kept?.files ?? [])],
      more: kept?.more ?? 0,
      stale: true,
    };

    if (container === undefined) return stale;

    if ("error" in container) return { ...stale, error: container.error };

    const dir = `${WORKSPACE_ROOT}/${repo}`;
    const files = this.#files();

    const entries = container.files.filter(
      (file) =>
        !containerOnly(`${dir}/${file.path}`) &&
        (file.oldPath === undefined || !containerOnly(`${dir}/${file.oldPath}`)),
    );

    const listed: ChangeEntry[] = [];

    for (const file of entries.slice(0, MAX_CHANGED_FILES)) {
      const newBytes =
        file.status === "deleted"
          ? null
          : await files.lstat(`${dir}/${file.path}`).then(
              (stat) => stat.size,
              () => null,
            );

      const tooLarge =
        (file.oldBytes ?? 0) > MAX_CHANGE_SIDE_BYTES || (newBytes ?? 0) > MAX_CHANGE_SIDE_BYTES;

      listed.push(
        withFlags(
          entryOf({
            path: file.path,
            oldPath: file.oldPath,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            approximate: false,
            binary: file.binary,
            tooLarge,
          }),
          plan.attributes,
        ),
      );
    }

    const fresh = { files: listed, more: entries.length - listed.length };

    await this.#options.kept.save(repo, fresh).catch((cause: unknown) => {
      this.#options.warn(`changes: keeping ${repo}'s list failed: ${errorText(cause)}`);
    });

    return { repo, head, ...fresh, stale: false };
  }

  /** One changed file's two sides. It never starts the Container. */
  async file(request: ChangeFileRequest): Promise<ChangeFile> {
    const { repo, path } = request;
    const oldPath = request.oldPath ?? path;

    if (!isRepoName(repo) || !isRepoPath(path) || !isRepoPath(oldPath)) {
      throw new Error("No such file in the Workspace's repos");
    }

    const files = this.#files();
    const fs = readOnly(files);
    const dir = `${WORKSPACE_ROOT}/${repo}`;

    await files.stat(`${dir}/.git`).catch(() => {
      throw new Error(`${repo} is not a repo of the Workspace`);
    });

    return {
      old: await this.#headFile(files, fs, dir, oldPath),
      new: await this.#workingFile(fs, dir, path),
    };
  }

  async #headFile(
    files: ChangesFiles,
    fs: Fs,
    dir: string,
    path: string,
  ): Promise<ChangeSide | null> {
    const head = await readHead(fs, dir);

    if (head.commit === null) return null;

    if ((await packfileBytes(files, `${dir}/.git`).catch(() => 0)) <= MAX_PACK_BYTES) {
      try {
        const { blob } = await git.readBlob({ fs, dir, oid: head.commit, filepath: path });

        return sideOf(blob, blob.length);
      } catch (cause) {
        if (isNotFound(cause)) return null;

        this.#options.warn(`changes: readBlob failed in ${dir}: ${errorText(cause)}`);
      }
    }

    if (!this.#options.running()) {
      throw new Error(
        "This file's HEAD side needs the Container, which is stopped: refresh the Changes by hand",
      );
    }

    const repo = dir.slice(WORKSPACE_ROOT.length + 1);
    const ran = await this.#options.run(headBlobScript(repo, path, MAX_CHANGE_SIDE_BYTES));
    const read = parseHeadBlob(ran.stdout);

    if (read === null) return null;

    return read.blob === undefined
      ? { kind: "too_large", bytes: read.bytes }
      : sideOf(read.blob, read.bytes);
  }

  async #workingFile(fs: Fs, dir: string, path: string): Promise<ChangeSide | null> {
    try {
      const read = await readWorking(fs, `${dir}/${path}`);

      return "tooLarge" in read
        ? { kind: "too_large", bytes: read.tooLarge }
        : sideOf(read.bytes, read.bytes.length);
    } catch (cause) {
      if (isNotFound(cause)) return null;

      throw cause;
    }
  }
}

/**
 * The working side at `full`: a symbolic link's target, or the file's bytes, or only its size when it is over
 * `MAX_CHANGE_SIDE_BYTES`. It rejects for a file that is not there.
 */
const readWorking = async (
  fs: Fs,
  full: string,
): Promise<{ readonly bytes: Uint8Array } | { readonly tooLarge: number }> => {
  const stat = await fs.promises.lstat(full);

  if (stat.isSymbolicLink()) return { bytes: encoder.encode(await fs.promises.readlink(full)) };

  if (stat.size > MAX_CHANGE_SIDE_BYTES) return { tooLarge: stat.size };

  return { bytes: toBytes(await fs.promises.readFile(full)) };
};

/**
 * How many deletions and additions of the same blob a listing has read so far, paired as renames: the entries its rows
 * make are the rows less the pairs.
 */
class RenameCount {
  readonly #added = new Map<string, number>();
  readonly #deleted = new Map<string, number>();
  pairs = 0;

  add(row: Row): void {
    if (row.status === "added") this.#count(row.new?.id, this.#added, this.#deleted);

    if (row.status === "deleted") this.#count(row.old?.id, this.#deleted, this.#added);
  }

  /** One more of blob `id` in `mine`: a pair if `theirs` has one of it left unpaired. */
  #count(id: string | undefined, mine: Map<string, number>, theirs: Map<string, number>): void {
    if (id === undefined) return;

    const count = mine.get(id) ?? 0;

    if (count < (theirs.get(id) ?? 0)) this.pairs++;

    mine.set(id, count + 1);
  }
}

/** `bytes` as a side: too large, binary, or its text. */
const sideOf = (bytes: Uint8Array, size: number): ChangeSide => {
  if (size > MAX_CHANGE_SIDE_BYTES) return { kind: "too_large", bytes: size };

  return isBinary(bytes) ? { kind: "binary" } : { kind: "text", text: decoder.decode(bytes) };
};

/** A path inside a repo: relative, with no `.`, `..` or empty segment, and not in `.git`. */
const isRepoPath = (path: string): boolean => {
  const segments = path.split("/");

  return (
    segments.every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    segments[0] !== ".git"
  );
};

/** The repo's HEAD: its commit (null before the first) and branch (null when detached). */
const readHead = async (fs: Fs, dir: string): Promise<RepoHead> => {
  const commit = await git.resolveRef({ fs, dir, ref: "HEAD" }).catch(() => null);
  const branch = await git.currentBranch({ fs, dir, fullname: false }).catch(() => undefined);

  return { commit, branch: branch ?? null };
};

/** How many entries the index holds, from its header (`DIRC`, version, count); 0 without one. */
const trackedFiles = async (files: ChangesFiles, index: string): Promise<number> => {
  try {
    const header =
      files.readRangeSync === undefined
        ? toBytes(await files.readFile(index)).subarray(0, 12)
        : files.readRangeSync(index, 0, 12);

    if (header.length < 12) return 0;

    return new DataView(header.buffer, header.byteOffset, 12).getUint32(8);
  } catch {
    return 0;
  }
};

/** `rows` with a deletion and an addition of the same blob paired as a rename, the first of each by path. */
const withRenames = (rows: readonly Row[]): ChangeEntry[] => {
  const added = new Map<string, Row[]>();

  for (const row of rows) {
    const id = row.new?.id;

    if (row.status === "added" && id !== undefined) added.set(id, [...(added.get(id) ?? []), row]);
  }

  const paired = new Map<Row, Row>();
  const taken = new Set<Row>();

  for (const row of rows) {
    const id = row.old?.id;

    if (row.status !== "deleted" || id === undefined) continue;

    const match = added.get(id)?.find((candidate) => !taken.has(candidate));

    if (match !== undefined) {
      taken.add(match);
      paired.set(match, row);
    }
  }

  const removed = new Set(paired.values());
  const entries: ChangeEntry[] = [];

  for (const row of rows) {
    if (removed.has(row)) continue;

    const from = paired.get(row);

    const tooLarge = [row.old, row.new].some(
      (each) => each !== undefined && each.bytes > MAX_CHANGE_SIDE_BYTES,
    );

    entries.push(
      entryOf({
        path: row.path,
        oldPath: from?.path,
        status: from === undefined ? row.status : "renamed",
        additions: from === undefined ? row.additions : 0,
        deletions: from === undefined ? row.deletions : 0,
        approximate: from === undefined && row.approximate === true,
        binary: [row.old, row.new].some((each) => each?.binary === true),
        tooLarge,
      }),
    );
  }

  return entries;
};

/** What a file entry says, each flag false when it does not apply. */
type EntryFacts = {
  readonly path: string;
  readonly oldPath: string | undefined;
  readonly status: ChangeStatus;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly approximate: boolean;
  readonly binary: boolean;
  readonly tooLarge: boolean;
};

/** The entry `facts` make: an old path and flags only where they apply, as the protocol leaves them out otherwise. */
const entryOf = (facts: EntryFacts): ChangeEntry => {
  const entry: Types.Mutable<ChangeEntry> = {
    path: facts.path,
    status: facts.status,
    additions: facts.additions,
    deletions: facts.deletions,
  };

  if (facts.oldPath !== undefined) entry.oldPath = facts.oldPath;

  if (facts.approximate) entry.approximate = true;

  if (facts.binary) entry.binary = true;

  if (facts.tooLarge) entry.tooLarge = true;

  return entry;
};

/** `entry` with its root `.gitattributes` linguist flags. */
const withFlags = (entry: ChangeEntry, attributes: RootAttributes): ChangeEntry => {
  const flags: LinguistFlags = attributes.linguist(entry.path);

  return { ...entry, ...flags };
};
