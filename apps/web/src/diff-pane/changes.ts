// The Changes as the web app shows them (`docs/spec.md` → Diffs and review → Diff pane): one list of files across the
// repos, each under an ID the Diff pane scrolls to, the totals the chip, the Session details and the Pane's header
// show, and which changed file a Call diff's path is.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over values, called from React, over native arrays.
import type { ChangeEntry, RepoChanges } from "@cloudpid/protocol";

/** The Workspace's root: every repo is a directory right below it. */
const WORKSPACE_ROOT = "/workspace";

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

/** `path` without `./` segments or repeated slashes. */
const normalize = (path: string): string =>
  path
    .split("/")
    .filter((segment, index) => segment !== "." && (segment !== "" || index === 0))
    .join("/");

/**
 * The changed file a Call diff's path names, or undefined when it has no Changes. An absolute path is the file at that
 * place; a relative one (to the conversation's directory: a repo, or the Workspace's root) is the file whose path ends
 * with it, the shortest such when several repos have one.
 */
export const findChange = (
  repos: readonly RepoChanges[],
  path: string,
): ChangedFile | undefined => {
  const wanted = normalize(path);
  const absolute = wanted.startsWith("/");
  const ending = `/${wanted}`;
  let best: { readonly file: ChangedFile; readonly length: number } | undefined;

  for (const file of changedFiles(repos)) {
    const full = `${WORKSPACE_ROOT}/${file.id}`;
    const matches = absolute ? full === wanted : full.endsWith(ending);

    if (matches && (best === undefined || full.length < best.length)) {
      best = { file, length: full.length };
    }
  }

  return best?.file;
};
