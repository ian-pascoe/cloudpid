// The Changes outside the Diff pane (`docs/spec.md` → Diffs and review → Diff pane): the watch the Session's page keeps
// while it is open, the chip in the Session's header and the section of the Session details. Each shows only while there
// are Changes, and each opens the Pane: the chip, the totals and "and n more" at the top, a file at that file.

import { useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import { CircleAlert, FileDiff, PanelRightOpen } from "lucide-react";
import { useEffect } from "react";
import { useCall } from "../calls.ts";
import { useShownSessionId } from "../chat/conversation.ts";
import { Button } from "../components/ui/button.tsx";
import { changesAtom, refreshChangesAtom } from "../session/atoms.ts";
import { changesPreview, changesTotals, groupedByRepo, repoTotals } from "./changes.ts";
import { ChangeTally, EntryTally, filesLabel, StatusLetter } from "./parts.tsx";
import { openDiffPaneAtom } from "./target.ts";

/** How many files the Session details list before "and n more". */
export const DETAILS_FILES = 10;

/**
 * Watch Session `sessionId`'s Changes while its page is open, for the chip, and ask for them again whenever the page
 * regains focus or comes back into view.
 */
export const useChangesWatch = (sessionId: string) => {
  useAtomMount(changesAtom(sessionId));

  const refresh = useCall(refreshChangesAtom(sessionId));

  useEffect(() => {
    const again = () => {
      if (document.visibilityState === "visible") void refresh(false);
    };

    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);

    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
    // `refresh` is a new function each render, calling the same atom.
  }, [sessionId]);
};

/** The Changes of the Session shown, as its page watches them. */
export const useShownChanges = () => useAtomValue(changesAtom(useShownSessionId()));

/** The header's Changes chip, `n files +a −d`, while there are Changes: it opens the Diff pane at the top. */
export const ChangesChip = () => {
  const sessionId = useShownSessionId();
  const changes = useAtomValue(changesAtom(sessionId));
  const open = useAtomSet(openDiffPaneAtom(sessionId));
  const totals = changesTotals(changes?.repos ?? []);

  if (totals.files === 0) return null;

  const label = `Open the Changes: ${filesLabel(totals.files)}, ${totals.approximate ? "about " : ""}${totals.additions} lines added and ${totals.deletions} deleted${totals.stale ? ", may be out of date" : ""}`;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={label}
      title={label}
      onClick={() => {
        open(null);
      }}
      className="h-8 gap-1.5 px-2 text-xs font-normal text-muted-foreground"
    >
      <FileDiff aria-hidden className="size-3.5" />
      <span className="hidden text-foreground sm:inline">{filesLabel(totals.files)}</span>
      <ChangeTally
        additions={totals.additions}
        deletions={totals.deletions}
        approximate={totals.approximate}
      />
    </Button>
  );
};

/**
 * The Changes in the Session details, while there are some: the totals (by repo for a Session at the Workspace's
 * root) with "may be out of date", then the first files, each opening the Diff pane at it, and "and n more".
 */
export const ChangesSection = () => {
  const sessionId = useShownSessionId();
  const changes = useAtomValue(changesAtom(sessionId));
  const open = useAtomSet(openDiffPaneAtom(sessionId));
  const repos = changes?.repos ?? [];
  const totals = changesTotals(repos);

  if (totals.files === 0) return null;

  const grouped = groupedByRepo(repos);
  const { shown, more } = changesPreview(repos, DETAILS_FILES);

  const atTop = () => {
    open(null);
  };

  return (
    <section aria-label="Changes">
      <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
        <h4>Changes</h4>
        <button
          type="button"
          onClick={atTop}
          className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
        >
          <PanelRightOpen aria-hidden />
          Open pane
        </button>
      </div>
      <button
        type="button"
        onClick={atTop}
        className="-mx-1.5 mt-1 flex w-[calc(100%+0.75rem)] flex-wrap items-center gap-x-2 rounded px-1.5 py-1 text-left text-[0.8125rem] hover:bg-accent"
      >
        <span className="font-medium">{filesLabel(totals.files)}</span>
        <ChangeTally
          additions={totals.additions}
          deletions={totals.deletions}
          approximate={totals.approximate}
        />
        {totals.stale && (
          <span
            className="flex items-center gap-1 text-xs text-muted-foreground [&_svg]:size-3"
            title="A repo needs the Container, which is stopped: this is its last list."
          >
            <CircleAlert aria-hidden />
            May be out of date
          </span>
        )}
      </button>
      {grouped && (
        <ul aria-label="By repo" className="mt-0.5 flex flex-col gap-0.5">
          {Arr.map(repos, (repo) => {
            const own = repoTotals(repo);

            return own.files === 0 && repo.error === undefined ? null : (
              <li key={repo.repo} className="flex items-center gap-2 px-0 text-xs">
                <span className="min-w-0 truncate font-mono text-muted-foreground">
                  {repo.repo}/
                </span>
                {repo.error === undefined ? (
                  <>
                    <span className="ml-auto shrink-0">{filesLabel(own.files)}</span>
                    <ChangeTally
                      additions={own.additions}
                      deletions={own.deletions}
                      approximate={own.approximate}
                    />
                  </>
                ) : (
                  <span className="ml-auto shrink-0 text-destructive" title={repo.error}>
                    Could not list
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ul className="-mx-1.5 mt-1">
        {Arr.map(shown, ({ id, repo, entry }) => {
          const path = grouped ? `${repo}/${entry.path}` : entry.path;

          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => {
                  open(id);
                }}
                title={`Open ${path}`}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-accent"
              >
                <StatusLetter status={entry.status} />
                <bdi className="min-w-0 flex-1 truncate font-mono text-xs [direction:rtl]">
                  {path}
                </bdi>
                <EntryTally entry={entry} />
              </button>
            </li>
          );
        })}
      </ul>
      {more > 0 && (
        <button
          type="button"
          onClick={atTop}
          className="-mx-1.5 mt-0.5 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          and {more} more
        </button>
      )}
    </section>
  );
};
