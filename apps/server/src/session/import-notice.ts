// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- plain functions over a few counts and names.
// The import notice (`docs/architecture/mcp-endpoint.md` → Session import → Translation → The import notice): one model-visible user message,
// always the last entry an import writes, that tells the agent where it is now and what did not come across.
import type { ImportRepo, ImportSummary } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Record from "effect/Record";

/** What the translation knows of where the import lands, besides the file: the Workspace, and what was decided about the model. */
export type ImportFacts = {
  readonly branch: string;
  readonly repos: ReadonlyArray<ImportRepo>;
  /** The model fallback, as warnings the notice repeats. */
  readonly warnings: ReadonlyArray<string>;
  /**
   * The names of the tools the Session's requests declare, to tell the laptop tools it lacks. Unknown (none given): the
   * notice does not list any, and says nothing of them.
   */
  readonly tools?: ReadonlyArray<string> | undefined;
  /**
   * Whether the Local agent carried its uncommitted Changes (`session_import_finish`'s `changes_carried`). Not given: the
   * notice says it is not told, and to look.
   */
  readonly changesCarried?: boolean | undefined;
};

/** How many laptop tools the notice names, before it says how many more there are. */
export const NOTICE_TOOL_LIMIT = 30;

/** How many kinds of dropped entries the notice names. */
const NOTICE_DROPPED_KINDS = 10;

/** What the notice says beyond the Workspace and the counts: what the file held that the notice reports on. */
export type NoticeDetails = {
  /** The laptop's working directory (the header's `cwd`). */
  readonly cwd: string | undefined;
  /** How many Tasks of the Todo List came across. */
  readonly tasks: number;
  /** How many Notes came across, and whether a Handoff did. */
  readonly notes: number;
  readonly handoff: boolean;
  /** The tools the history called that this Session does not declare, most called first; none when they are not known. */
  readonly lacking: ReadonlyArray<string>;
};

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? "" : "s"}`;

const carried = (details: NoticeDetails): string => {
  const todo =
    details.tasks === 0 ? "no Todo List" : `a Todo List of ${plural(details.tasks, "Task")}`;

  const notes =
    details.notes === 0 && !details.handoff
      ? "no Notes or Handoff"
      : Arr.join(
          [
            ...(details.notes === 0 ? [] : [plural(details.notes, "Note")]),
            ...(details.handoff ? ["the saved Handoff"] : []),
          ],
          " and ",
        );

  return `Carried over from the laptop's pi extensions: ${todo}, and ${notes}.`;
};

const counts = (summary: ImportSummary): string => {
  const droppedTotal = Arr.reduce(Object.values(summary.dropped), 0, (sum, count) => sum + count);

  const kinds = Arr.map(
    Arr.take(
      Arr.sort(
        Record.toEntries(summary.dropped),
        Order.mapInput(Order.flip(Order.Number), ([, count]: readonly [string, number]) => count),
      ),
      NOTICE_DROPPED_KINDS,
    ),
    ([kind, count]) => `${kind} ${String(count)}`,
  );

  const dropped =
    droppedTotal === 0
      ? "dropped none"
      : `dropped ${plural(droppedTotal, "entry")} that have no counterpart here (${Arr.join(kinds, ", ")}${Object.keys(summary.dropped).length > kinds.length ? ", …" : ""})`;

  return `The import ${summary.cut === 0 ? "cut none" : `cut ${plural(summary.cut, "entry")} that were too large to keep whole (the middle of their longest text, or an image)`}, ${dropped}, and ${summary.closed === 0 ? "closed none" : `closed ${plural(summary.closed, "tool call")} that had no result, with an error result`}.`;
};

const lackingTools = (names: ReadonlyArray<string>): ReadonlyArray<string> => {
  if (names.length === 0) return [];

  const shown = Arr.take(names, NOTICE_TOOL_LIMIT);
  const more = names.length - shown.length;

  return [
    `Tools this Session lacks, called in the history: ${Arr.join(shown, ", ")}${more > 0 ? ` and ${String(more)} more` : ""}. These ran on the laptop; you can't call them here.`,
  ];
};

/** What the notice says of the laptop's uncommitted Changes: what finish said, or that it did not and the agent should look. */
const changesSentence = (carriedChanges: boolean | undefined): string =>
  carriedChanges === undefined
    ? "Uncommitted Changes in the laptop's working tree are applied to the Repo of that directory only when the owner carried them, which this import is not told: run `git status` there before relying on either."
    : carriedChanges
      ? "The laptop's uncommitted Changes were carried: they are applied to the Repo of that directory in this Workspace, on top of the pushed branch."
      : "The laptop's working tree had no uncommitted Changes to carry, so the Repo of that directory is the pushed branch as it was.";

/**
 * The import notice: where the conversation continues, what came across and what did not, and how the owner gets work
 * back. Whether uncommitted Changes were carried is said when finish said it (`facts.changesCarried`); from a client
 * that does not, the agent is told to look.
 */
export const importNotice = (
  facts: ImportFacts,
  details: NoticeDetails,
  summary: ImportSummary,
): string => {
  const where =
    facts.repos.length === 0
      ? "a cloudpid Workspace"
      : `a cloudpid Workspace on branch \`${facts.branch}\` (${Arr.join(
          Arr.map(facts.repos, (repo) => `${repo.name} at ${repo.directory}`),
          ", ",
        )})`;

  return Arr.join(
    [
      `[cloudpid import] This conversation was imported from a pi Session on the owner's laptop${details.cwd === undefined ? "" : ` (working directory ${details.cwd})`}. It continues in ${where}; commands that ran on the laptop cannot be run here.`,
      changesSentence(facts.changesCarried),
      carried(details),
      ...facts.warnings,
      counts(summary),
      ...lackingTools(details.lacking),
      `The owner brings work back with \`git pull\` on \`${facts.branch}\`: commit and push your work there when you finish.`,
    ],
    " ",
  );
};
