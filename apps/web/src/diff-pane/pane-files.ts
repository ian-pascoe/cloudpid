// The files of the Diff pane, as it shows them (`docs/spec.md` → Diffs and review → Diff pane): each changed file with
// the names it shows (its repo in front when the files are grouped by repo), why it starts folded, and what of its change
// a new list must differ in to load it again.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over values, over native arrays.

import type { ChangeEntry, RepoChanges } from "@cloudpid/protocol";
import { changedFiles, entrySignature, groupedByRepo } from "./changes.ts";
import type { FileNames } from "./file-diff.ts";
import { foldReason, type FoldReason } from "./folding.ts";

/** One file as the Pane shows it. */
export interface PaneFile {
  readonly id: string;
  readonly repo: string;
  readonly entry: ChangeEntry;
  /** Its path as shown: with its repo in front when the files are grouped by repo. */
  readonly names: FileNames;
  /** Why it starts folded, if it does. */
  readonly reason: FoldReason | undefined;
  /** What of its change a new list must differ in to load it again (`entrySignature`). */
  readonly signature: string;
}

/** Whether a file has contents to show: binary and "Too large to show" files show their mark and counts only. */
export const hasContents = (file: PaneFile): boolean =>
  file.entry.binary !== true && file.entry.tooLarge !== true;

/** The files of `repos` as the Pane shows them. */
export const paneFilesOf = (repos: readonly RepoChanges[]): readonly PaneFile[] => {
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
      signature: entrySignature(entry),
    };
  });
};

/** Which files are folded: those folded or opened by hand as the owner left them, the rest by the folding rules. */
export const foldedFiles = (
  files: readonly PaneFile[],
  overrides: ReadonlyMap<string, boolean>,
): ReadonlySet<string> =>
  new Set(
    files.flatMap((file) =>
      (overrides.get(file.id) ?? file.reason !== undefined) ? [file.id] : [],
    ),
  );
