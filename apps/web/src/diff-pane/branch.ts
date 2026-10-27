// This branch in the Diff pane (`docs/spec.md` → Diffs and review → Comparisons): which source the Pane shows, the
// Comparison as the list of one repo the Pane already draws, what each error state says, and the Comparison's heading.
// Pure.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over values, called from React.

import {
  type BranchSource,
  type Comparison,
  type ComparisonError,
  type ComparisonSources,
  type LastRun,
  MAX_PULL_TITLE,
  type PullRequest,
  type PullSource,
  type RepoChanges,
  type RunSource,
  shortSha,
} from "@cloudpid/protocol";
import { runLabel } from "./last-run.ts";

/**
 * What the Pane shows: the Changes of every repo (or of one `repo`), one repo's This branch, or the Last run. A Pane
 * opened from the Session details or the New pane starts on the Changes of every repo.
 */
export type PaneSource =
  | { readonly kind: "changes"; readonly repo?: string }
  | { readonly kind: "branch"; readonly repo: string }
  | { readonly kind: "pull"; readonly repo: string; readonly number: number }
  | { readonly kind: "run" };

export const CHANGES_SOURCE: PaneSource = { kind: "changes" };

/** The Last run: what the Session's latest writing Run changed, in every repo it copied. */
export const RUN_SOURCE: PaneSource = { kind: "run" };

/** The value of the picker's option for `source`. */
export const sourceValue = (source: PaneSource): string => {
  if (source.kind === "pull") return `pull:${source.repo}#${source.number}`;

  if (source.kind === "run") return "run";

  return source.kind === "changes"
    ? source.repo === undefined
      ? "changes"
      : `changes:${source.repo}`
    : `branch:${source.repo}`;
};

/** The source a picker value names: anything it does not know is the Changes of every repo. */
export const sourceOfValue = (value: string): PaneSource => {
  if (value === "run") return RUN_SOURCE;

  const colon = value.indexOf(":");
  const kind = value.slice(0, colon);
  const repo = value.slice(colon + 1);

  if (colon < 0 || repo === "") return CHANGES_SOURCE;

  if (kind === "branch") return { kind: "branch", repo };

  if (kind === "pull") {
    const hash = repo.lastIndexOf("#");
    const number = Number(repo.slice(hash + 1));

    return hash > 0 && Number.isInteger(number) && number >= 1
      ? { kind: "pull", repo: repo.slice(0, hash), number }
      : CHANGES_SOURCE;
  }

  return kind === "changes" ? { kind: "changes", repo } : CHANGES_SOURCE;
};

/** One option of the picker. */
export interface SourceOption {
  readonly value: string;
  readonly label: string;
  /** A line that says something (why there are no pull requests), not a source to pick. */
  readonly disabled?: boolean;
}

/** "#7 Fix the thing · dev · draft · 4 files · +12 −3 · abc1234": one pull request as the picker names it. */
export const pullLabel = (pull: PullRequest): string => {
  const files =
    pull.changedFiles === null
      ? ""
      : ` · ${pull.changedFiles} file${pull.changedFiles === 1 ? "" : "s"}`;

  const counts =
    pull.additions === null || pull.deletions === null
      ? ""
      : ` · +${pull.additions} −${pull.deletions}`;

  return `#${pull.number} ${pull.title} · ${pull.author}${pull.draft ? " · draft" : ""}${files}${counts} · ${shortSha(pull.head)}${pull.thisBranch === true ? " · this branch" : ""}`;
};

/** What the picker's filter box asks: the text typed, and the value of the source on show (always listed). */
export interface PullFilter {
  readonly text: string;
  readonly keep: string;
}

const NO_FILTER: PullFilter = { text: "", keep: "" };

/** Whether `pull` answers the text typed: its number (`#7` too), title, author or head branch, in any case. */
export const matchesPull = (pull: PullRequest, text: string): boolean => {
  const words = text
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word !== "");

  const haystack =
    `#${pull.number} ${pull.title} ${pull.author} ${pull.headRef}${pull.draft ? " draft" : ""}`.toLowerCase();

  return words.every((word) => haystack.includes(word));
};

/**
 * A repo's pull requests as picker options: the one of the checked-out branch first ("this branch"), then the list's own
 * order (most recently updated first); or one line saying why there are none ("Pull requests need a GitHub remote" for a
 * remote that is not GitHub's). A repo whose pull requests were not asked for lists nothing.
 */
export const pullOptions = (
  repo: string,
  pulls: NonNullable<ComparisonSources["repos"][number]["pulls"]> | undefined,
  filter: PullFilter = NO_FILTER,
): SourceOption[] => {
  if (pulls === undefined) return [];

  if (pulls.status === "error") {
    return [
      {
        value: `pulls-error:${repo}`,
        // That message already says what it is about.
        label: pulls.kind === "no_github" ? pulls.message : `Pull requests: ${pulls.message}`,
        disabled: true,
      },
    ];
  }

  // The checked-out branch's pull request stays first whatever is typed, and so does the one on show.
  const shown = (pull: PullRequest) =>
    sourceValue({ kind: "pull", repo, number: pull.number }) === filter.keep;

  const listed = pulls.pulls.filter(
    (pull) => pull.thisBranch === true || shown(pull) || matchesPull(pull, filter.text),
  );

  const options = [
    ...listed.filter((pull) => pull.thisBranch === true),
    ...listed.filter((pull) => pull.thisBranch !== true),
  ].map((pull) => ({
    value: sourceValue({ kind: "pull", repo, number: pull.number }),
    label: pullLabel(pull),
  }));

  if (pulls.pulls.length === 0) {
    return [{ value: `pulls-none:${repo}`, label: "No open pull requests", disabled: true }];
  }

  // Something typed that nothing answers (the pinned and shown ones are listed all the same): say so.
  if (!pulls.pulls.some((pull) => matchesPull(pull, filter.text))) {
    return [
      ...options,
      { value: `pulls-none:${repo}`, label: "No pull requests match", disabled: true },
    ];
  }

  return options;
};

/** What a key in the filter box does. */
export type FilterKeyAction = "pick-first" | "focus-list" | "clear" | "none";

/**
 * Enter picks the first pull request the text leaves, Down moves to the list, Escape clears the text (and does nothing
 * when there is none, so it still reaches whatever closes the Pane).
 */
export const filterKeyAction = (key: string, text: string): FilterKeyAction => {
  if (key === "Enter") return "pick-first";

  if (key === "ArrowDown") return "focus-list";

  return key === "Escape" && text !== "" ? "clear" : "none";
};

/** The first pull request the groups list that can be picked: the checked-out branch's before the others. */
export const firstPull = (groups: readonly SourceGroup[]): SourceOption | undefined =>
  groups
    .flatMap(({ options }) => options)
    .find((option) => option.value.startsWith("pull:") && option.disabled !== true);

/** Whether any repo has a pull request to filter. */
export const hasPulls = (sources: ComparisonSources | null): boolean =>
  sources?.repos.some(({ pulls }) => pulls?.status === "ok" && pulls.pulls.length > 0) === true;

/** The options of one repo, or of the whole Workspace (`label` null) when the picker has one repo. */
export interface SourceGroup {
  readonly label: string | null;
  readonly options: readonly SourceOption[];
}

/**
 * What the picker lists, grouped by repo (the Session's own first, as the Session sends them): each repo's Changes, then
 * its This branch under the branch's name (`feat`, `detached at abc1234`), for a repo that has a commit. With one repo
 * the options stand alone; with several, the Changes of every repo come first, and each repo has a group.
 */
export const sourceOptions = (
  sources: ComparisonSources | null,
  filter: PullFilter = NO_FILTER,
  lastRun: LastRun | null = null,
): readonly SourceGroup[] => {
  const repos = sources?.repos ?? [];
  // The Last run is one source for every repo it copied, listed once a Run has written, after the Changes.
  const last: SourceOption[] = lastRun === null ? [] : [{ value: "run", label: runLabel(lastRun) }];

  const own = (
    repo: string,
    head: (typeof repos)[number]["head"],
    pulls: (typeof repos)[number]["pulls"],
  ): SourceOption[] => [
    ...(repos.length > 1 ? [{ value: `changes:${repo}`, label: "Changes" }] : []),
    ...(head.commit === null
      ? []
      : [
          {
            value: sourceValue({ kind: "branch", repo }),
            label: `This branch (${head.branch ?? `detached at ${shortSha(head.commit)}`})`,
          },
        ]),
    ...pullOptions(repo, pulls, filter),
  ];

  if (repos.length <= 1) {
    return [
      {
        label: null,
        options: [
          { value: "changes", label: "Changes" },
          ...last,
          ...repos.flatMap(({ repo, head, pulls }) => own(repo, head, pulls)),
        ],
      },
    ];
  }

  return [
    { label: null, options: [{ value: "changes", label: "Changes (every repo)" }, ...last] },
    ...repos.map(({ repo, head, pulls }) => ({ label: repo, options: own(repo, head, pulls) })),
  ];
};

/** The Comparison as the one repo's list the Pane draws its files from (names plain: it is one repo's). */
export const comparisonRepos = (comparison: Comparison): readonly RepoChanges[] => [
  {
    repo: comparison.repo,
    head: { commit: comparison.head, branch: comparison.branch },
    files: comparison.files,
    more: comparison.more,
    stale: false,
  },
];

/** The source a draft on the Comparison is written against. */
export const branchSourceOf = (comparison: Comparison): BranchSource => ({
  kind: "branch",
  repo: comparison.repo,
  branch: comparison.branch,
  base: comparison.base,
  mergeBase: comparison.mergeBase,
  head: comparison.head,
});

/** The source a draft on a pull request's Comparison is written against. */
export const pullSourceOf = (comparison: Comparison): PullSource | undefined =>
  comparison.pull === undefined
    ? undefined
    : {
        kind: "pull",
        repo: comparison.repo,
        number: comparison.pull.number,
        title: comparison.pull.title.slice(0, MAX_PULL_TITLE),
        mergeBase: comparison.mergeBase,
        head: comparison.head,
      };

/** The source a draft on `repo`'s files of the Last run is written against; none when the repo has no start copy. */
export const runSourceOf = (run: LastRun, repo: string): RunSource | undefined => {
  const copied = run.repos.find((each) => each.repo === repo);

  return copied?.start == null
    ? undefined
    : {
        kind: "run",
        conversationId: run.conversationId,
        run: run.run,
        repo,
        start: copied.start,
        end: copied.end,
      };
};

/** "1 commit", "3 commits". */
export const commitsLabel = (commits: number): string =>
  `${commits} commit${commits === 1 ? "" : "s"}`;

/**
 * What the Pane names the Comparison by: `feat` against `main` at `abc1234`, the merge-base, with the commits since; a
 * detached HEAD has no branch to name.
 */
export const comparisonHeading = (comparison: Comparison): string =>
  comparison.pull !== undefined
    ? `#${comparison.pull.number} ${comparison.pull.title}: ${comparison.branch ?? shortSha(comparison.head)} against ${comparison.base} at ${shortSha(comparison.mergeBase)}`
    : `${comparison.branch === null ? `Detached at ${shortSha(comparison.head)}` : comparison.branch} against ${comparison.base} at ${shortSha(comparison.mergeBase)}`;

/** What the Pane says in place of the list when there is none: one sentence for each error state. */
export const errorText = (error: ComparisonError): string => {
  switch (error.kind) {
    case "needs_container":
      return "This comparison needs the Container, which is stopped.";
    case "no_remote":
      return "No remote: this repo has none, and no main, master, trunk or develop branch to compare with.";
    case "no_base":
      return error.base === undefined
        ? "The base branch could not be found on the remote."
        : `The base branch ${error.base} is not on the remote.`;
    case "no_common_ancestor":
      return error.base === undefined
        ? "No common ancestor with the base branch."
        : `No common ancestor with ${error.base}.`;
    case "shallow":
      return "Shallow clone: base unknown. This clone does not reach the base branch, so the point the branch left it at cannot be found.";
    case "too_big":
      return "This branch changes more files than a list can carry.";
    case "no_github":
      return "Pull requests need a GitHub remote.";
    case "github_refused":
      return "GitHub refused the token, so this pull request cannot be read.";
    case "pull_closed":
      return "This pull request is closed, and there is no earlier result of it to show.";
    case "pull_merged":
      return "This pull request is merged, and there is no earlier result of it to show.";
    case "failed":
      return error.message === ""
        ? "The comparison failed."
        : `The comparison failed: ${error.message}`;
  }
};
