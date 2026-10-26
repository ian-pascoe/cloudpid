// @effect-diagnostics preferEffectArray:off -- the Pane's files, over native arrays, sets and maps.

// The Diff pane (`docs/spec.md` → Diffs and review → Diff pane): one per Session, opened from the New pane, the Changes
// chip, the Session details and a Call diff card. A header with the source picker (Changes only, for now), Refresh,
// "may be out of date", the totals with "collapse all", Auto / Split / Stacked and Wrap; then every file of the source
// in one scroll (`changes-view.tsx`, a lazy chunk), with the file list as a rail beside it on a wide Pane and folding
// above it on a narrow one. Opening it asks the Session to list the Changes again.

import type { RepoChanges } from "@cloudpid/protocol";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { ChevronRight, CircleAlert, RefreshCw, WrapText } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useCall } from "../calls.ts";
import { useShownSessionId } from "../chat/conversation.ts";
import { Button } from "../components/ui/button.tsx";
import { cn } from "../lib/utils.ts";
import { changeFileAtom, changesAtom, refreshChangesAtom } from "../session/atoms.ts";
import type { ChangesState } from "../session/state.ts";
import { useWidth } from "../use-width.ts";
import { changedFiles, changesTotals, groupedByRepo } from "./changes.ts";
import type { PaneFile, ScrollTarget } from "./changes-view.tsx";
import { foldReason } from "./folding.ts";
import { ChangeTally, EntryTally, filesLabel, StatusLetter } from "./parts.tsx";
import { diffLayoutAtom, diffWrapAtom, type DiffLayout } from "./prefs.ts";
import { diffTargetAtom } from "./target.ts";

// The library, its highlighter and the workers are a chunk of their own, fetched when the Pane first opens.
const ChangesView = lazy(() => import("./changes-view.tsx"));

/** From this Pane width, in px, the file list is a rail beside the diff; narrower, it folds above it. */
export const RAIL_MIN_WIDTH = 900;

const LAYOUTS: ReadonlyArray<{ readonly value: DiffLayout; readonly label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "split", label: "Split" },
  { value: "stacked", label: "Stacked" },
];

/** The files of `repos` as the Pane shows them: with their repo in front when grouped, and why each starts folded. */
const paneFilesOf = (repos: readonly RepoChanges[]): readonly PaneFile[] => {
  const grouped = groupedByRepo(repos);

  return changedFiles(repos).map(({ id, repo, entry }) => {
    const shown = (path: string) => (grouped ? `${repo}/${path}` : path);

    return {
      id,
      repo,
      entry,
      names: {
        name: shown(entry.path),
        prevName: entry.oldPath === undefined ? undefined : shown(entry.oldPath),
        status: entry.status,
      },
      reason: foldReason(entry),
    };
  });
};

/** Auto / Split / Stacked, as a group of radio buttons. */
const LayoutPicker = () => {
  const [layout, setLayout] = useAtom(diffLayoutAtom);

  return (
    <div role="radiogroup" aria-label="Layout" className="flex rounded-md border p-0.5">
      {LAYOUTS.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={layout === value}
          onClick={() => {
            setLayout(value);
          }}
          className={cn(
            "touch-target h-6 rounded px-2 text-xs",
            layout === value
              ? "bg-accent font-medium text-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
};

/** Wrap long lines, on by default. */
const WrapToggle = () => {
  const [wrap, setWrap] = useAtom(diffWrapAtom);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-pressed={wrap}
      title={wrap ? "Long lines wrap" : "Long lines scroll"}
      onClick={() => {
        setWrap(!wrap);
      }}
      className={cn(
        "touch-target h-7 gap-1 px-2 text-xs text-muted-foreground",
        wrap && "bg-accent text-accent-foreground",
      )}
    >
      <WrapText aria-hidden className="size-3.5" />
      Wrap
    </Button>
  );
};

/** The Pane's header: the source, Refresh, "may be out of date", the totals with "collapse all", the layout, Wrap. */
const PaneHeader = ({
  changes,
  refreshing,
  onRefresh,
  onCollapseAll,
}: {
  changes: ChangesState | null;
  refreshing: boolean;
  onRefresh: () => void;
  onCollapseAll: (() => void) | undefined;
}) => {
  const totals = changesTotals(changes?.repos ?? []);
  const starting = changes?.startingContainer === true;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-3 py-2">
      <select
        aria-label="Source"
        value="changes"
        onChange={() => undefined}
        className="h-8 rounded-md border border-input bg-background px-2 text-sm"
      >
        <option value="changes">Changes</option>
      </select>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={refreshing}
        onClick={onRefresh}
        title="List the Changes again, starting the Container if a repo needs it"
        className="touch-target h-8 gap-1.5 px-2 text-xs text-muted-foreground"
      >
        <RefreshCw
          aria-hidden
          className={cn("size-3.5", refreshing && "motion-safe:animate-spin")}
        />
        {starting ? "Starting the Container…" : "Refresh"}
      </Button>
      {totals.stale && !starting && (
        <span
          className="flex items-center gap-1 text-xs text-muted-foreground"
          title="These repos need the Container, which is stopped: this is their last list. Refresh to start it."
        >
          <CircleAlert aria-hidden className="size-3.5" />
          May be out of date
        </span>
      )}
      <span className="ml-auto flex items-center gap-2 text-xs">
        {totals.files > 0 && (
          <>
            <span className="font-medium">{filesLabel(totals.files)}</span>
            <ChangeTally
              additions={totals.additions}
              deletions={totals.deletions}
              approximate={totals.approximate}
            />
          </>
        )}
        {onCollapseAll !== undefined && (
          <button
            type="button"
            onClick={onCollapseAll}
            className="touch-target rounded px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Collapse all
          </button>
        )}
      </span>
      <div className="flex w-full items-center justify-end gap-2">
        <LayoutPicker />
        <WrapToggle />
      </div>
    </div>
  );
};

/** The files, grouped by repo when there are several, each scrolling the diff to it. */
const FileList = ({
  files,
  repos,
  onPick,
}: {
  files: readonly PaneFile[];
  repos: readonly RepoChanges[];
  onPick: (id: string) => void;
}) => {
  const grouped = groupedByRepo(repos);

  return (
    <div className="py-1">
      {repos.map((repo) => {
        const own = files.filter((file) => file.repo === repo.repo);

        return own.length === 0 && repo.more === 0 ? null : (
          <section key={repo.repo} aria-label={grouped ? repo.repo : "Files"}>
            {grouped && (
              <h4 className="px-3 pt-1.5 pb-0.5 font-mono text-xs text-muted-foreground">
                {repo.repo}/
              </h4>
            )}
            <ul>
              {own.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick(file.id);
                    }}
                    title={file.entry.path}
                    className="flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-accent"
                  >
                    <StatusLetter status={file.entry.status} />
                    <bdi className="min-w-0 flex-1 truncate font-mono text-xs [direction:rtl]">
                      {file.entry.path}
                    </bdi>
                    <EntryTally entry={file.entry} />
                  </button>
                </li>
              ))}
            </ul>
            {repo.more > 0 && (
              <p className="px-3 py-1 text-xs text-muted-foreground">
                and {repo.more} more not listed
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
};

/** What the Pane says when it has no files to show: still listing, or none. */
const Empty = ({ changes }: { changes: ChangesState | null }) => (
  <p className="px-4 py-6 text-sm text-muted-foreground">
    {changes === null
      ? "Listing the Changes…"
      : "No Changes: the working tree matches HEAD in every repo."}
  </p>
);

/** The Diff pane of the Session shown, on its Changes. */
export const DiffPane = () => {
  const sessionId = useShownSessionId();
  const changes = useAtomValue(changesAtom(sessionId));
  const refresh = useCall(refreshChangesAtom(sessionId));
  const load = useCall(changeFileAtom(sessionId));
  const [layout] = useAtom(diffLayoutAtom);
  const [wrap] = useAtom(diffWrapAtom);
  const [asked, setAsked] = useAtom(diffTargetAtom(sessionId));
  const [target, setTarget] = useState<ScrollTarget | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const { ref: pane, width } = useWidth();

  const repos = changes?.repos ?? [];
  const files = useMemo(() => paneFilesOf(repos), [repos]);
  const wide = (width ?? 0) >= RAIL_MIN_WIDTH;

  // Opening the Pane lists the Changes again (never starting the Container).
  useEffect(() => {
    void refresh(false);
    // Once, as the Pane opens: `refresh` is a new function each render, calling the same atom.
  }, []);

  // Asked to show a file (the chip, the Session details, a Call diff): open it if folded, scroll to it, and clear the ask.
  useEffect(() => {
    if (asked === null) return;

    if (asked.file !== null) {
      const id = asked.file;

      setOverrides((before) => new Map(before).set(id, false));
    }

    setTarget(asked);
    setAsked(null);
  }, [asked, setAsked]);

  // Folded or opened by hand stays so while the Pane is mounted; the rest follows the folding rules.
  const folded = useMemo(
    () =>
      new Set(
        files
          .filter((file) => overrides.get(file.id) ?? file.reason !== undefined)
          .map((file) => file.id),
      ),
    [files, overrides],
  );

  const toggle = useCallback(
    (id: string) => {
      setOverrides((before) => new Map(before).set(id, !folded.has(id)));
    },
    [folded],
  );

  const collapseAll = () => {
    setOverrides(new Map(files.map((file) => [file.id, true])));
  };

  const pick = (id: string) => {
    setTarget({ file: id, at: performance.now() });
  };

  const shown = useCallback(() => {
    setTarget(null);
  }, []);

  const failures = [
    ...(changes?.failure === null || changes?.failure === undefined ? [] : [changes.failure]),
    ...repos.flatMap((repo) =>
      repo.error === undefined ? [] : [`Could not list ${repo.repo}: ${repo.error}`],
    ),
  ];

  const list = <FileList files={files} repos={repos} onPick={pick} />;
  const totals = changesTotals(repos);

  return (
    <div ref={pane} className="flex min-h-0 flex-1 flex-col">
      <PaneHeader
        changes={changes}
        refreshing={refreshing}
        onRefresh={() => {
          setRefreshing(true);
          void refresh(true).finally(() => {
            setRefreshing(false);
          });
        }}
        onCollapseAll={files.length > 0 ? collapseAll : undefined}
      />
      {failures.length > 0 && (
        <div role="alert" className="border-b px-3 py-1.5 text-xs text-destructive">
          {failures.map((failure) => (
            <p key={failure}>{failure}</p>
          ))}
        </div>
      )}
      {files.length === 0 ? (
        <Empty changes={changes} />
      ) : (
        <div className="flex min-h-0 flex-1">
          {wide && (
            <nav
              aria-label="Changed files"
              className="w-64 shrink-0 overflow-y-auto overscroll-y-contain border-r"
            >
              {list}
            </nav>
          )}
          <Suspense
            fallback={<p className="px-4 py-6 text-sm text-muted-foreground">Loading the diff…</p>}
          >
            <ChangesView
              files={files}
              folded={folded}
              onToggleFold={toggle}
              layout={layout}
              wrap={wrap}
              listing={changes?.listing ?? 0}
              load={load}
              target={target}
              onTargetShown={shown}
              header={
                wide ? undefined : (
                  <details open className="group border-b">
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-muted-foreground select-none [&::-webkit-details-marker]:hidden">
                      <ChevronRight
                        aria-hidden
                        className="size-3.5 transition-transform group-open:rotate-90 motion-reduce:transition-none"
                      />
                      <span className="font-medium text-foreground">
                        {filesLabel(totals.files)}
                      </span>
                      <ChangeTally
                        additions={totals.additions}
                        deletions={totals.deletions}
                        approximate={totals.approximate}
                      />
                    </summary>
                    <div className="max-h-56 overflow-y-auto overscroll-y-contain">{list}</div>
                  </details>
                )
              }
            />
          </Suspense>
        </div>
      )}
    </div>
  );
};
