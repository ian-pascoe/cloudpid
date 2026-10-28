// The Diff pane's loading of its files' contents (`docs/architecture/diffs-and-review.md` → Diff pane), an Effect program per
// Pane. The Pane says which files it wants, nearest the view first (`want`); the loader keeps at most 4 loads running
// (`MAX_FILE_REQUESTS`), each `change_file`, then the line-up worker, then the library's file. A load whose file is no
// longer wanted (scrolled away, folded) or is wanted for another change (a new list) is interrupted. What a file shows is
// kept until its next load ends; a file whose text is the same as shown keeps the drawing it has.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- a constructor over its services, not a combinator; over native arrays and maps.

import type { ChangeFile } from "@cloudpid/protocol";
import type { FileDiffMetadata } from "@pierre/diffs";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { messageOf } from "../registry.ts";
import type { ChangeFileQuery } from "../session/atoms.ts";
import { fileDiffOf } from "./file-diff.ts";
import type { LineUp, LineUpRequest } from "./line-up.ts";
import { MAX_FILE_REQUESTS, needsLoad, type LoadedFrom, type WantedFrom } from "./loading.ts";
import type { PaneFile } from "./pane-files.ts";

/** What a loaded file shows. */
export type FileContents =
  | {
      readonly kind: "ready";
      readonly diff: FileDiffMetadata;
      readonly replaced: boolean;
      readonly oldText: string | null;
      readonly newText: string | null;
    }
  | { readonly kind: "same"; readonly oldText: string | null; readonly newText: string | null }
  | { readonly kind: "unavailable"; readonly what: "binary" | "too_large" }
  | { readonly kind: "failed"; readonly message: string };

/** A file's last load: what it shows, and for which change and list. */
export interface Loaded extends LoadedFrom {
  readonly contents: FileContents;
}

/** The files loaded, and those loading now. */
export interface Loads {
  readonly loaded: ReadonlyMap<string, Loaded>;
  readonly loading: ReadonlySet<string>;
}

/** A file the Pane wants loaded, from the current list. */
export interface WantedFile extends WantedFrom {
  readonly file: PaneFile;
}

/** One Pane's loads. */
export interface FileLoader {
  readonly loads: SubscriptionRef.SubscriptionRef<Loads>;
  /** The files wanted now, the first first: the others stop. */
  readonly want: (files: readonly WantedFile[]) => Effect.Effect<void>;
}

/** What the loader asks of the Session and the line-up worker. */
export interface LoaderServices {
  readonly changeFile: (
    query: ChangeFileQuery,
  ) => Effect.Effect<ChangeFile, { readonly message: string }>;
  /** A file of a Comparison (This branch), between its merge-base and head. */
  readonly comparisonFile: (
    query: ChangeFileQuery & { readonly mergeBase: string; readonly head: string },
  ) => Effect.Effect<ChangeFile, { readonly message: string }>;
  /** A file of the Last run, between its start copy and its end copy (the working tree while the Run is live). */
  readonly runFile: (
    query: ChangeFileQuery,
  ) => Effect.Effect<ChangeFile, { readonly message: string }>;
  readonly lineUp: (request: LineUpRequest) => Effect.Effect<LineUp, { readonly message: string }>;
}

/** The text of a side, or why there is none to show. */
const sideText = (
  side: ChangeFile["old"],
): { readonly text: string | null } | { readonly unavailable: "binary" | "too_large" } => {
  if (side === null) return { text: null };

  return side.kind === "text" ? { text: side.text } : { unavailable: side.kind };
};

/** What `file`'s two sides show, `before` being what it showed (the same text keeps its drawing). */
const contentsOf = (
  { lineUp }: LoaderServices,
  wanted: WantedFile,
  answer: ChangeFile,
  before: FileContents | undefined,
): Effect.Effect<FileContents, { readonly message: string }> => {
  const old = sideText(answer.old);
  const now = sideText(answer.new);

  if ("unavailable" in old) return Effect.succeed({ kind: "unavailable", what: old.unavailable });

  if ("unavailable" in now) return Effect.succeed({ kind: "unavailable", what: now.unavailable });

  if (
    (before?.kind === "ready" || before?.kind === "same") &&
    before.oldText === old.text &&
    before.newText === now.text
  ) {
    return Effect.succeed(before);
  }

  const { file } = wanted;

  return lineUp({
    oldName: old.text === null ? null : (file.entry.oldPath ?? file.entry.path),
    newName: now.text === null ? null : file.entry.path,
    oldText: old.text,
    newText: now.text,
  }).pipe(
    Effect.map(({ patch, replaced }): FileContents => {
      const diff = fileDiffOf({
        names: file.names,
        oldText: old.text,
        newText: now.text,
        patch,
        cacheKey: `${file.id}@${wanted.listing}@${file.signature}`,
      });

      return diff === undefined
        ? { kind: "same", oldText: old.text, newText: now.text }
        : { kind: "ready", diff, replaced, oldText: old.text, newText: now.text };
    }),
  );
};

/** A loader for one Pane, whose loads stop with `Scope`. */
export const fileLoader = (
  services: LoaderServices,
): Effect.Effect<FileLoader, never, Scope.Scope> =>
  Effect.gen(function* () {
    const loads = yield* SubscriptionRef.make<Loads>({ loaded: new Map(), loading: new Set() });
    const running = yield* FiberMap.make<string>();
    const lock = yield* Semaphore.make(1);
    const scope = yield* Effect.scope;
    // The change each running load is for, by file.
    const runningFor = new Map<string, string>();
    let wanted: readonly WantedFile[] = [];

    // Under `lock`; the loads change only when the files loading do.
    const publishLoading = Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(loads);

      if (
        current.loading.size === runningFor.size &&
        [...runningFor.keys()].every((id) => current.loading.has(id))
      ) {
        return;
      }

      yield* SubscriptionRef.set(loads, { ...current, loading: new Set(runningFor.keys()) });
    });

    const record = (want: WantedFile, contents: FileContents) =>
      Effect.suspend(() => {
        runningFor.delete(want.file.id);

        return SubscriptionRef.update(loads, (current) => ({
          ...current,
          loaded: new Map(current.loaded).set(want.file.id, {
            signature: want.signature,
            listing: want.listing,
            contents,
          }),
        }));
      });

    const load = (want: WantedFile): Effect.Effect<void> => {
      const { file } = want;

      const query: ChangeFileQuery =
        file.entry.oldPath === undefined
          ? { repo: file.repo, path: file.entry.path }
          : { repo: file.repo, path: file.entry.path, oldPath: file.entry.oldPath };

      return Effect.gen(function* () {
        const before = (yield* SubscriptionRef.get(loads)).loaded.get(file.id)?.contents;

        const answer = yield* file.run !== undefined
          ? services.runFile(query)
          : file.branch === undefined
            ? services.changeFile(query)
            : services.comparisonFile({
                ...query,
                mergeBase: file.branch.mergeBase,
                head: file.branch.head,
              });

        return yield* contentsOf(services, want, answer, before);
      }).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) => Effect.succeed<FileContents>({ kind: "failed", message: messageOf(cause) }),
        ),
        Effect.flatMap((contents) => lock.withPermits(1)(record(want, contents))),
        // The next loads start from a fiber of their own: this one may be the one a file's next load replaces.
        Effect.andThen(Effect.forkIn(lock.withPermits(1)(Effect.suspend(() => pump)), scope)),
        Effect.ignoreCause,
      );
    };

    // Stop what is not wanted, or wanted for another change, then start what is wanted and needs it, as room allows.
    // Runs under `lock`, whole: `runningFor` and the running fibers stay in step.
    const pump: Effect.Effect<void> = Effect.uninterruptible(
      Effect.gen(function* () {
        const byId = new Map(wanted.map((want) => [want.file.id, want]));

        for (const [id, signature] of runningFor) {
          if (byId.get(id)?.signature === signature) continue;

          runningFor.delete(id);
          yield* FiberMap.remove(running, id);
        }

        const { loaded } = yield* SubscriptionRef.get(loads);

        for (const want of wanted) {
          if (runningFor.size >= MAX_FILE_REQUESTS) break;

          const id = want.file.id;

          if (runningFor.has(id) || !needsLoad(loaded.get(id), want)) continue;

          runningFor.set(id, want.signature);
          yield* FiberMap.run(running, id, load(want));
        }

        yield* publishLoading;
      }),
    );

    return {
      loads,
      want: (files) =>
        lock.withPermits(1)(
          Effect.suspend(() => {
            wanted = files;

            return pump;
          }),
        ),
    };
  });
