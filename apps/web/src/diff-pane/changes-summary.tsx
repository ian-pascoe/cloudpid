// The Changes outside the Diff pane (`docs/spec.md` → Diffs and review → Diff pane): the watch a Session's page (or a
// Subagent page, on the subagent's) keeps while it is open, and the section of the Session details, the only summary of
// them. The section shows only while there are Changes, and opens the Pane: the totals and "and n more" at the top,
// a file at that file.

import { useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import { CircleAlert, PanelRightOpen } from "lucide-react";
import { useShownChanges } from "../chat/conversation.ts";
import { changesAtom } from "../session/atoms.ts";
import type { ConversationKey } from "../session/conversation-key.ts";
import { changesPreview, filesLabel, groupedByRepo, repoTotals } from "./changes.ts";
import { ChangedFileRow, DiffTally } from "./parts.tsx";
import { openDiffPaneAtom } from "./target.ts";
import { changesOnReturnAtom, changesTotalsAtom } from "./watch.ts";

/** How many files the Session details list before "and n more". */
export const DETAILS_FILES = 10;

/**
 * Watch the Changes `key` names while the page is open, for the Session details, and ask for them again whenever the
 * owner comes back to the page (`page-return.ts`).
 */
export const useChangesWatch = (key: ConversationKey) => {
  useAtomMount(changesAtom(key));
  useAtomMount(changesOnReturnAtom(key));
};

/**
 * The Changes in the Session details, while there are some: the totals (by repo for a Session at the Workspace's
 * root) with "may be out of date", then the first files, each opening the Diff pane at it, and "and n more".
 */
export const ChangesSection = () => {
  const key = useShownChanges();
  const changes = useAtomValue(changesAtom(key));
  const open = useAtomSet(openDiffPaneAtom(key));
  const repos = changes?.repos ?? [];
  const totals = useAtomValue(changesTotalsAtom(key));

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
        className="-mx-1.5 mt-1 flex w-[calc(100%+0.75rem)] flex-wrap items-center gap-x-2 rounded px-1.5 py-1 text-left text-sm hover:bg-accent"
      >
        <span className="font-medium">{filesLabel(totals.files)}</span>
        <DiffTally counts={totals} approximate={totals.approximate} />
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
                    <DiffTally counts={own} approximate={own.approximate} />
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
              <ChangedFileRow
                entry={entry}
                path={path}
                onOpen={() => {
                  open(id);
                }}
                className="rounded px-1.5 py-1"
              />
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
