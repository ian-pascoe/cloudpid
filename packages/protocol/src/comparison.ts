// Comparisons (GLOSSARY.md → Comparison; `docs/spec.md` → Diffs and review → Comparisons): a branch's commits against the
// point where it left its base branch, as the Workspace DO lists them and the Session socket carries them
// (`comparison_sources`, `compare`, `comparison_file`). A Comparison is fixed once its merge-base and head SHAs are, so
// these are request commands, not a watch. Its files are the same entries Changes lists, with the same caps, and a
// file's two sides are a `ChangeFile`.
import * as Schema from "effect/Schema";
import { ChangeEntry, RepoHead } from "./changes.ts";

/** The longest branch name a Comparison names (the base of a pull request is GitHub's, so it can be long). */
export const MAX_COMPARISON_BRANCH = 256;

/** The source a Comparison is of. `branch` is This branch; pull requests come with their own slice. */
export const ComparisonSourceKind = Schema.Literals(["branch"]);

export type ComparisonSourceKind = typeof ComparisonSourceKind.Type;

/** One repo of the picker: where its HEAD stands, which is what This branch compares. */
export const RepoSources = Schema.Struct({
  /** The repo's directory below `/workspace`. */
  repo: Schema.String,
  head: RepoHead,
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

/** A Comparison of a repo's branch: the commits since it left its base. */
export const Comparison = Schema.Struct({
  repo: Schema.String,
  /** The base branch's name (`main`): the open pull request's base, else the remote's default branch. */
  base: Schema.String,
  /** The head's branch name; null when HEAD was detached. */
  branch: Schema.NullOr(Schema.String),
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

/** The first characters of a commit, as the Pane and the Review name it. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

/**
 * How This branch is named: the branch, or "detached at `abc1234`" for a detached HEAD, null before the first commit.
 */
export const branchLabel = (head: RepoHead): string | null =>
  head.branch ?? (head.commit === null ? null : `detached at ${shortSha(head.commit)}`);
