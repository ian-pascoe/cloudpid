// @effect-diagnostics preferEffectArray:off -- the Pane's files, over native arrays and maps.

// The Diff pane's files in one scroll (`docs/spec.md` → Diffs and review → Diff pane): one virtualized `CodeView` with
// sticky headers that fold, highlighting on the Worker Pool. A file's contents are asked for (`change_file`) only while
// it is unfolded and near the visible window, the ones in view first, at most 4 at a time (`loader.ts`, driven from
// `view-atoms.ts`), and lined up in the line-up worker, past whose 2 s the file shows as a whole-file replacement, marked
// so. Binary and "Too large to show" files show their mark and counts only. After a new list of the Changes, a file whose
// change differs loads again as it comes near, and one in view loads again; each keeps what it shows until then. A place
// the Pane is asked to show holds the scroll, as the files above it load and grow, until the owner scrolls.
//
// This module is the Pane's lazy chunk: the library, its highlighter and the workers load with it.
//
// The owner drafts Annotations on the files from the gutter (`review/annotations-ui.tsx`): each item takes its file's
// drafts as `annotations` (`annotated-items.ts`), drawn by `renderAnnotation`, with one editor for the whole scroll.

import { useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { SelectedLineRange } from "@pierre/diffs";
import {
  CodeView,
  WorkerPoolContext,
  type CodeViewAnnotationArgs,
  type CodeViewHandle,
  type CodeViewItem,
  type CodeViewReactOptions,
} from "@pierre/diffs/react";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { DIFF_THEME } from "../diff-theme.ts";
import { cn } from "../lib/utils.ts";
import {
  AnnotationSlotView,
  DRAFTING_OPTIONS,
  useOpenEditor,
} from "../review/annotations-ui.tsx";
import type { AnnotationSlot } from "../review/drafts.ts";
import { AnnotationEditor } from "../review/editor.ts";
import { annotationsAtom, changesAtom } from "../session/atoms.ts";
import { paneAnchor } from "./annotated-items.ts";
import { useWidth } from "../use-width.ts";
import { FOLD_REASON_LABEL } from "./folding.ts";
import type { FileContents } from "./loader.ts";
import type { PlacedFile } from "./loading.ts";
import type { PaneAtoms } from "./pane-atoms.ts";
import type { PaneFile } from "./pane-files.ts";
import { EntryTally, StatusLetter } from "./parts.tsx";
import { diffLayoutAtom, diffStyleOf, diffWrapAtom } from "./prefs.ts";
import { ViewScope, type Geometry } from "./view-atoms.ts";
import { DIFF_LIMITS } from "./workers.ts";

/** The header of a file in the scroll, sticky while its lines pass: a fold toggle, its name, what it holds. */
const FileHeader = ({
  file,
  contents,
  folded,
  onToggle,
}: {
  file: PaneFile;
  contents: FileContents | undefined;
  folded: boolean;
  onToggle: (id: string) => void;
}) => {
  const { entry, names } = file;
  const label = folded ? `Open ${names.name}` : `Fold ${names.name}`;

  return (
    <div className="flex h-11 min-w-0 items-center gap-1.5 border-b bg-background pr-3 pl-1 text-sm">
      <button
        type="button"
        aria-expanded={!folded}
        aria-label={label}
        title={label}
        onClick={() => {
          onToggle(file.id);
        }}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&_svg]:size-4"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "transition-transform motion-reduce:transition-none",
            !folded && "rotate-90",
          )}
        />
      </button>
      <StatusLetter status={entry.status} />
      <span className="flex min-w-0 flex-1 items-center gap-1 font-mono text-xs">
        {names.prevName !== undefined && (
          <>
            <bdi className="min-w-0 truncate text-muted-foreground [direction:rtl]">
              {names.prevName}
            </bdi>
            <span aria-label="renamed to" className="shrink-0 text-muted-foreground">
              →
            </span>
          </>
        )}
        <bdi className="min-w-0 truncate [direction:rtl]" title={names.name}>
          {names.name}
        </bdi>
      </span>
      {/* Binary and "Too large to show" say so with the counts. */}
      <HeaderNote file={file} contents={contents} folded={folded} />
      <EntryTally entry={entry} />
    </div>
  );
};

/** What a file's header says beside its counts: why it is folded, or what its contents are. */
const HeaderNote = ({
  file,
  contents,
  folded,
}: {
  file: PaneFile;
  contents: FileContents | undefined;
  folded: boolean;
}) => {
  const note = (text: string) => (
    <span className="shrink-0 truncate text-xs whitespace-nowrap text-muted-foreground">
      {text}
    </span>
  );

  if (file.entry.binary === true || file.entry.tooLarge === true) return null;

  if (folded) return file.reason === undefined ? null : note(FOLD_REASON_LABEL[file.reason]);

  switch (contents?.kind) {
    case undefined:
      return note("Loading…");
    case "ready":
      return contents.replaced ? note("Replaced whole: lining it up took too long") : null;
    case "same":
      return note("No change in the text");
    case "unavailable":
      return note(contents.what === "binary" ? "Binary" : "Too large to show");
    case "failed":
      return (
        <span title={contents.message} className="min-w-0 shrink truncate text-xs text-destructive">
          Could not load: {contents.message}
        </span>
      );
  }
};

type Viewer = NonNullable<ReturnType<CodeViewHandle<AnnotationSlot, undefined>["getInstance"]>>;

/** Where the files of `instance` sit, and the part of its scroll that shows, from `scrollTop` when the scroll says it. */
const geometryOf = (
  instance: Viewer | undefined,
  files: readonly PaneFile[],
  scrollTop?: number,
): Geometry | null => {
  if (instance === undefined) return null;

  const tops = files.map((file) => instance.getTopForItem(file.id));
  const end = instance.getScrollHeight();
  const placed: PlacedFile[] = [];

  files.forEach((file, index) => {
    const top = tops[index];

    if (top !== undefined) placed.push({ id: file.id, top, bottom: tops[index + 1] ?? end });
  });

  const top = scrollTop ?? instance.getScrollTop();

  return { placed, view: { top, bottom: top + instance.getHeight() } };
};

export interface ChangesViewProps {
  readonly pane: PaneAtoms;
  /** Shown above the first file, in the scroll: the file list, on a narrow Pane. */
  readonly header?: ReactNode;
}

const Scroll = ({ pane, header }: ChangesViewProps) => {
  const view = useAtomValue(ViewScope.use());
  const files = useAtomValue(pane.files);
  const folded = useAtomValue(pane.folded);
  const { anchor } = useAtomValue(pane.ui);
  const act = useAtomSet(pane.ui);
  const layout = useAtomValue(diffLayoutAtom);
  const wrap = useAtomValue(diffWrapAtom);
  const pool = useAtomValue(view.pool);
  const loads = useAtomValue(view.loads);
  const items = useAtomValue(view.annotated);
  const report = useAtomSet(view.geometry);
  const drafts = useAtomValue(annotationsAtom(pane.sessionId));
  const repos = useAtomValue(changesAtom(pane.sessionId))?.repos;
  const open = useOpenEditor();
  const { ref: frame, width } = useWidth();
  const viewer = useRef<CodeViewHandle<AnnotationSlot, undefined>>(null);

  useAtomMount(view.driving);

  const byId = useMemo(() => new Map(files.map((file) => [file.id, file])), [files]);

  const measure = useCallback(() => {
    report(geometryOf(viewer.current?.getInstance(), files));
  }, [report, files]);

  const scrolled = useCallback(
    (scrollTop: number, instance: Viewer) => {
      report(geometryOf(instance, files, scrollTop));
    },
    [report, files],
  );

  // After each drawing: hold the scroll at the place asked for, then say where the files sit, for what to load next.
  useEffect(() => {
    if (anchor !== null) {
      viewer.current?.scrollTo(
        anchor.file === null
          ? { type: "position", position: 0 }
          : { type: "item", id: anchor.file, align: "start" },
      );
    }

    measure();
  }, [items, anchor, pool, measure]);

  // The owner's own scrolling lets the place go; the scrolls the Pane makes do not.
  const release = () => {
    if (anchor !== null) act({ type: "release" });
  };

  const toggle = useCallback(
    (id: string) => {
      act({ type: "fold", id, folded: !folded.has(id) });
    },
    [act, folded],
  );

  const options = useMemo(
    (): CodeViewReactOptions<AnnotationSlot, undefined> => ({
      theme: DIFF_THEME,
      diffStyle: diffStyleOf(layout, width ?? 0),
      overflow: wrap ? "wrap" : "scroll",
      lineDiffType: "word",
      stickyHeaders: true,
      ...DIFF_LIMITS,
      ...DRAFTING_OPTIONS,
      onGutterUtilityClick: (
        range: SelectedLineRange,
        context: { readonly item: CodeViewItem<AnnotationSlot> },
      ) => {
        if (context.item.type === "diff") open(context.item.id, context.item.fileDiff, range);
      },
    }),
    [layout, width, wrap, open],
  );

  // A file's drafts, and the editor of a new one, under their lines.
  const renderAnnotation = useCallback(
    (...[annotation, , item]: CodeViewAnnotationArgs<AnnotationSlot>) => {
      const file = byId.get(item.id);

      // The Pane's items are diffs: their annotations name a side.
      if (file === undefined || !("side" in annotation)) return null;

      const anchor = paneAnchor(file, repos ?? []);

      return (
        <AnnotationSlotView
          sessionId={pane.sessionId}
          anchor={anchor}
          drafts={drafts}
          annotation={annotation}
        />
      );
    },
    [byId, repos, drafts, pane.sessionId],
  );

  const renderHeader = useCallback(
    (item: { readonly id: string }) => {
      const file = byId.get(item.id);

      return file === undefined ? null : (
        <FileHeader
          file={file}
          contents={loads.loaded.get(item.id)?.contents}
          folded={folded.has(item.id)}
          onToggle={toggle}
        />
      );
    },
    [byId, loads, folded, toggle],
  );

  // The narrow Pane's file list, or nothing: the host stays, empty, when there is none.
  const renderTop = useCallback(() => header ?? null, [header]);

  return (
    <div
      ref={frame}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      onWheel={release}
      onTouchStart={release}
      onPointerDown={release}
      onKeyDown={release}
    >
      {pool !== undefined && (
        <WorkerPoolContext.Provider value={pool}>
          <CodeView
            ref={viewer}
            items={items}
            options={options}
            className="min-h-0 flex-1 overflow-auto overscroll-y-contain"
            renderCustomHeader={renderHeader}
            renderAnnotation={renderAnnotation}
            renderCodeViewHeader={renderTop}
            onScroll={scrolled}
          />
        </WorkerPoolContext.Provider>
      )}
    </div>
  );
};

/** The scroll's editor of drafts, which its items read too. */
const Drafting = ({ children }: { children: ReactNode }) => {
  const view = useAtomValue(ViewScope.use());

  return <AnnotationEditor.Context value={view.editor}>{children}</AnnotationEditor.Context>;
};

const ChangesView = (props: ChangesViewProps) => (
  <ViewScope.Provider value={props.pane}>
    <Drafting>
      <Scroll {...props} />
    </Drafting>
  </ViewScope.Provider>
);

export default ChangesView;
