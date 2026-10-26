// @effect-diagnostics preferEffectArray:off asyncFunction:off -- the Pane's files and their load states, over native
// arrays and maps; a file's load awaits the Session's answer and the line-up worker's from React callbacks.

// The Diff pane's files in one scroll (`docs/spec.md` → Diffs and review → Diff pane): one virtualized `CodeView` with
// sticky headers that fold, highlighting on the Worker Pool. A file's contents are asked for (`change_file`) only while
// it is unfolded and near the visible window, at most 4 at a time, and lined up in the line-up worker, past whose 2 s the
// file shows as a whole-file replacement, marked so. Binary and "Too large to show" files show their mark and counts
// only. A new list of the Changes makes each loaded file load again as it comes near, keeping what it shows until then.
//
// This module is the Pane's lazy chunk: the library, its highlighter and the workers load with it.
//
// The seam for Annotations (a later slice): `options` is where the gutter selection (`enableGutterUtility`,
// `enableLineSelection`) is switched on, and each item takes `annotations`, drawn by a `renderAnnotation` beside
// `renderCustomHeader`.

import type { ChangeEntry, ChangeFile } from "@cloudpid/protocol";
import type { CodeViewDiffItem, FileDiffMetadata } from "@pierre/diffs";
import {
  CodeView,
  WorkerPoolContext,
  type CodeViewHandle,
  type CodeViewReactOptions,
} from "@pierre/diffs/react";
import type { WorkerPoolManager } from "@pierre/diffs/worker";
import * as Exit from "effect/Exit";
import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DIFF_THEME } from "../diff-theme.ts";
import { cn } from "../lib/utils.ts";
import { exitFailure } from "../registry.ts";
import type { ChangeFileQuery } from "../session/atoms.ts";
import { useWidth } from "../use-width.ts";
import { fileDiffOf, placeholderDiff, type FileNames } from "./file-diff.ts";
import { FOLD_REASON_LABEL, type FoldReason } from "./folding.ts";
import { filesToLoad, type PlacedFile } from "./loading.ts";
import { ChangeTally, StatusLetter } from "./parts.tsx";
import { diffStyleOf, type DiffLayout } from "./prefs.ts";
import { DIFF_LIMITS, lineUpWorker, workerPool, type LineUpWorker } from "./workers.ts";

/** One file as the Pane shows it. */
export interface PaneFile {
  readonly id: string;
  readonly repo: string;
  readonly entry: ChangeEntry;
  /** Its path as shown: with its repo in front when the files are grouped by repo. */
  readonly names: FileNames;
  /** Why it starts folded, if it does. */
  readonly reason: FoldReason | undefined;
}

/** Where the Pane is asked to scroll to: a file, or the top for `null`. */
export interface ScrollTarget {
  readonly file: string | null;
  readonly at: number;
}

/** A file's contents, as far as they have come. */
type LoadState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly listing: number;
      readonly diff: FileDiffMetadata;
      readonly replaced: boolean;
      readonly oldText: string | null;
      readonly newText: string | null;
    }
  | {
      readonly kind: "same";
      readonly listing: number;
      readonly oldText: string | null;
      readonly newText: string | null;
    }
  | {
      readonly kind: "unavailable";
      readonly listing: number;
      readonly what: "binary" | "too_large";
    }
  | { readonly kind: "failed"; readonly listing: number; readonly message: string };

/** The text of a side, or why there is none to show. */
const sideText = (
  side: ChangeFile["old"],
): { readonly text: string | null } | { readonly unavailable: "binary" | "too_large" } =>
  side === null
    ? { text: null }
    : side.kind === "text"
      ? { text: side.text }
      : { unavailable: side.kind };

/** How far beyond the visible window files are loaded ahead: a screenful. */
const marginOf = (height: number): number => Math.max(height, 600);

/** The header of a file in the scroll, sticky while its lines pass: a fold toggle, its name, what it holds. */
const FileHeader = ({
  file,
  state,
  folded,
  onToggle,
}: {
  file: PaneFile;
  state: LoadState | undefined;
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
      <HeaderNote file={file} state={state} folded={folded} />
      <ChangeTally
        additions={entry.additions}
        deletions={entry.deletions}
        approximate={entry.approximate}
      />
    </div>
  );
};

/** What a file's header says beside its counts: why it is folded, or what its contents are. */
const HeaderNote = ({
  file,
  state,
  folded,
}: {
  file: PaneFile;
  state: LoadState | undefined;
  folded: boolean;
}) => {
  const note = (text: string, className?: string) => (
    <span
      className={cn("shrink-0 truncate text-xs whitespace-nowrap text-muted-foreground", className)}
    >
      {text}
    </span>
  );

  if (file.entry.binary === true) return note("Binary");

  if (file.entry.tooLarge === true) return note("Too large to show");

  if (folded) return file.reason === undefined ? null : note(FOLD_REASON_LABEL[file.reason]);

  switch (state?.kind) {
    case undefined:
    case "loading":
      return note("Loading…");
    case "ready":
      return state.replaced ? note("Replaced whole: lining it up took too long") : null;
    case "same":
      return note("No change in the text");
    case "unavailable":
      return note(state.what === "binary" ? "Binary" : "Too large to show");
    case "failed":
      return (
        <span title={state.message} className="min-w-0 shrink truncate text-xs text-destructive">
          Could not load: {state.message}
        </span>
      );
  }
};

/**
 * The Worker Pool and the line-up worker while the Pane is open; they are shut 30 s after it closes. The pool queues
 * what it is asked until its workers are set up.
 */
const useWorkers = (pool: boolean) => {
  const [workers, setWorkers] = useState<{
    readonly pool: WorkerPoolManager | undefined;
    readonly lineUp: LineUpWorker;
  }>();

  useEffect(() => {
    setWorkers({ pool: pool ? workerPool.acquire() : undefined, lineUp: lineUpWorker.acquire() });

    return () => {
      if (pool) workerPool.release();

      lineUpWorker.release();
    };
  }, [pool]);

  return workers;
};

export interface ChangesViewProps {
  readonly files: readonly PaneFile[];
  readonly folded: ReadonlySet<string>;
  readonly onToggleFold: (id: string) => void;
  readonly layout: DiffLayout;
  readonly wrap: boolean;
  /** Which list of the Changes the files are from: a file loaded from an earlier one loads again. */
  readonly listing: number;
  readonly load: (query: ChangeFileQuery) => Promise<Exit.Exit<ChangeFile, unknown>>;
  readonly target: ScrollTarget | null;
  readonly onTargetShown: () => void;
  /** Shown above the first file, in the scroll: the file list, on a narrow Pane. */
  readonly header?: ReactNode;
  /** Highlight on the Worker Pool (the default), or on the page as a Call diff does; for measuring the two. */
  readonly pool?: boolean;
}

const ChangesView = ({
  files,
  folded,
  onToggleFold,
  layout,
  wrap,
  listing,
  load,
  target,
  onTargetShown,
  header,
  pool = true,
}: ChangesViewProps) => {
  const workers = useWorkers(pool);
  const { ref: frame, width } = useWidth();
  const viewer = useRef<CodeViewHandle<undefined, undefined>>(null);
  const [loads, setLoads] = useState<ReadonlyMap<string, LoadState>>(new Map());
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
    };
  }, []);

  const byId = useMemo(() => new Map(files.map((file) => [file.id, file])), [files]);

  // The latest of what a load reads once it is done, so one that ends after a re-render schedules the next with it.
  const latest = useRef({ byId, folded, listing, loads, workers, load });

  latest.current = { byId, folded, listing, loads, workers, load };

  const setLoad = useCallback((id: string, state: LoadState) => {
    setLoads((before) => new Map(before).set(id, state));
  }, []);

  const loadFile = useCallback(
    async (file: PaneFile, lineUp: LineUpWorker) => {
      const asked = latest.current.listing;
      const before = latest.current.loads.get(file.id);
      const { entry } = file;

      inFlight.current.add(file.id);

      if (before === undefined) setLoad(file.id, { kind: "loading" });

      const query: ChangeFileQuery =
        entry.oldPath === undefined
          ? { repo: file.repo, path: entry.path }
          : { repo: file.repo, path: entry.path, oldPath: entry.oldPath };

      const exit = await latest.current.load(query);

      const state = await (async (): Promise<LoadState> => {
        const failure = exitFailure(exit);

        if (Exit.isFailure(exit)) {
          return { kind: "failed", listing: asked, message: failure ?? "It could not be read." };
        }

        const old = sideText(exit.value.old);
        const now = sideText(exit.value.new);

        if ("unavailable" in old)
          return { kind: "unavailable", listing: asked, what: old.unavailable };

        if ("unavailable" in now)
          return { kind: "unavailable", listing: asked, what: now.unavailable };

        // The same text as shown already: only its list moves on, so nothing is drawn again.
        if (
          (before?.kind === "ready" || before?.kind === "same") &&
          before.oldText === old.text &&
          before.newText === now.text
        ) {
          return { ...before, listing: asked };
        }

        const { patch, replaced } = await lineUp.lineUp({
          oldName: old.text === null ? null : (entry.oldPath ?? entry.path),
          newName: now.text === null ? null : entry.path,
          oldText: old.text,
          newText: now.text,
        });

        const diff = fileDiffOf({
          names: file.names,
          oldText: old.text,
          newText: now.text,
          patch,
          cacheKey: `${file.id}@${asked}`,
        });

        return diff === undefined
          ? { kind: "same", listing: asked, oldText: old.text, newText: now.text }
          : { kind: "ready", listing: asked, diff, replaced, oldText: old.text, newText: now.text };
      })().catch((cause: unknown): LoadState => ({
        kind: "failed",
        listing: asked,
        message: cause instanceof Error ? cause.message : String(cause),
      }));

      inFlight.current.delete(file.id);

      if (mounted.current) setLoad(file.id, state);
    },
    [setLoad],
  );

  /** Ask for the files near the window that need their contents, as far as the requests out leave room. */
  const schedule = useCallback(() => {
    const instance = viewer.current?.getInstance();

    const {
      byId: known,
      folded: shut,
      listing: current,
      loads: states,
      workers: started,
    } = latest.current;

    if (instance === undefined || started === undefined) return;

    const ids = [...known.keys()];
    const tops = ids.map((id) => instance.getTopForItem(id));
    const end = instance.getScrollHeight();
    const placed: PlacedFile[] = [];

    ids.forEach((id, index) => {
      const top = tops[index];

      if (top !== undefined) placed.push({ id, top, bottom: tops[index + 1] ?? end });
    });

    const top = instance.getScrollTop();
    const height = instance.getHeight();

    const wanted = (id: string): boolean => {
      const file = known.get(id);
      const state = states.get(id);

      return (
        file !== undefined &&
        !shut.has(id) &&
        file.entry.binary !== true &&
        file.entry.tooLarge !== true &&
        !inFlight.current.has(id) &&
        (state === undefined || (state.kind !== "loading" && state.listing < current))
      );
    };

    for (const id of filesToLoad({
      placed,
      view: { top, bottom: top + height },
      margin: marginOf(height),
      wanted,
      inFlight: inFlight.current.size,
    })) {
      const file = known.get(id);

      if (file !== undefined) void loadFile(file, started.lineUp);
    }
  }, [loadFile]);

  // The library's items, each kept (with its version) while nothing it draws changed.
  const kept = useRef(new Map<string, CodeViewDiffItem<undefined>>());
  const placeholders = useRef(new Map<string, { names: FileNames; diff: FileDiffMetadata }>());

  const items = useMemo(() => {
    const next = new Map<string, CodeViewDiffItem<undefined>>();

    const list = files.map((file) => {
      const state = loads.get(file.id);
      const ready = state?.kind === "ready" ? state.diff : undefined;
      const placeholder = placeholders.current.get(file.id);

      let fileDiff = ready;

      if (fileDiff === undefined) {
        if (placeholder !== undefined && placeholder.names === file.names) {
          fileDiff = placeholder.diff;
        } else {
          fileDiff = placeholderDiff(file.names);
          placeholders.current.set(file.id, { names: file.names, diff: fileDiff });
        }
      }

      // A file with no lines to draw stays header-only, whatever its fold says.
      const collapsed = folded.has(file.id) || ready === undefined;
      const before = kept.current.get(file.id);

      const item =
        before !== undefined && before.fileDiff === fileDiff && before.collapsed === collapsed
          ? before
          : {
              id: file.id,
              type: "diff" as const,
              fileDiff,
              collapsed,
              version: (before?.version ?? 0) + 1,
            };

      next.set(file.id, item);

      return item;
    });

    kept.current = next;

    return list;
  }, [files, loads, folded]);

  // What changed may have moved files into the window, or out of a fold: ask again.
  useEffect(() => {
    schedule();
  }, [items, listing, workers, schedule]);

  useEffect(() => {
    if (target === null || workers === undefined) return;

    const handle = viewer.current;

    if (handle === null) return;

    handle.scrollTo(
      target.file === null
        ? { type: "position", position: 0 }
        : { type: "item", id: target.file, align: "start" },
    );
    onTargetShown();
  }, [target, workers, onTargetShown]);

  const options = useMemo(
    (): CodeViewReactOptions<undefined, undefined> => ({
      theme: DIFF_THEME,
      diffStyle: diffStyleOf(layout, width ?? 0),
      overflow: wrap ? "wrap" : "scroll",
      lineDiffType: "word",
      stickyHeaders: true,
      ...DIFF_LIMITS,
    }),
    [layout, width, wrap],
  );

  const renderHeader = useCallback(
    (item: { readonly id: string }) => {
      const file = byId.get(item.id);

      return file === undefined ? null : (
        <FileHeader
          file={file}
          state={loads.get(item.id)}
          folded={folded.has(item.id)}
          onToggle={onToggleFold}
        />
      );
    },
    [byId, loads, folded, onToggleFold],
  );

  // The narrow Pane's file list, or nothing: the host stays, empty, when there is none.
  const renderTop = useCallback(() => header ?? null, [header]);

  return (
    <div ref={frame} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {workers !== undefined && (
        <WorkerPoolContext.Provider value={workers.pool}>
          <CodeView
            ref={viewer}
            items={items}
            options={options}
            disableWorkerPool={workers.pool === undefined}
            className="min-h-0 flex-1 overflow-auto overscroll-y-contain"
            renderCustomHeader={renderHeader}
            renderCodeViewHeader={renderTop}
            onScroll={() => {
              schedule();
            }}
          />
        </WorkerPoolContext.Provider>
      )}
    </div>
  );
};

export default ChangesView;
