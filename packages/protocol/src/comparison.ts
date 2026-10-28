// Comparisons (GLOSSARY.md → Comparison; `docs/architecture/diffs-and-review.md` → Comparisons): a branch's commits against the
// point where it left its base branch, as the Workspace DO lists them and the Session socket carries them
// (`comparison_sources`, `compare`, `comparison_file`). A Comparison is fixed once its merge-base and head SHAs are, so
// these are request commands, not a watch. Its files are the same entries Changes lists, with the same caps, and a
// file's two sides are a `ChangeFile`.
import * as Schema from "effect/Schema";
import { ChangeEntry, RepoHead } from "./changes.ts";

/** The longest branch name a Comparison names (the base of a pull request is GitHub's, so it can be long). */
export const MAX_COMPARISON_BRANCH = 256;

/** The source a Comparison is of: This branch, or one open pull request of the repo. */
export const ComparisonSourceKind = Schema.Literals(["branch", "pull"]);

export type ComparisonSourceKind = typeof ComparisonSourceKind.Type;

/** One open pull request of a repo, as the picker lists it (GitHub's REST API; `docs/architecture/diffs-and-review.md` → Comparisons). */
export const PullRequest = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  /** The author's login. */
  author: Schema.String,
  draft: Schema.Boolean,
  /** Lines added and deleted, and files changed; null when GitHub's answer for this pull request did not come. */
  additions: Schema.NullOr(Schema.Int),
  deletions: Schema.NullOr(Schema.Int),
  changedFiles: Schema.NullOr(Schema.Int),
  /** The head's commit (what the pull request is at now), the head's branch name and the base branch's name. */
  head: Schema.String,
  headRef: Schema.String,
  base: Schema.String,
  /** When it was last updated (an ISO 8601 time, as GitHub says it). */
  updatedAt: Schema.String,
  /** It is the pull request of the repo's current branch (pinned in the picker, marked "this branch"). */
  thisBranch: Schema.optionalKey(Schema.Boolean),
});

export type PullRequest = typeof PullRequest.Type;

/** The most open pull requests a repo's list holds. */
export const MAX_PULLS = 50;

/** Why a repo has no list of pull requests. */
export const PullListErrorKind = Schema.Literals([
  /** The repo's remote is not on GitHub: "Pull requests need a GitHub remote". */
  "no_github",
  /** GitHub refused the token: 401, 403, or 404 for a private repo. */
  "refused",
  /** Anything else: no network, GitHub's error, an answer that was not a list. */
  "failed",
]);

export type PullListErrorKind = typeof PullListErrorKind.Type;

/** A repo's open pull requests, most recently updated first, or why there are none listed. */
export const PullList = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ok"),
    pulls: Schema.Array(PullRequest),
    /** When the list was fetched from GitHub (it is kept for 60 s). */
    fetchedAt: Schema.Finite,
  }),
  Schema.Struct({
    status: Schema.Literal("error"),
    kind: PullListErrorKind,
    message: Schema.String,
  }),
]);

export type PullList = typeof PullList.Type;

/** One repo of the picker: where its HEAD stands, which is what This branch compares, and its pull requests. */
export const RepoSources = Schema.Struct({
  /** The repo's directory below `/workspace`. */
  repo: Schema.String,
  head: RepoHead,
  /** The open pull requests, only when the request asked for them (the picker opening). */
  pulls: Schema.optionalKey(PullList),
});

export type RepoSources = typeof RepoSources.Type;

/**
 * What the picker lists: the repos of the Session's Workspace the Session works in, its own repo first, each with its
 * HEAD (Changes, and This branch under the branch's name). Opening the picker never starts the Container.
 */
export const ComparisonSources = Schema.Struct({
  repos: Schema.Array(RepoSources),
});

export type ComparisonSources = typeof ComparisonSources.Type;

/** Why a Comparison could not be made. */
export const ComparisonErrorKind = Schema.Literals([
  /** It needs the Container, which is stopped, and the request may not start it. */
  "needs_container",
  /** The repo has no remote, and no base branch exists locally. */
  "no_remote",
  /** The base branch is not on the remote (or, without a remote, not here). */
  "no_base",
  /** The branch and the base share no commit. */
  "no_common_ancestor",
  /** The clone is shallow and the base is not reached: the merge-base is unknown. */
  "shallow",
  /** More changed files than a listing can carry. */
  "too_big",
  /** Anything else: the end of git's error output, redacted. */
  "failed",
  /** The repo's remote is not on GitHub, so it has no pull requests. */
  "no_github",
  /** GitHub refused the token (401, 403, or 404 for a private repo). */
  "github_refused",
  /** The pull request is closed, and there is no earlier result to show. */
  "pull_closed",
  /** The pull request is merged, and there is no earlier result to show. */
  "pull_merged",
]);

export type ComparisonErrorKind = typeof ComparisonErrorKind.Type;

export const ComparisonError = Schema.Struct({
  kind: ComparisonErrorKind,
  /** What to show: the end of git's output, redacted, for `failed`. */
  message: Schema.String,
  /** The base branch, when it was chosen before the failure. */
  base: Schema.optionalKey(Schema.String),
});

export type ComparisonError = typeof ComparisonError.Type;

/** Whether a pull request is open, or closed without merging, or merged. */
export const PullState = Schema.Literals(["open", "closed", "merged"]);

export type PullState = typeof PullState.Type;

/** The pull request a Comparison is of. */
export const ComparedPull = Schema.Struct({
  number: Schema.Int,
  title: Schema.String,
  author: Schema.String,
  draft: Schema.Boolean,
  /** Not `open`: the last result stays readable, marked. */
  state: PullState,
});

export type ComparedPull = typeof ComparedPull.Type;

/** A Comparison of a repo's branch or of one of its pull requests: the commits since it left its base. */
export const Comparison = Schema.Struct({
  repo: Schema.String,
  /** The base branch's name (`main`): the open pull request's base, else the remote's default branch. */
  base: Schema.String,
  /** The head's branch name; null when HEAD was detached. A pull request's is its head branch's name. */
  branch: Schema.NullOr(Schema.String),
  /** The pull request, when this is a pull request's Comparison. */
  pull: Schema.optionalKey(ComparedPull),
  /** The commit the branch left its base at, and the head being compared. */
  mergeBase: Schema.String,
  head: Schema.String,
  /** How many commits the head has beyond the merge-base. */
  commits: Schema.Int,
  files: Schema.Array(ChangeEntry),
  /** How many more changed files the cap left out ("and n more"). */
  more: Schema.Int,
  /**
   * The repo's HEAD has moved since this was made (a commit, a checkout), and the Container was stopped, so it was not
   * recomputed: the commit it moved to. The Pane offers "New commits: Refresh".
   */
  behind: Schema.optionalKey(Schema.String),
});

export type Comparison = typeof Comparison.Type;

/** The answer to `compare`: the Comparison, or why there is none. */
export const CompareResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ok"), comparison: Comparison }),
  Schema.Struct({ status: Schema.Literal("error"), error: ComparisonError }),
]);

export type CompareResult = typeof CompareResult.Type;

/** The most Viewed boxes a Session keeps. */
export const MAX_VIEWED = 5_000;

/**
 * A Viewed box ticked: file `path` of pull request `pull` in `repo`, recording the head blob it was ticked at. It counts
 * only while the file's head blob is that one: a push that changes the file unviews it.
 */
export const ViewedFile = Schema.Struct({
  repo: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  pull: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
  /** The file's head blob id (a deleted file's, its merge-base blob). */
  blob: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
});

export type ViewedFile = typeof ViewedFile.Type;

/** The first characters of a commit, as the Pane and the Review name it. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

/** A full object id of git (SHA-1, or SHA-256 in a repo that uses it): what a commit or blob id is checked against. */
export const OBJECT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
