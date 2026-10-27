// The Session's draft Annotations (`docs/spec.md` → Diffs and review → Annotations and Reviews): kept in this object's
// storage, one key a draft, and sent whole to every client whenever they change, as the Approval requests are. A save
// replaces the draft of its ID, so the last save wins. Text still being typed stays in the browser that types it.
// Drafts belong to their Session: a Fork or Clone copies none, as it copies only what `fork.ts` names.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain storage reads, under Effect.sync.
import {
  type Annotation,
  type AnnotationDraft,
  cutQuote,
  MAX_ANNOTATIONS,
} from "@cloudpid/protocol";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Types from "effect/Types";
import { SessionError } from "./errors.ts";

/** The object's synchronous key-value storage, as the drafts use it. */
export type AnnotationStorage = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
};

/** The drafts' IDs, oldest first. */
const IDS_KEY = "cloudpid:annotations";

/** One draft, by its ID: a draft may hold 12 KB, and 100 of them would pass what one value should. */
const draftKey = (id: string) => `cloudpid:annotation:${id}`;

export type AnnotationStoreService = {
  /** Every draft, oldest first. */
  readonly list: Effect.Effect<ReadonlyArray<Annotation>>;
  /**
   * Save `draft`, new or edited, its quote cut to the limits. An edit keeps when it was made, and what the last check
   * found while its range is the same. Refused past `MAX_ANNOTATIONS` drafts.
   */
  readonly save: (draft: AnnotationDraft) => Effect.Effect<void, SessionError>;
  /** Delete draft `id`; one that is gone is not an error. */
  readonly delete: (id: string) => Effect.Effect<void>;
  /** Drafts `ids`, in that order; undefined when one of them is gone. */
  readonly take: (ids: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Annotation> | undefined>;
  /**
   * Put `checked` in place of the drafts they were made from, those not saved meanwhile (a later save wins over a check
   * that read the draft before it); told to the clients only when something changed.
   */
  readonly checked: (
    checked: ReadonlyArray<{ readonly before: Annotation; readonly after: Annotation }>,
  ) => Effect.Effect<void>;
  /** Delete drafts `ids`: a Review took them. */
  readonly remove: (ids: ReadonlyArray<string>) => Effect.Effect<void>;
  /** Put `drafts` back as they were (a withdrawn Review's), past the limit if need be; one already there stays. */
  readonly restore: (drafts: ReadonlyArray<Annotation>) => Effect.Effect<void>;
  /** Delete the drafts `keep` refuses. */
  readonly prune: (keep: (draft: Annotation) => boolean) => Effect.Effect<void>;
};

/** The Session's draft Annotations. */
export class AnnotationStore extends Context.Service<AnnotationStore, AnnotationStoreService>()(
  "@cloudpid/server/session/annotations/AnnotationStore",
) {}

export type AnnotationStoreOptions = {
  readonly storage: AnnotationStorage;
  /** Tell every client the drafts as they are now; called whenever they change. */
  readonly announce: (drafts: ReadonlyArray<Annotation>) => Effect.Effect<void>;
};

/** Whether a check found what the draft already says: the same range, mark and HEAD. */
const sameFinding = (a: Annotation, b: Annotation) =>
  a.start === b.start &&
  a.end === b.end &&
  a.status === b.status &&
  (a.source.kind !== "changes" || b.source.kind !== "changes" || a.source.head === b.source.head);

/** Whether two drafts cover the same lines of the same file. */
const sameRange = (a: Annotation, b: AnnotationDraft) =>
  a.path === b.path && a.side === b.side && a.start === b.start && a.end === b.end;

/** The Session's drafts over its storage; build it once per instance. */
export const annotationStoreLayer = ({
  storage,
  announce,
}: AnnotationStoreOptions): Layer.Layer<AnnotationStore> =>
  Layer.succeed(AnnotationStore, makeAnnotationStore({ storage, announce }));

/** The store itself, for a caller that builds no layer. */
export const makeAnnotationStore = ({
  storage,
  announce,
}: AnnotationStoreOptions): AnnotationStoreService => {
  const ids = (): string[] => storage.get<string[]>(IDS_KEY) ?? [];

  // By when each was made, so a withdrawn Review's drafts go back where they were.
  const read = (): Annotation[] =>
    ids()
      .flatMap((id) => {
        const draft = storage.get<Annotation>(draftKey(id));

        return draft === undefined ? [] : [draft];
      })
      .toSorted((a, b) => a.createdAt - b.createdAt);

  const write = (draft: Annotation) => {
    storage.put(draftKey(draft.id), draft);

    if (!ids().includes(draft.id)) storage.put(IDS_KEY, [...ids(), draft.id]);
  };

  const drop = (gone: ReadonlySet<string>): boolean => {
    const before = ids();
    const after = before.filter((id) => !gone.has(id));

    if (after.length === before.length) return false;

    for (const id of gone) storage.delete(draftKey(id));
    storage.put(IDS_KEY, after);

    return true;
  };

  const told = Effect.suspend(() => announce(read()));

  return {
    list: Effect.sync(read),
    save: (draft) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const existing = storage.get<Annotation>(draftKey(draft.id));

        if (existing === undefined && ids().length >= MAX_ANNOTATIONS) {
          return yield* SessionError.make({
            operation: "annotation",
            message: `A Session keeps at most ${MAX_ANNOTATIONS} draft Annotations: send or delete some first`,
          });
        }

        if (draft.end < draft.start) {
          return yield* SessionError.make({
            operation: "annotation",
            message: "An Annotation's range must end at or after its start",
          });
        }

        const { quote, more, clipped } = cutQuote(draft.quote, draft.more, draft.clipped === true);
        const { clipped: _clipped, ...rest } = draft;

        const saved: Types.Mutable<Annotation> = {
          ...rest,
          quote,
          more,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };

        if (clipped === true) saved.clipped = true;

        if (existing?.status !== undefined && sameRange(existing, draft)) {
          saved.status = existing.status;
        }

        yield* Effect.sync(() => write(saved));
        yield* told;
      }),
    delete: (id) =>
      Effect.suspend(() => (drop(new Set([id])) ? told : Effect.void)),
    take: (wanted) =>
      Effect.sync(() => {
        const drafts = wanted.map((id) => storage.get<Annotation>(draftKey(id)));

        return drafts.every((draft) => draft !== undefined) ? drafts : undefined;
      }),
    checked: (results) =>
      Effect.suspend(() => {
        let changed = false;

        for (const { before, after } of results) {
          const now = storage.get<Annotation>(draftKey(before.id));

          if (now === undefined || now.updatedAt !== before.updatedAt) continue;

          if (sameFinding(now, after)) continue;

          storage.put(draftKey(after.id), after);
          changed = true;
        }

        return changed ? told : Effect.void;
      }),
    remove: (gone) => Effect.suspend(() => (drop(new Set(gone)) ? told : Effect.void)),
    restore: (drafts) =>
      Effect.suspend(() => {
        const fresh = drafts.filter((draft) => storage.get(draftKey(draft.id)) === undefined);

        if (fresh.length === 0) return Effect.void;

        for (const draft of fresh) write(draft);

        return told;
      }),
    prune: (keep) =>
      Effect.suspend(() => {
        const gone = new Set(read().flatMap((draft) => (keep(draft) ? [] : [draft.id])));

        return gone.size > 0 && drop(gone) ? told : Effect.void;
      }),
  };
};
