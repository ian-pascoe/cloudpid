// The Session's Viewed boxes (`docs/architecture/diffs-and-review.md` → Comparisons): the files of a pull request the owner ticked,
// kept in this object's storage and sent whole to every client whenever they change, as the draft Annotations are (and
// like them, belonging to the Session: a Fork or Clone copies none). A box is keyed by repo, pull request number and path,
// and records the file's head blob: a push that changes the file brings a new blob, and a refresh of the pull request
// unticks the box ("as on GitHub"). Only pull request Comparisons have boxes.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain storage reads, under Effect.sync.
import { type Comparison, MAX_VIEWED, type ViewedFile } from "@cloudpid/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AnnotationStorage } from "./annotations.ts";
import { SessionError } from "./errors.ts";

/** The pull requests that have boxes, `repo\u0000number`, oldest first. */
const INDEX_KEY = "cloudpid:viewed";

/**
 * The most text the boxes hold in all (the lengths of their repos, paths and blobs added): a pull request's boxes are one
 * stored value, and the whole list is sent to every client, so the count alone (`MAX_VIEWED`) does not bound either.
 */
export const MAX_VIEWED_CHARS = 900_000;

/** One pull request's boxes: its files' head blobs, by path. */
const prKey = (repo: string, pull: number) => `cloudpid:viewed:${repo}:${pull}`;

const indexEntry = (repo: string, pull: number) => `${repo}\u0000${pull}`;

/** Which box: a file of a pull request. */
export type ViewedKey = Pick<ViewedFile, "repo" | "pull" | "path">;

export type ViewedStoreService = {
  /** Every box, oldest pull request first. */
  readonly list: Effect.Effect<ReadonlyArray<ViewedFile>>;
  /**
   * Tick the box of `key` at head blob `blob`, or untick it (`blob` null). The last set wins. Refused past `MAX_VIEWED`
   * boxes or `MAX_VIEWED_CHARS` characters of them (unticking is never refused).
   */
  readonly set: (key: ViewedKey, blob: string | null) => Effect.Effect<void, SessionError>;
  /**
   * A pull request's Comparison was made for a client: untick the boxes of its files whose head blob is no longer the one
   * they recorded, and those of files it no longer lists. One that comes back closed or merged drops all the pull
   * request's boxes (they would count toward the limit with nothing to untick them by). A Comparison marked `behind` is
   * not the pull request's head, and changes nothing.
   */
  readonly reset: (comparison: Comparison) => Effect.Effect<void>;
};

/** The Session's Viewed boxes. */
export class ViewedStore extends Context.Service<ViewedStore, ViewedStoreService>()(
  "@cloudpid/server/session/viewed/ViewedStore",
) {}

export type ViewedStoreOptions = {
  readonly storage: AnnotationStorage;
  /** Tell every client the boxes as they are now; called whenever they change. */
  readonly announce: (viewed: ReadonlyArray<ViewedFile>) => Effect.Effect<void>;
};

/** The Session's Viewed boxes over its storage; build it once per instance. */
export const viewedStoreLayer = (options: ViewedStoreOptions): Layer.Layer<ViewedStore> =>
  Layer.succeed(ViewedStore, makeViewedStore(options));

/** The store itself, for a caller that builds no layer. */
export const makeViewedStore = ({ storage, announce }: ViewedStoreOptions): ViewedStoreService => {
  const index = (): string[] => storage.get<string[]>(INDEX_KEY) ?? [];

  const read = (): ViewedFile[] =>
    index().flatMap((entry) => {
      const [repo = "", number = ""] = entry.split("\u0000");
      const pull = Number(number);
      const blobs = storage.get<Record<string, string>>(prKey(repo, pull)) ?? {};

      return Object.entries(blobs).map(([path, blob]) => ({ repo, pull, path, blob }));
    });

  /** Write one pull request's boxes, keeping the index in step; an empty set is deleted. */
  const write = (repo: string, pull: number, blobs: Record<string, string>) => {
    const entry = indexEntry(repo, pull);
    const before = index();

    if (Object.keys(blobs).length === 0) {
      storage.delete(prKey(repo, pull));

      if (before.includes(entry))
        storage.put(
          INDEX_KEY,
          before.filter((each) => each !== entry),
        );

      return;
    }

    storage.put(prKey(repo, pull), blobs);

    if (!before.includes(entry)) storage.put(INDEX_KEY, [...before, entry]);
  };

  const told = Effect.suspend(() => announce(read()));

  return {
    list: Effect.sync(read),
    set: ({ repo, pull, path }, blob) =>
      Effect.gen(function* () {
        const blobs = { ...storage.get<Record<string, string>>(prKey(repo, pull)) };

        if (blob === null) {
          if (!(path in blobs)) return;

          delete blobs[path];
        } else {
          if (blobs[path] === blob) return;

          if (!(path in blobs)) {
            const all = read();

            const chars = all.reduce(
              (sum, box) => sum + box.repo.length + box.path.length + box.blob.length,
              0,
            );

            if (
              all.length >= MAX_VIEWED ||
              chars + repo.length + path.length + blob.length > MAX_VIEWED_CHARS
            ) {
              return yield* SessionError.make({
                operation: "viewed",
                message: `A Session keeps at most ${MAX_VIEWED} Viewed boxes, and ${MAX_VIEWED_CHARS} characters of paths: untick some first`,
              });
            }
          }

          blobs[path] = blob;
        }

        yield* Effect.sync(() => {
          write(repo, pull, blobs);
        });
        yield* told;
      }),
    reset: (comparison) =>
      Effect.suspend(() => {
        const { pull, repo } = comparison;

        if (pull === undefined || comparison.behind !== undefined) return Effect.void;

        const blobs = storage.get<Record<string, string>>(prKey(repo, pull.number));

        if (blobs === undefined) return Effect.void;

        if (pull.state !== "open") {
          write(repo, pull.number, {});

          return told;
        }

        const listed = new Map(comparison.files.map((each) => [each.path, each]));
        const kept: Record<string, string> = {};

        for (const [path, blob] of Object.entries(blobs)) {
          const file = listed.get(path);

          // A file the list does not hold may be one past its cap: only a whole list says it left the pull request.
          const same =
            file === undefined
              ? comparison.more > 0
              : file.blob === undefined || file.blob === blob;

          if (same) kept[path] = blob;
        }

        if (Object.keys(kept).length === Object.keys(blobs).length) return Effect.void;

        write(repo, pull.number, kept);

        return told;
      }),
  };
};
