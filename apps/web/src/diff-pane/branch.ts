// This branch in the Diff pane (`docs/spec.md` → Diffs and review → Comparisons): which source the Pane shows, the
// Comparison as the list of one repo the Pane already draws, what each error state says, and the Comparison's heading.
// Pure.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over values, called from React.

import {
  type BranchSource,
  type Comparison,
  type ComparisonError,
  type ComparisonSources,
  type RepoChanges,
  shortSha,
} from "@cloudpid/protocol";

/**
 * What the Pane shows: the Changes of every repo (or of one `repo`), or one repo's This branch. A Pane opened from the
 * Session details or the New pane starts on the Changes of every repo.
 */
export type PaneSource =
  | { readonly kind: "changes"; readonly repo?: string }
  | { readonly kind: "branch"; readonly repo: string };

export const CHANGES_SOURCE: PaneSource = { kind: "changes" };

/** The value of the picker's option for `source`. */
export const sourceValue = (source: PaneSource): string =>
  source.kind === "changes"
    ? source.repo === undefined
      ? "changes"
      : `changes:${source.repo}`
    : `branch:${source.repo}`;

/** The source a picker value names: anything it does not know is the Changes of every repo. */
export const sourceOfValue = (value: string): PaneSource => {
  const colon = value.indexOf(":");
  const kind = value.slice(0, colon);
  const repo = value.slice(colon + 1);

  if (colon < 0 || repo === "") return CHANGES_SOURCE;

  if (kind === "branch") return { kind: "branch", repo };

  return kind === "changes" ? { kind: "changes", repo } : CHANGES_SOURCE;
};

/** One option of the picker. */
export interface SourceOption {
  readonly value: string;
  readonly label: string;
}

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
export const sourceOptions = (sources: ComparisonSources | null): readonly SourceGroup[] => {
  const repos = sources?.repos ?? [];

  const own = (repo: string, head: (typeof repos)[number]["head"]): SourceOption[] => [
    ...(repos.length > 1 ? [{ value: `changes:${repo}`, label: "Changes" }] : []),
    ...(head.commit === null
      ? []
      : [
          {
            value: sourceValue({ kind: "branch", repo }),
            label: `This branch (${head.branch ?? `detached at ${shortSha(head.commit)}`})`,
          },
        ]),
  ];

  if (repos.length <= 1) {
    return [
      {
        label: null,
        options: [
          { value: "changes", label: "Changes" },
          ...repos.flatMap(({ repo, head }) => own(repo, head)),
        ],
      },
    ];
  }

  return [
    { label: null, options: [{ value: "changes", label: "Changes (every repo)" }] },
    ...repos.map(({ repo, head }) => ({ label: repo, options: own(repo, head) })),
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

/** "1 commit", "3 commits". */
export const commitsLabel = (commits: number): string =>
  `${commits} commit${commits === 1 ? "" : "s"}`;

/**
 * What the Pane names the Comparison by: `feat` against `main` at `abc1234`, the merge-base, with the commits since; a
 * detached HEAD has no branch to name.
 */
export const comparisonHeading = (comparison: Comparison): string =>
  `${comparison.branch === null ? `Detached at ${shortSha(comparison.head)}` : comparison.branch} against ${comparison.base} at ${shortSha(comparison.mergeBase)}`;

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
    case "failed":
      return error.message === ""
        ? "The comparison failed."
        : `The comparison failed: ${error.message}`;
  }
};
