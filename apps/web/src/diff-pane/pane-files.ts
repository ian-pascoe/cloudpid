// The files of the Diff pane, as it shows them (`docs/spec.md` → Diffs and review → Diff pane): each changed file with
// the names it shows (its repo in front when the files are grouped by repo), why it starts folded, and what of its change
// a new list must differ in to load it again.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over values, over native arrays.

import type { BranchSource, ChangeEntry, RepoChanges } from "@cloudpid/protocol";
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
  /**
   * What of its change a new list must differ in to load it again (`entrySignature`), with the pair of commits of a
   * Comparison: its contents are fixed by them.
   */
  readonly signature: string;
  /** The Comparison it is a file of, when the Pane shows This branch: where its drafts anchor and its contents are read. */
  readonly branch: BranchSource | undefined;
}

/** Whether a file has contents to show: binary and "Too large to show" files show their mark and counts only. */
export const hasContents = (file: PaneFile): boolean =>
  file.entry.binary !== true && file.entry.tooLarge !== true;

/** The files of `repos` as the Pane shows them; of a Comparison's repo, `branch` says which. */
export const paneFilesOf = (
  repos: readonly RepoChanges[],
  branch?: BranchSource,
): readonly PaneFile[] => {
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
      signature:
        branch === undefined
          ? entrySignature(entry)
          : `${entrySignature(entry)}@${branch.mergeBase}..${branch.head}`,
      branch,
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
