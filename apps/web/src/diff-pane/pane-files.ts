// The files of the Diff pane, as it shows them (`docs/spec.md` → Diffs and review → Diff pane): each changed file with
// the names it shows (its repo in front when the files are grouped by repo), why it starts folded, and what of its change
// a new list must differ in to load it again.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over values, over native arrays.

import type {
  BranchSource,
  ChangeEntry,
  LastRun,
  PullSource,
  RepoChanges,
  RunSource,
  ViewedFile,
} from "@cloudpid/protocol";
import { runSourceOf } from "./branch.ts";
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
  /**
   * The Comparison it is a file of, when the Pane shows This branch or a pull request: where its drafts anchor and its
   * contents are read.
   */
  readonly branch: BranchSource | PullSource | undefined;
  /** The Last run's copy of its repo, when the Pane shows the Last run: where its drafts anchor and its contents are read. */
  readonly run: RunSource | undefined;
}

/**
 * Whether the file of a pull request has its Viewed box ticked: a box counts only while the head blob it was ticked at
 * is the file's now, so a file that changed since is not viewed whatever the Session still holds.
 */
export const isViewed = (file: PaneFile, viewed: readonly ViewedFile[]): boolean =>
  viewedIn(file, viewedIndex(viewed));

/** The head blob each box was ticked at, by (repo, pull request, path): a lookup, not a scan of every box per file. */
const viewedIndex = (viewed: readonly ViewedFile[]): ReadonlyMap<string, string> =>
  new Map(viewed.map((box) => [boxKey(box.repo, box.pull, box.path), box.blob]));

const boxKey = (repo: string, pull: number, path: string): string =>
  JSON.stringify([repo, pull, path]);

const viewedIn = (file: PaneFile, index: ReadonlyMap<string, string>): boolean => {
  const { branch, entry } = file;

  if (branch?.kind !== "pull" || entry.blob === undefined) return false;

  return index.get(boxKey(file.repo, branch.number, entry.path)) === entry.blob;
};

/** The IDs of the files of `files` whose Viewed box is ticked. */
export const viewedFileIds = (
  files: readonly PaneFile[],
  viewed: readonly ViewedFile[],
): ReadonlySet<string> => {
  const index = viewedIndex(viewed);

  return new Set(files.flatMap((file) => (viewedIn(file, index) ? [file.id] : [])));
};

/** Whether a file has contents to show: binary and "Too large to show" files show their mark and counts only. */
export const hasContents = (file: PaneFile): boolean =>
  file.entry.binary !== true && file.entry.tooLarge !== true;

/** The files of `repos` as the Pane shows them; of a Comparison's repo, `branch` says which; of the Last run, `run` does. */
export const paneFilesOf = (
  repos: readonly RepoChanges[],
  branch?: BranchSource | PullSource,
  run?: LastRun,
): readonly PaneFile[] => {
  const grouped = groupedByRepo(repos);

  return changedFiles(repos).map(({ id, repo, entry }) => {
    const shown = (path: string) => (grouped ? `${repo}/${path}` : path);
    const own = run === undefined ? undefined : runSourceOf(run, repo);

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
        branch !== undefined
          ? `${entrySignature(entry)}@${branch.mergeBase}..${branch.head}`
          : own !== undefined
            ? `${entrySignature(entry)}@run:${own.run}:${own.end ?? "live"}`
            : entrySignature(entry),
      branch,
      run: own,
    };
  });
};

/** Which files are folded: those folded or opened by hand as the owner left them, the rest by the folding rules. */
export const foldedFiles = (
  files: readonly PaneFile[],
  overrides: ReadonlyMap<string, boolean>,
  viewed: ReadonlySet<string> = new Set(),
): ReadonlySet<string> =>
  new Set(
    files.flatMap((file) =>
      (overrides.get(file.id) ?? (file.reason !== undefined || viewed.has(file.id)))
        ? [file.id]
        : [],
    ),
  );
