// Changes (GLOSSARY.md → Diffs and review; `docs/spec.md` → Diffs and review → Changes): each Repo's working tree
// against its HEAD, as the Workspace DO lists it and the Session socket carries it (`watch_changes`, `change_file`).
import * as Schema from "effect/Schema";

/** The most files a Changes list holds, across its repos; the rest are counted ("and n more"). */
export const MAX_CHANGED_FILES = 2_000;

/** The most bytes a side of a changed file may have to be shown; a bigger one is "Too large to show". */
export const MAX_CHANGE_SIDE_BYTES = 1024 * 1024;

/** How far into a side a NUL makes the file binary, as git looks. */
export const BINARY_SNIFF_BYTES = 8_000;

/** How a file differs from HEAD. A rename is paired only when the backend can tell (see `ChangeEntry.oldPath`). */
export const ChangeStatus = Schema.Literals(["added", "modified", "deleted", "renamed"]);

export type ChangeStatus = typeof ChangeStatus.Type;

/** One changed file of a repo. */
export const ChangeEntry = Schema.Struct({
  /** The path in the repo, `/`-separated, of the working side (the HEAD side's for a deletion). */
  path: Schema.String,
  /** A rename's HEAD path. */
  oldPath: Schema.optionalKey(Schema.String),
  status: ChangeStatus,
  /** Lines added and deleted (`+a −d`); null when not known (a binary file, or a side too large to read). */
  additions: Schema.NullOr(Schema.Int),
  deletions: Schema.NullOr(Schema.Int),
  /** The counts are whole-file numbers (`+new lines −old lines`), "≈": lining up the file ran out of time. */
  approximate: Schema.optionalKey(Schema.Boolean),
  /** A NUL in the first 8,000 bytes of a side: listed as "Binary", with no contents. */
  binary: Schema.optionalKey(Schema.Boolean),
  /** A side over 1 MiB: listed as "Too large to show", with its counts when known. */
  tooLarge: Schema.optionalKey(Schema.Boolean),
  /**
   * The repo's root `.gitattributes` marks the path `linguist-generated` (true) or `linguist-generated=false` (false);
   * absent when it says nothing. The web app folds by it before the contents load.
   */
  generated: Schema.optionalKey(Schema.Boolean),
  /** As `generated`, for `linguist-vendored`. */
  vendored: Schema.optionalKey(Schema.Boolean),
  /**
   * A pull request's file: its head blob id (a deleted file's, its merge-base blob), which a Viewed box records so a push
   * that changes the file unviews it.
   */
  blob: Schema.optionalKey(Schema.String),
});

export type ChangeEntry = typeof ChangeEntry.Type;

/** A repo's HEAD: its commit (null before the first) and its branch (null when detached). */
export const RepoHead = Schema.Struct({
  commit: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
});

export type RepoHead = typeof RepoHead.Type;

/** One repo's Changes. */
export const RepoChanges = Schema.Struct({
  /** The repo's directory below `/workspace`. */
  repo: Schema.String,
  head: RepoHead,
  /** Its changed files, by path, within the list's cap. */
  files: Schema.Array(ChangeEntry),
  /** How many more changed files the cap left out ("and n more"). */
  more: Schema.Int,
  /**
   * "May be out of date": the repo needs the Container, which was stopped, so these are the files it listed last (none
   * if it never did). Only the owner's Refresh starts it.
   */
  stale: Schema.Boolean,
  /** Why the repo's Changes could not be listed, when they could not. */
  error: Schema.optionalKey(Schema.String),
});

export type RepoChanges = typeof RepoChanges.Type;

/** A Workspace's Changes: its repos, in order of name. */
export const WorkspaceChanges = Schema.Struct({
  repos: Schema.Array(RepoChanges),
});

export type WorkspaceChanges = typeof WorkspaceChanges.Type;

/** One side of a changed file. */
export const ChangeSide = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("binary") }),
  Schema.Struct({ kind: Schema.Literal("too_large"), bytes: Schema.Int }),
]);

export type ChangeSide = typeof ChangeSide.Type;

/** A changed file's two sides: HEAD's (`old`, null when added) and the working tree's (`new`, null when deleted). */
export const ChangeFile = Schema.Struct({
  old: Schema.NullOr(ChangeSide),
  new: Schema.NullOr(ChangeSide),
});

export type ChangeFile = typeof ChangeFile.Type;
