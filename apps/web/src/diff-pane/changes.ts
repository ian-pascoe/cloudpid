// The Changes as the web app shows them (`docs/architecture/diffs-and-review.md` → Diff pane): one list of files across the
// repos, each under an ID the Diff pane scrolls to, the totals the Session details, the New pane and the Pane's
// header show, which changed file a Call diff's path is, and what of a file's change a new list must differ in to load it again.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over values, called from React, over native arrays.
import {
  WORKSPACE_ROOT,
  workspaceDirectory,
  type ChangeEntry,
  type RepoChanges,
} from "@cloudpid/protocol";

/** One changed file, with its repo and the ID the Diff pane knows it by. */
export interface ChangedFile {
  readonly id: string;
  readonly repo: string;
  readonly entry: ChangeEntry;
}

/** The ID of file `path` of `repo`: its path below the Workspace's root, unique as a repo is one directory. */
export const changeId = (repo: string, path: string): string => `${repo}/${path}`;

/** Every listed file, repo by repo in the list's order, each repo's by path. */
export const changedFiles = (repos: readonly RepoChanges[]): readonly ChangedFile[] =>
  repos.flatMap((repo) =>
    repo.files.map((entry) => ({ id: changeId(repo.repo, entry.path), repo: repo.repo, entry })),
  );

/** `n files +a −d`: how many files changed (those past the cap too), and the lines of those listed. */
export interface ChangesTotals {
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
  /** Some file's counts are whole-file numbers ("≈"). */
  readonly approximate: boolean;
  /** Some repo's list "may be out of date": it needs the Container, which is stopped. */
  readonly stale: boolean;
}

const NO_TOTALS: ChangesTotals = {
  files: 0,
  additions: 0,
  deletions: 0,
  approximate: false,
  stale: false,
};

const addRepo = (totals: ChangesTotals, repo: RepoChanges): ChangesTotals => {
  let { additions, deletions, approximate } = totals;

  for (const entry of repo.files) {
    additions += entry.additions ?? 0;
    deletions += entry.deletions ?? 0;
    approximate ||= entry.approximate === true;
  }

  return {
    files: totals.files + repo.files.length + repo.more,
    additions,
    deletions,
    approximate,
    stale: totals.stale || repo.stale,
  };
};

/** The totals of every repo together. */
export const changesTotals = (repos: readonly RepoChanges[]): ChangesTotals =>
  repos.reduce(addRepo, NO_TOTALS);

/** The totals of one repo. */
export const repoTotals = (repo: RepoChanges): ChangesTotals => addRepo(NO_TOTALS, repo);

/**
 * Whether files are shown under their repos: the list holds more than one, as it does for a Session at the Workspace's
 * root (a Session in one repo's clone lists that repo alone).
 */
export const groupedByRepo = (repos: readonly RepoChanges[]): boolean => repos.length > 1;

/** The first files of the Changes, and how many others there are. */
export interface ChangesPreview {
  readonly shown: readonly ChangedFile[];
  readonly more: number;
}

/** The first `max` files, and how many others there are ("and n more"), the cap's leftovers included. */
export const changesPreview = (repos: readonly RepoChanges[], max: number): ChangesPreview => {
  const files = changedFiles(repos);
  const shown = files.slice(0, max);

  return { shown, more: changesTotals(repos).files - shown.length };
};

/**
 * The directory the Session works in, as its list of the Changes tells: a Session in one repo's clone lists that repo,
 * one at the Workspace's root every repo (none, or several: a Workspace of one repo works in its clone).
 */
export const changesDirectory = (repos: readonly RepoChanges[]): string =>
  workspaceDirectory(repos.map((repo) => repo.repo));

/** `path` made absolute against `directory`, without `.` and `..` segments or repeated slashes. */
export const resolvePath = (directory: string, path: string): string => {
  const segments: string[] = [];

  for (const segment of `${path.startsWith("/") ? "" : directory}/${path}`.split("/")) {
    if (segment === "..") segments.pop();
    else if (segment !== "" && segment !== ".") segments.push(segment);
  }

  return `/${segments.join("/")}`;
};

/**
 * The changed file a Call diff's path names, or undefined when it has no Changes: the file at that place, a relative path
 * taken from the Session's directory (`changesDirectory`).
 */
export const findChange = (
  repos: readonly RepoChanges[],
  path: string,
): ChangedFile | undefined => {
  const wanted = resolvePath(changesDirectory(repos), path);

  return changedFiles(repos).find((file) => `${WORKSPACE_ROOT}/${file.id}` === wanted);
};

/**
 * What the list says of a file's change: when it is the same in a new list, the file's contents are taken to be the same
 * too, and a file loaded from the old list is asked for again only while it is in view.
 */
export const entrySignature = (entry: ChangeEntry): string =>
  JSON.stringify([
    entry.status,
    entry.oldPath ?? null,
    entry.additions,
    entry.deletions,
    entry.approximate === true,
    entry.binary === true,
    entry.tooLarge === true,
  ]);

/** "1 file", "12 files". */
export const filesLabel = (files: number): string => `${files} file${files === 1 ? "" : "s"}`;

/** `n files ≈+a −d`, as a status line or a label takes it. */
export const totalsText = (totals: ChangesTotals): string =>
  `${filesLabel(totals.files)} ${totals.approximate ? "≈" : ""}+${totals.additions} −${totals.deletions}`;
