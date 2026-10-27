// What loads and draws one Diff pane's files, as atoms (ADR-0011), made when its scroll mounts and gone when it unmounts:
// the workers held (`workers.ts`, shut 30 s after the last Pane lets them go), the loader (`loader.ts`), the files to
// load from where the scroll is (`filesNear`), and the library's items (`items.ts`). The scroll reports where its files
// sit (`geometry`); the rest follows. Part of the Pane's lazy chunk.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a constructor of a scroll's atoms, over native arrays.

import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import type { CodeViewDiffItem } from "@pierre/diffs";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { diffDrafts } from "../review/drafts.ts";
import { editorAtom, type EditorState } from "../review/editor.ts";
import { appRuntime } from "../runtime.ts";
import { annotationsAtom, sessionClientAtom } from "../session/atoms.ts";
import {
  type Annotated,
  type AnnotatedItem,
  annotatedItems,
  paneAnchor,
  paneDrafts,
} from "./annotated-items.ts";
import { itemsOf, type Items } from "./items.ts";
import { fileLoader, type Loads, type WantedFile } from "./loader.ts";
import { filesNear, type PlacedFile, type View } from "./loading.ts";
import type { PaneAtoms } from "./pane-atoms.ts";
import { hasContents } from "./pane-files.ts";
import { lineUpWorker, workerPool } from "./workers.ts";

const NO_LOADS: Loads = { loaded: new Map(), loading: new Set() };

/** Where the scroll's files sit, and the part that shows. */
export interface Geometry {
  readonly placed: readonly PlacedFile[];
  readonly view: View;
}

/** Whether two reports say the same: a report that changes nothing changes no atom. */
const sameGeometry = (one: Geometry | null, other: Geometry | null): boolean =>
  one === other ||
  (one !== null &&
    other !== null &&
    one.view.top === other.view.top &&
    one.view.bottom === other.view.bottom &&
    one.placed.length === other.placed.length &&
    one.placed.every((file, index) => {
      const twin = other.placed[index];

      return twin?.id === file.id && twin.top === file.top && twin.bottom === file.bottom;
    }));

/** `next`, or `before` when it holds the same items: the scroll is handed a new list only when an item changed. */
const sameItems = (
  before: readonly CodeViewDiffItem<undefined>[] | undefined,
  next: readonly CodeViewDiffItem<undefined>[],
): readonly CodeViewDiffItem<undefined>[] =>
  before !== undefined &&
  before.length === next.length &&
  before.every((item, index) => item === next[index])
    ? before
    : next;

/** How far beyond the visible window files are loaded ahead: a screenful, at least 600 px. */
const marginOf = (view: View): number => Math.max(view.bottom - view.top, 600);

/** The atoms of one Diff pane's scroll. */
export interface ViewAtoms {
  /** The Worker Pool, once the scroll's workers are held. */
  readonly pool: Atom.Atom<WorkerPoolManager | undefined>;
  /** Where the files sit, as the scroll last reported; null until it has. */
  readonly geometry: Atom.Writable<Geometry | null, Geometry | null>;
  readonly loads: Atom.Atom<Loads>;
  readonly items: Atom.Atom<readonly CodeViewDiffItem<undefined>[]>;
  /** The scroll's editor of drafts (`AnnotationEditor`): one for all its files. */
  readonly editor: Atom.Writable<EditorState>;
  /** The items with the drafts on each file, and the editor of a new one where it is open. */
  readonly annotated: Atom.Atom<readonly AnnotatedItem[]>;
  /** Mounted while the scroll is: hands the files wanted to the loader as they change. */
  readonly driving: Atom.Atom<AsyncResult.AsyncResult<void>>;
}

/** The atoms of the scroll of `pane`. */
export const viewAtomsOf = (pane: PaneAtoms): ViewAtoms => {
  const { changes, files, folded, list } = pane;

  const held = appRuntime.atom((get) =>
    Effect.gen(function* () {
      const client = yield* get.result(sessionClientAtom(changes.sessionId));

      const lineUp = yield* Effect.acquireRelease(
        Effect.sync(() => lineUpWorker.acquire()),
        () => Effect.sync(() => lineUpWorker.release()),
      );

      // The pool queues what it is asked until its workers are set up.
      const pool = yield* Effect.acquireRelease(
        Effect.sync(() => workerPool.acquire()),
        () => Effect.sync(() => workerPool.release()),
      );

      const loader = yield* fileLoader({
        // From the Workspace whose Changes the Pane shows.
        changeFile: (query) => client.changeFile(query, changes.conversationId),
        comparisonFile: client.comparisonFile,
        runFile: client.runFile,
        lineUp: lineUp.lineUp,
      });

      return { loader, pool };
    }),
  );

  const pool = Atom.make((get) => {
    const result = get(held);

    return AsyncResult.isSuccess(result) ? result.value.pool : undefined;
  });

  const loadsRef = appRuntime.subscriptionRef((get) =>
    get.result(held).pipe(Effect.map(({ loader }) => loader.loads)),
  );

  const loads = Atom.make((get) => AsyncResult.getOrElse(get(loadsRef), () => NO_LOADS));

  const itemsById = Atom.make((get): Items =>
    itemsOf(
      get(files),
      get(folded),
      get(loads),
      Option.getOrElse(get.self<Items>(), (): Items => new Map()),
    ),
  );

  const items = Atom.make((get) =>
    sameItems(Option.getOrUndefined(get.self<readonly CodeViewDiffItem<undefined>[]>()), [
      ...get(itemsById).values(),
    ]),
  );

  const reported = Atom.make<Geometry | null>(null);

  const geometry = Atom.writable(
    (get) => get(reported),
    (ctx, next: Geometry | null) => {
      if (!sameGeometry(ctx.get(reported), next)) ctx.set(reported, next);
    },
  );

  const wanted = Atom.make((get): readonly WantedFile[] => {
    const at = get(geometry);

    if (at === null) return [];

    const { listing } = get(list);
    const shut = get(folded);
    const byId = new Map(get(files).map((file) => [file.id, file]));

    return filesNear({ ...at, margin: marginOf(at.view) }).flatMap(({ id, inView }) => {
      const file = byId.get(id);

      return file === undefined || shut.has(id) || !hasContents(file)
        ? []
        : [{ file, signature: file.signature, listing, inView }];
    });
  });

  const driving = appRuntime.atom((get) => {
    const now = get(wanted);

    return get.result(held).pipe(Effect.flatMap(({ loader }) => loader.want(now)));
  });

  const editor = editorAtom();

  const drafting = paneDrafts(changes);

  const annotatedById = Atom.make((get): Annotated => {
    const drafts = get(annotationsAtom(changes.sessionId));
    const { repos } = get(list);
    const open = get(editor);
    const byId = new Map(get(files).map((file) => [file.id, file]));

    return annotatedItems(
      get(items),
      (id) => {
        const file = byId.get(id);

        if (file === undefined || !drafting) return [];

        return diffDrafts(drafts, paneAnchor(file, repos), open, id).lineAnnotations;
      },
      Option.getOrElse(get.self<Annotated>(), (): Annotated => new Map()),
    );
  });

  const annotated = Atom.make((get) => {
    const next = [...get(annotatedById).values()].map((made) => made.item);
    const before = Option.getOrUndefined(get.self<readonly AnnotatedItem[]>());

    return before !== undefined &&
      before.length === next.length &&
      before.every((item, index) => item === next[index])
      ? before
      : next;
  });

  return { pool, geometry, loads, items, editor, annotated, driving };
};

/** The atoms of the Diff pane's scroll mounted here; its provider takes the Pane's atoms. */
export const ViewScope = ScopedAtom.make((pane: PaneAtoms) => Atom.make(viewAtomsOf(pane)));
