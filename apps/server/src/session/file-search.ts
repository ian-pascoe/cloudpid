// The composer's `@` menu on the Session's side (`files`): the paths a conversation's directory offers, from one
// gitignore-aware `ExecutionEnv.listFiles` walk, held for `LISTING_TTL` so typing a mention asks the Workspace once, and
// the best of them for what follows the `@`, ranked as the menu ranks (`rank` in `@cloudpid/protocol`).
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions and loops over tens of thousands of paths, per request.
import {
  bestMatches,
  CLOUDPID_ROOT,
  MAX_FILE_MATCHES,
  type RankCandidate,
  rankCandidate,
  WORKSPACE_ROOT,
} from "@cloudpid/protocol";
import type { Context as ChordContext } from "@earendil-works/chord";
import type { ExecutionEnv, FileListEntry } from "@earendil-works/pi-durable/env";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

/** How long a directory's listing answers `files` before it is made again. */
export const LISTING_TTL: Duration.Input = "30 seconds";

/** The most entries one listing holds (`ListFilesOptions.maxEntries`); a bigger directory is cut off past them. */
export const MAX_LISTED_ENTRIES = 50_000;

/** The most directories whose listings the Session holds at once: the root's and a few subagents'. */
export const MAX_CACHED_DIRECTORIES = 4;

/** The most paths the Session holds across its listings: two directories at the bound of one. */
export const MAX_CACHED_ENTRIES = 2 * MAX_LISTED_ENTRIES;

/** How long the walk of a directory may take (`ListFilesOptions.timeoutMs`); past it, it is cut off. */
export const LISTING_WALK_TIMEOUT_MS = 8_000;

/** How long a listing may take, the Workspace's answer included, before it fails and the next request lists again. */
export const LISTING_TIMEOUT: Duration.Input = "10 seconds";

/** The most listings made at once; more wait for one of them to end. */
export const MAX_LISTINGS_IN_FLIGHT = 2;

/** Names skipped with everything below them, besides `.git`, which a listing never holds. */
export const EXCLUDED_NAMES: readonly string[] = ["node_modules"];

/**
 * Directories never offered, wherever the conversation works: every Session's Attachments, and the Skill set,
 * mounted read-only into every Workspace (AGENTS.md → Skills).
 */
export const EXCLUDED_ROOTS: readonly string[] = [
  CLOUDPID_ROOT,
  `${WORKSPACE_ROOT}/.agents/skills`,
];

const depth = (path: string): number => {
  let slashes = 0;

  for (
    let at = path.indexOf("/");
    at >= 0 && at < path.length - 1;
    at = path.indexOf("/", at + 1)
  ) {
    slashes += 1;
  }

  return slashes;
};

/** Whether the absolute `path` is `root` or below it. */
const under = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/**
 * The paths the listing of `directory` offers the menu: a folder's ends in `/`, and the folders above a path the listing
 * does not hold itself are added (a listing holds every folder before what is in it, so only a cut-off one lacks any).
 * A symbolic link is offered as a file, since it is not followed. Left out: a path holding whitespace, which a mention
 * could not hold (it ends at the first space, and the agent reads no quoting), and what is under `EXCLUDED_ROOTS`.
 * Shallower paths come first, the listing's order kept among those as deep, so an empty query offers the top level and,
 * among equal matches, the nearer path wins.
 */
export const fileCandidates = (entries: readonly FileListEntry[], directory: string): string[] => {
  const prefix = directory === "/" ? "/" : `${directory}/`;
  const seen = new Set<string>();
  const paths: string[] = [];

  const add = (path: string) => {
    if (seen.has(path)) return;

    seen.add(path);
    paths.push(path);
  };

  for (const { path, kind } of entries) {
    const absolute = `${prefix}${path}`;

    if (/\s/.test(path) || EXCLUDED_ROOTS.some((root) => under(absolute, root))) continue;

    for (let at = path.indexOf("/"); at > 0; at = path.indexOf("/", at + 1)) {
      add(path.slice(0, at + 1));
    }

    add(kind === "directory" ? `${path}/` : path);
  }

  return paths
    .map((path, index) => ({ path, index, depth: depth(path) }))
    .toSorted((a, b) => a.depth - b.depth || a.index - b.index)
    .map(({ path }) => path);
};

/** A directory's paths, each made ready to rank once (`rankCandidate`). */
export type FileIndex = ReadonlyArray<RankCandidate>;

/** `paths` made ready to rank. */
export const fileIndex = (paths: readonly string[]): FileIndex => paths.map(rankCandidate);

/** The best `MAX_FILE_MATCHES` of `index` for `query`, as the menu ranks them. */
export const matchFiles = (query: string, index: FileIndex): string[] =>
  bestMatches(query, index, MAX_FILE_MATCHES);

export type FileListingsOptions = {
  /** Defaults to `LISTING_TTL`. */
  readonly ttl?: Duration.Input;
  /** Defaults to `MAX_CACHED_DIRECTORIES`. */
  readonly maxDirectories?: number;
  /** Defaults to `MAX_CACHED_ENTRIES`. */
  readonly maxEntries?: number;
  /** Defaults to `LISTING_TIMEOUT`. */
  readonly timeout?: Duration.Input;
  /** Defaults to `MAX_LISTINGS_IN_FLIGHT`. */
  readonly maxInFlight?: number;
};

/** A directory could not be listed. */
export class FileListingError extends Schema.TaggedError<
  FileListingError,
  { readonly brand: unique symbol }
>()("FileListingError", { message: Schema.String }) {}

export type FileListingsService = {
  /**
   * The paths of `directory`: the listing held for it while fresh, the one being made when a request already started
   * it, else `list`'s, held from then on. A listing that fails, or takes longer than its timeout, is not held.
   */
  readonly get: (
    directory: string,
    list: Effect.Effect<FileIndex, FileListingError>,
  ) => Effect.Effect<FileIndex, FileListingError>;
  /** The directories held now, least recently asked first. */
  readonly held: Effect.Effect<readonly string[]>;
};

/** The directory listings a Session holds for its `@` menus. */
export class FileListings extends Context.Service<FileListings, FileListingsService>()(
  "@cloudpid/server/session/file-search/FileListings",
) {}

type Held = {
  readonly done: Deferred.Deferred<FileIndex, FileListingError>;
  /** When it goes stale; undefined while it is being made. */
  expiresAt: number | undefined;
  /** How many paths it holds; 0 while it is being made. */
  entries: number;
};

/**
 * Listings held per directory for `ttl`, at most `maxDirectories` of them and `maxEntries` paths in all: past either, the
 * least recently asked settled ones go first (one being made is never dropped). Requests that come while a directory is
 * listed wait for that listing, which runs in the layer's scope, so a request given up on does not cancel it for the
 * others. At most `maxInFlight` listings run at once, and one that has not ended within `timeout` fails.
 */
export const fileListingsLayer = (options: FileListingsOptions = {}): Layer.Layer<FileListings> =>
  Layer.effect(
    FileListings,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      const ttl = Duration.toMillis(options.ttl ?? LISTING_TTL);
      const maxDirectories = options.maxDirectories ?? MAX_CACHED_DIRECTORIES;
      const maxEntries = options.maxEntries ?? MAX_CACHED_ENTRIES;
      const timeout = options.timeout ?? LISTING_TIMEOUT;

      const inFlight = Semaphore.withPermit(
        yield* Semaphore.make(options.maxInFlight ?? MAX_LISTINGS_IN_FLIGHT),
      );

      // In the order they were last asked for: a Map iterates in insertion order.
      const held = new Map<string, Held>();

      /** Drop what is stale, then the least recently asked until the bounds hold, never `keep` nor one being made. */
      const evict = (now: number, keep: string) => {
        let total = 0;

        for (const [directory, listing] of held) {
          if (listing.expiresAt !== undefined && listing.expiresAt <= now) held.delete(directory);
          else total += listing.entries;
        }

        for (const [directory, listing] of held) {
          if (held.size <= maxDirectories && total <= maxEntries) break;

          if (directory === keep || listing.expiresAt === undefined) continue;

          held.delete(directory);
          total -= listing.entries;
        }
      };

      /** The listing to wait for, and whether this request must make it. */
      const claim = (directory: string, now: number) => {
        const found = held.get(directory);

        held.delete(directory);

        if (found !== undefined && (found.expiresAt === undefined || now < found.expiresAt)) {
          held.set(directory, found);

          return { listing: found, fresh: false };
        }

        const listing: Held = { done: Deferred.makeUnsafe(), expiresAt: undefined, entries: 0 };

        held.set(directory, listing);
        evict(now, directory);

        return { listing, fresh: true };
      };

      const settle = (directory: string, listing: Held, paths: FileIndex) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => {
            listing.expiresAt = now + ttl;
            listing.entries = paths.length;

            if (held.get(directory) === listing) evict(now, directory);

            return paths;
          }),
        );

      const forget = (directory: string, listing: Held) =>
        Effect.sync(() => {
          if (held.get(directory) === listing) held.delete(directory);
        });

      const timedOut = Effect.suspend(() =>
        Effect.fail(
          FileListingError.make({
            message: `Listing the files took longer than ${Duration.format(Duration.fromInputUnsafe(timeout))}`,
          }),
        ),
      );

      const get = (directory: string, list: Effect.Effect<FileIndex, FileListingError>) =>
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => claim(directory, now)),
          Effect.tap(({ listing, fresh }) =>
            fresh
              ? list.pipe(
                  inFlight,
                  Effect.timeoutOrElse({ duration: timeout, orElse: () => timedOut }),
                  Effect.flatMap((paths) => settle(directory, listing, paths)),
                  // Whatever ends it, interruption included, ends it for every request waiting.
                  Effect.onExit((exit) =>
                    (Exit.isSuccess(exit) ? Effect.void : forget(directory, listing)).pipe(
                      Effect.andThen(Deferred.done(listing.done, exit)),
                    ),
                  ),
                  Effect.forkIn(scope),
                )
              : Effect.void,
          ),
          // A request interrupted between claiming a listing and starting it would leave it claimed and never made.
          Effect.uninterruptible,
          Effect.flatMap(({ listing }) => Deferred.await(listing.done)),
        );

      return {
        get,
        held: Effect.sync(() => [...held.keys()]),
      } satisfies FileListingsService;
    }),
  );

/**
 * The paths `env` offers the `@` menu from its directory, held in `listings` per file namespace and directory: one
 * bounded walk (`EXCLUDED_NAMES`, `MAX_LISTED_ENTRIES`, `LISTING_WALK_TIMEOUT_MS`), cut off with a warning past its
 * bounds. An environment that cannot list files offers none.
 */
export const listedPaths = (
  listings: FileListingsService,
  env: ExecutionEnv,
  context: ChordContext,
): Effect.Effect<FileIndex, FileListingError> => {
  const list = env.listFiles?.bind(env);

  if (list === undefined) return Effect.succeed<FileIndex>([]);

  const options = {
    exclude: EXCLUDED_NAMES,
    maxEntries: MAX_LISTED_ENTRIES,
    timeoutMs: LISTING_WALK_TIMEOUT_MS,
  };

  const listed = Effect.tryPromise({
    try: () => list(".", options, context),
    catch: (cause) => FileListingError.make({ message: String(cause) }),
  }).pipe(
    Effect.flatMap((result) =>
      result.ok
        ? Effect.succeed(result.value)
        : Effect.fail(FileListingError.make({ message: result.error.message })),
    ),
    Effect.tap(({ entries, truncated }) =>
      truncated
        ? Effect.logWarning("The @ menu's listing of a directory was cut off at its bounds", {
            directory: env.cwd,
            entries: entries.length,
          })
        : Effect.void,
    ),
    Effect.map(({ entries }) => fileIndex(fileCandidates(entries, env.cwd))),
  );

  return listings.get(`${env.id}:${env.cwd}`, listed);
};
