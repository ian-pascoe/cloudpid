// Last run (GLOSSARY.md → Run diff; `docs/architecture/diffs-and-review.md` → Run diff): the change the Session's latest
// writing Run made to the files of its Workspace's repos, from a copy of each repo's tree saved before the Run's first
// writing call to one saved at its end (the working tree while the Run is live). The Session tells every client where
// the Run stands (`last_run`), and answers `run_diff` and `run_file` as it does for the Changes and Comparisons. A Run
// diff's files are the entries Changes lists, with the same caps, and a file's two sides are a `ChangeFile`.
import * as Schema from "effect/Schema";
import { RepoChanges } from "./changes.ts";
import { ConversationId } from "./conversation-id.ts";

/** The most files a Run copy compares with HEAD before the repo is "not captured: too many changed files". */
export const MAX_RUN_COPY_FILES = 2_000;

/** The files a Run copy records by size and hash only: the biggest it reads to hash. */
export const MAX_RUN_HASHED_BYTES = 16 * 1024 * 1024;

/** What a Run's ID is made of: it names the Run in a hidden ref, so nothing else is accepted. */
export const RUN_ID = /^[a-z0-9]{6,32}$/;

/** Why a repo was not captured, so its Run diff is missing. */
export const RunNotCaptured = Schema.Literals([
  /** The repo is listed by the Container's git and the Container was stopped, which nothing starts for a copy. */
  "container_stopped",
  /** More than `MAX_RUN_COPY_FILES` files differ from HEAD. */
  "too_many_files",
  /** The copy failed for another reason. */
  "failed",
]);

export type RunNotCaptured = typeof RunNotCaptured.Type;

/** One repo of the Last run: the commits of its two copies, or why it has no diff. */
export const LastRunRepo = Schema.Struct({
  /** The repo's directory below `/workspace`. */
  repo: Schema.String,
  /** The commit of the copy taken before the Run's first writing call; null when none was taken. */
  start: Schema.NullOr(Schema.String),
  /** The commit of the copy taken at the Run's end; null while it is live, or when none was taken. */
  end: Schema.NullOr(Schema.String),
  /** Why the repo is not captured; absent when it is. */
  notCaptured: Schema.optionalKey(RunNotCaptured),
});

export type LastRunRepo = typeof LastRunRepo.Type;

/** The Session's latest writing Run, live or ended. */
export const LastRun = Schema.Struct({
  /** The Run's ID: what its Annotations anchor to. */
  run: Schema.String,
  /** The conversation whose Run it is (the active Session branch's): where its Annotations go. */
  conversationId: ConversationId,
  /** When the Session saw its first writing call: its final answer is not older. */
  startedAt: Schema.Finite,
  /** When it ended; null while it is live. */
  endedAt: Schema.NullOr(Schema.Finite),
  /** The ID of the model's tool call that made the Run's first write (a subagent's, when it wrote first). */
  firstCall: Schema.String,
  /**
   * The last entry of the conversation when the Run ended; null while it is live. The Run's final answer, which the Show
   * changes link sits under, is the last assistant message without a tool call that is no newer than this entry and not
   * older than `startedAt`.
   */
  until: Schema.NullOr(Schema.Int),
  repos: Schema.Array(LastRunRepo),
  /**
   * True once the Run ended and every repo was captured and changed no file: there is nothing to show (a Run that only
   * read files through `bash`). Absent otherwise.
   */
  empty: Schema.optionalKey(Schema.Boolean),
});

export type LastRun = typeof LastRun.Type;

/**
 * The Session's Last run, sent after `hello` on every connect (null when no Run has written) and to every client
 * whenever it changes: a Run starts writing, a repo's copy is taken, a Run ends.
 */
export const LastRunMessage = Schema.Struct({
  type: Schema.Literal("last_run"),
  lastRun: Schema.NullOr(LastRun),
});

/**
 * A Run diff: the start copy of each captured repo against its end copy, or, while the Run is live, against the working
 * tree. A repo that needs the Container's git while it is stopped keeps its last list, marked `stale`.
 */
export const RunDiff = Schema.Struct({
  /** The Run it is of. */
  run: Schema.String,
  /** The Run has not ended: the right side is the working tree, and a list is made again as the Changes are. */
  live: Schema.Boolean,
  /** The captured repos, in order of name; their `head` is the repo's HEAD now. */
  repos: Schema.Array(RepoChanges),
});

export type RunDiff = typeof RunDiff.Type;
