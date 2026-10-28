// The Last run in the Diff pane and the transcript (`docs/architecture/diffs-and-review.md` → Run diff): what the Pane says of
// the Run and of the repos that have no copy, and where in the transcript "Show changes" sits. Pure.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over values, called from React.

import type {
  LastRun,
  LastRunRepo,
  RunDiff,
  RunNotCaptured,
  TranscriptMessage,
} from "@cloudpid/protocol";
import { type ChangesTotals, changesTotals } from "./changes.ts";

/** Why a repo has no Run diff, as the Pane says it. */
export const notCapturedText = (reason: RunNotCaptured): string => {
  switch (reason) {
    case "container_stopped":
      return "its files need the Container to be copied, and it was stopped";
    case "too_many_files":
      return "more files than a copy takes differed from HEAD";
    case "failed":
      return "the copy failed";
  }
};

/** The repos of `run` that have no Run diff, with why. */
export const uncapturedRepos = (
  run: LastRun,
): ReadonlyArray<{ readonly repo: string; readonly why: string }> =>
  run.repos.flatMap((each: LastRunRepo) =>
    each.notCaptured === undefined
      ? []
      : [{ repo: each.repo, why: notCapturedText(each.notCaptured) }],
  );

/** Where the Run stands: working now, or when it ended (the clock the browser shows, `at` given by the caller). */
export const runStateText = (run: LastRun, clock: (at: number) => string): string =>
  run.endedAt === null ? "Still working" : `Ended ${clock(run.endedAt)}`;

/**
 * The entry that is the final answer of `run`: the last assistant message with no tool call that is no newer than the
 * Run's last entry (`until`) and no older than the moment the Session saw its first writing call (`startedAt`), which
 * holds whichever agent wrote first (a subagent's call is not among the messages shown). Undefined while the Run is live,
 * when it changed no file (nothing to show), or when no such message is among those shown (an earlier Context Window
 * not loaded, an aborted Run that ended on a tool call).
 */
export const runAnswerId = (
  run: LastRun | null,
  messages: readonly TranscriptMessage[],
): number | undefined => {
  if (run === null || run.until === null || run.empty === true) return undefined;

  let answer: number | undefined;

  for (const message of messages) {
    const id = Number(message.id);

    if (!Number.isInteger(id)) continue;

    if (id > run.until) break;

    if (
      message.role === "assistant" &&
      message.timestamp >= run.startedAt &&
      !message.parts.some((part) => part.type === "tool-call")
    ) {
      answer = id;
    }
  }

  return answer;
};

/**
 * What "Show changes" sums up for Run `run`: the totals of its Run diff, as the Session details sum up the Changes. Null
 * when the answer is of another Run (a newer one took its place) or there is none, or when the diff is live: only an
 * ended Run has the link, and its diff never changes.
 */
export const runTotals = (run: string, diff: RunDiff | null): ChangesTotals | null =>
  diff === null || diff.run !== run || diff.live ? null : changesTotals(diff.repos);

/** A time of day as the Pane shows it: the hour and minute, in the browser's locale. */
export const clockText = (at: number): string =>
  new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" }).format(at);

/** The picker's entry for the Last run: "Last run · 14:05" (when it ended, or began while it works). */
export const runLabel = (run: LastRun): string =>
  `Last run · ${clockText(run.endedAt ?? run.startedAt)}`;
