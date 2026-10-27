// @effect-diagnostics preferEffectArray:off -- the Pane's files, over native arrays, sets and maps.

// The Diff pane (`docs/spec.md` → Diffs and review → Diff pane): one per Session page, on the Session's Changes, and one
// per Subagent page, on the Changes of the subagent's conversation's Workspace (ADR-0024); opened from the New pane, the
// Session details and a Call diff card. A header with the source picker (the Changes, and on the Session page This
// branch of each repo), Refresh, "may be out of date" (Changes) or what a Comparison is of (branch, base, merge-base,
// commits) and "New commits: Refresh" when its repo's HEAD moved with the Container stopped, the totals with "collapse
// all", Auto / Split / Stacked and Wrap; then every file of the source in one scroll (`changes-view.tsx`, a lazy
// chunk), with the file list as a rail beside it on a wide Pane and folding above it on a narrow one. Opening it asks
// the Session to list the Changes again. Its state is in atoms (`pane-atoms.ts`), kept while it is mounted.

import type { RepoChanges } from "@cloudpid/protocol";
import { useAtom, useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { ChevronRight, CircleAlert, RefreshCw, WrapText } from "lucide-react";
import { useShownChanges } from "../chat/conversation.ts";
import { Button } from "../components/ui/button.tsx";
import { lazyChunk } from "../lazy-chunk.ts";
import { LazyView } from "../lazy-view.tsx";
import { cn } from "../lib/utils.ts";
import { changesAtom } from "../session/atoms.ts";
import type { ChangesState } from "../session/state.ts";
import { useWidth } from "../use-width.ts";
import { filesLabel, groupedByRepo } from "./changes.ts";
import { DiffPaneScope, type PaneAtoms } from "./pane-atoms.ts";
import type { PaneFile } from "./pane-files.ts";
import { ChangedFileRow, DiffTally } from "./parts.tsx";
import { diffLayoutAtom, diffWrapAtom, type DiffLayout } from "./prefs.ts";
import {
  commitsLabel,
  comparisonHeading,
  errorText,
  sourceOfValue,
  sourceOptions,
  sourceValue,
} from "./branch.ts";

// The library, its highlighter and the workers are a chunk of their own, fetched when the Pane first opens.
const ChangesView = lazyChunk(() => import("./changes-view.tsx"));

/** From this Pane width, in px, the file list is a rail beside the diff; narrower, it folds above it. */
export const RAIL_MIN_WIDTH = 900;

const LAYOUTS: ReadonlyArray<{ readonly value: DiffLayout; readonly label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "split", label: "Split" },
  { value: "stacked", label: "Stacked" },
];

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

/** The picker: the Changes, and This branch of each repo; picking This branch compares it, starting the Container if needed. */
const SourcePicker = ({ pane }: { pane: PaneAtoms }) => {
  const [source, setSource] = useAtom(pane.source);
  const sources = useAtomValue(pane.sources);
  const compare = useAtomSet(pane.compare);
  const groups = sourceOptions(AsyncResult.getOrElse(sources, () => null));
  const value = sourceValue(source);

  // The shown source stays in the list while the repos are being listed.
  const listed = groups.some(({ options }) => options.some((option) => option.value === value))
    ? groups
    : [...groups, { label: null, options: [{ value, label: "This branch" }] }];

  return (
    <select
      aria-label="Source"
      value={value}
      onChange={(event) => {
        const next = sourceOfValue(event.target.value);

        setSource(next);

        // The owner's own pick: a stopped Container may be started for it.
        if (next.kind === "branch") compare({ repo: next.repo, manual: true, fetch: false });
      }}
      className="h-8 rounded-md border border-input bg-background px-2 text-sm"
    >
      {listed.map(({ label, options }) => {
        const items = options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ));

        return label === null ? (
          items
        ) : (
          <optgroup key={label} label={label}>
            {items}
          </optgroup>
        );
      })}
    </select>
  );
};

/** What a Comparison is of: its branch against its base at the merge-base, with its commits, and whether HEAD moved. */
const BranchSummary = ({ pane }: { pane: PaneAtoms }) => {
  const { comparison } = useAtomValue(pane.list);
  const changes = useAtomValue(changesAtom(pane.changes));
  const compare = useAtomSet(pane.compare);
  const setSource = useAtomSet(pane.source);

  if (comparison === undefined) return null;

  // This branch is the commits only: the repo's uncommitted files are the Changes'.
  const repoChanges = changes?.repos.find(({ repo }) => repo === comparison.repo);
  const uncommitted = (repoChanges?.files.length ?? 0) + (repoChanges?.more ?? 0);

  return (
    <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span className="font-mono" title={`Merge-base ${comparison.mergeBase}`}>
        {comparisonHeading(comparison)}
      </span>
      <span>{commitsLabel(comparison.commits)}</span>
      {uncommitted > 0 && (
        <span>
          {uncommitted} uncommitted {uncommitted === 1 ? "file" : "files"}:{" "}
          <button
            type="button"
            onClick={() => {
              setSource({ kind: "changes", repo: comparison.repo });
            }}
            className="touch-target rounded px-1 py-0.5 font-medium text-foreground underline hover:bg-accent"
          >
            see Changes
          </button>
        </span>
      )}
      {comparison.behind !== undefined && (
        <span role="status" className="flex items-center gap-1">
          <CircleAlert aria-hidden className="size-3.5" />
          New commits:
          <button
            type="button"
            onClick={() => {
              compare({ repo: comparison.repo, manual: true, fetch: false });
            }}
            className="touch-target rounded px-1 py-0.5 font-medium text-foreground underline hover:bg-accent"
          >
            Refresh
          </button>
        </span>
      )}
    </div>
  );
};

/** The Pane's header: the source, Refresh, "may be out of date", the totals with "collapse all", the layout, Wrap. */
const PaneHeader = ({ pane, changes }: { pane: PaneAtoms; changes: ChangesState | null }) => {
  const totals = useAtomValue(pane.totals);
  const source = useAtomValue(pane.source);
  const view = useAtomValue(pane.branchView);
  const [refreshed, refresh] = useAtom(pane.refresh);
  const [compared, compare] = useAtom(pane.compare);
  const files = useAtomValue(pane.files);
  const act = useAtomSet(pane.ui);
  const onBranch = source.kind === "branch";
  const refreshing = onBranch ? compared.waiting : refreshed.waiting;
  const starting = onBranch ? view.kind === "starting" : changes?.startingContainer === true;
  const stale = !onBranch && totals.stale;

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-3 py-2">
      <SourcePicker pane={pane} />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={refreshing}
        onClick={() => {
          if (source.kind === "branch") compare({ repo: source.repo, manual: true, fetch: true });
          else refresh();
        }}
        title={
          onBranch
            ? "Fetch the base branch and compare again, starting the Container if it is stopped"
            : "List the Changes again, starting the Container if a repo needs it"
        }
        className="touch-target h-8 gap-1.5 px-2 text-xs text-muted-foreground"
      >
        <RefreshCw
          aria-hidden
          className={cn("size-3.5", refreshing && "motion-safe:animate-spin")}
        />
        {starting ? "Starting the Container…" : "Refresh"}
      </Button>
      {stale && !starting && (
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
            <DiffTally counts={totals} approximate={totals.approximate} />
          </>
        )}
        {files.length > 0 && (
          <button
            type="button"
            onClick={() => {
              act({ type: "collapse-all", ids: files.map((file) => file.id) });
            }}
            className="touch-target rounded px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Collapse all
          </button>
        )}
      </span>
      <BranchSummary pane={pane} />
      <div className="flex w-full items-center justify-end gap-2">
        <LayoutPicker />
        <WrapToggle />
      </div>
    </div>
  );
};

let picks = 0;

/** The files, grouped by repo when there are several, each scrolling the diff to it. */
const FileList = ({ pane, repos }: { pane: PaneAtoms; repos: readonly RepoChanges[] }) => {
  const files = useAtomValue(pane.files);
  const act = useAtomSet(pane.ui);
  const grouped = groupedByRepo(repos);

  const pick = (file: PaneFile) => {
    picks += 1;
    act({ type: "show", target: { file: file.id, at: picks } });
  };

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
                  <ChangedFileRow
                    entry={file.entry}
                    path={file.entry.path}
                    onOpen={() => {
                      pick(file);
                    }}
                    className="px-3 py-1"
                  />
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

/** Why a subagent's Changes are listed no more. */
const ENDED = "The subagent is gone: its Changes are no longer listed.";

/** What the Pane says when it has no files to show: still listing, none, or that they could not be listed. */
const Empty = ({ changes }: { changes: ChangesState | null }) => {
  const listed = changes !== null && changes.listing > 0;
  const unlisted = changes?.repos.some((repo) => repo.error !== undefined) === true;

  if (!listed && changes?.ended === true) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{ENDED}</p>;
  }

  if (!listed && changes?.failure !== null && changes?.failure !== undefined) {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">The Changes could not be listed.</p>
    );
  }

  if (!listed)
    return <p className="px-4 py-6 text-sm text-muted-foreground">Listing the Changes…</p>;

  return (
    <p className="px-4 py-6 text-sm text-muted-foreground">
      {unlisted
        ? "No Changes in the repos that could be listed."
        : "No Changes: the working tree matches HEAD in every repo."}
    </p>
  );
};

/** The Retry an error state offers where it helps: the owner's own ask, so a stopped Container may start for it. */
const RetryButton = ({
  pane,
  repo,
  fetch,
  label,
}: {
  pane: PaneAtoms;
  repo: string;
  fetch: boolean;
  label: string;
}) => {
  const compare = useAtomSet(pane.compare);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => {
        compare({ repo, manual: true, fetch });
      }}
      className="touch-target mt-3 h-8 px-3 text-sm"
    >
      {label}
    </Button>
  );
};

/** What the Pane says in place of This branch's files: being made, why there is none, or that there is nothing in it. */
const BranchEmpty = ({ pane }: { pane: PaneAtoms }) => {
  const view = useAtomValue(pane.branchView);
  const { comparison } = useAtomValue(pane.list);

  switch (view.kind) {
    case "idle":
    case "loading":
      return <p className="px-4 py-6 text-sm text-muted-foreground">Comparing this branch…</p>;
    case "starting":
      return <p className="px-4 py-6 text-sm text-muted-foreground">Starting the Container…</p>;
    case "error":
      return (
        <div role="alert" className="px-4 py-6 text-sm text-muted-foreground">
          <p>{errorText(view.error)}</p>
          {view.error.kind === "needs_container" ? (
            <RetryButton
              pane={pane}
              repo={view.repo}
              fetch={false}
              label="Start the Container and compare"
            />
          ) : (
            <RetryButton pane={pane} repo={view.repo} fetch label="Retry" />
          )}
        </div>
      );
    case "failed":
      return (
        <div role="alert" className="px-4 py-6 text-sm text-destructive">
          <p>This branch could not be compared: {view.message}</p>
          <RetryButton pane={pane} repo={view.repo} fetch={false} label="Retry" />
        </div>
      );
    case "ready":
      return (
        <p className="px-4 py-6 text-sm text-muted-foreground">
          {comparison?.commits === 0
            ? "Nothing to compare: this branch has no commits beyond its base."
            : "The commits on this branch change no files."}
        </p>
      );
  }
};

/** The Pane, inside its atoms' scope. */
const PaneBody = () => {
  const pane = useAtomValue(DiffPaneScope.use());
  const changes = useAtomValue(changesAtom(pane.changes));
  const source = useAtomValue(pane.source);
  const files = useAtomValue(pane.files);
  const { repos } = useAtomValue(pane.list);
  const totals = useAtomValue(pane.totals);
  const { ref, width } = useWidth();

  useAtomMount(pane.opened);
  useAtomMount(pane.following);

  const wide = (width ?? 0) >= RAIL_MIN_WIDTH;

  const failures =
    source.kind === "branch"
      ? []
      : [
          ...(changes?.ended === true && changes.listing > 0 ? [ENDED] : []),
          ...(changes?.failure === null || changes?.failure === undefined ? [] : [changes.failure]),
          ...repos.flatMap((repo) =>
            repo.error === undefined ? [] : [`Could not list ${repo.repo}: ${repo.error}`],
          ),
        ];

  const list = <FileList pane={pane} repos={repos} />;

  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col">
      <PaneHeader pane={pane} changes={changes} />
      {failures.length > 0 && (
        <div role="alert" className="border-b px-3 py-1.5 text-xs text-destructive">
          {failures.map((failure) => (
            <p key={failure}>{failure}</p>
          ))}
        </div>
      )}
      {files.length === 0 ? (
        source.kind === "branch" ? (
          <BranchEmpty pane={pane} />
        ) : (
          <Empty changes={changes} />
        )
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
          <LazyView
            fallback={<p className="px-4 py-6 text-sm text-muted-foreground">Loading the diff…</p>}
          >
            <ChangesView
              pane={pane}
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
                      <DiffTally counts={totals} approximate={totals.approximate} />
                    </summary>
                    <div className="max-h-56 overflow-y-auto overscroll-y-contain">{list}</div>
                  </details>
                )
              }
            />
          </LazyView>
        </div>
      )}
    </div>
  );
};

/** The Diff pane of the page shown, on its Changes: the Session's, or the subagent's on a Subagent page. */
export const DiffPane = () => {
  const changes = useShownChanges();

  return (
    // A page's Pane is on one set of Changes for as long as it is mounted; another set is another Pane's.
    <DiffPaneScope.Provider
      key={`${changes.sessionId}/${changes.conversationId ?? "session"}`}
      value={changes}
    >
      <PaneBody />
    </DiffPaneScope.Provider>
  );
};
