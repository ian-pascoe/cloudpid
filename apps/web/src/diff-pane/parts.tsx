// Small pieces diffs and the Changes show with wherever they appear: a Call diff's card, the chip, the Session details,
// the Diff pane's file list and headers. `+a −d` with "≈" where the counts are whole-file numbers, a file's status as a
// letter, and a changed file's row.

import type { ChangeEntry, ChangeStatus } from "@cloudpid/protocol";
import type { DiffCounts } from "../call-diff.ts";
import { cn } from "../lib/utils.ts";

/**
 * `+a −d`: the lines added in Run Green and the lines removed in Brick Red, "≈" before them when they are whole-file
 * numbers.
 */
export const DiffTally = ({
  counts,
  approximate = false,
}: {
  counts: DiffCounts;
  approximate?: boolean | undefined;
}) => (
  <span
    className="tabular shrink-0 font-mono text-xs whitespace-nowrap"
    title={approximate ? "Whole-file counts: lining the file up took too long" : undefined}
  >
    {approximate && <span className="text-muted-foreground">≈</span>}
    <span className="text-success">+{counts.additions}</span>{" "}
    <span className="text-destructive">−{counts.deletions}</span>
  </span>
);

const LETTER: Readonly<Record<ChangeStatus, string>> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

const STATUS_NAME: Readonly<Record<ChangeStatus, string>> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
};

const STATUS_COLOUR: Readonly<Record<ChangeStatus, string>> = {
  added: "text-success",
  modified: "text-muted-foreground",
  deleted: "text-destructive",
  renamed: "text-muted-foreground",
};

/** A file's status as git's letter: added in Run Green, deleted in Brick Red (a diff's colours), the rest muted. */
export const StatusLetter = ({ status }: { status: ChangeStatus }) => (
  <span
    title={STATUS_NAME[status]}
    aria-label={STATUS_NAME[status]}
    className={cn(
      "w-3 shrink-0 text-center font-mono text-xs font-semibold",
      STATUS_COLOUR[status],
    )}
  >
    {LETTER[status]}
  </span>
);

/** A file's own `+a −d`, or what it is instead: "Binary", "Too large to show"; none when its counts are not known. */
export const EntryTally = ({ entry }: { entry: ChangeEntry }) => {
  if (entry.binary === true) {
    return <span className="shrink-0 text-xs text-muted-foreground">Binary</span>;
  }

  const { additions, deletions } = entry;

  return (
    <>
      {entry.tooLarge === true && (
        <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
          Too large to show
        </span>
      )}
      {additions !== null && deletions !== null && (
        <DiffTally counts={{ additions, deletions }} approximate={entry.approximate} />
      )}
    </>
  );
};

/** A changed file in a list: its status, its path cut from the start so the name stays, and its counts; it opens it. */
export const ChangedFileRow = ({
  entry,
  path,
  onOpen,
  className,
}: {
  entry: ChangeEntry;
  /** The path as shown: with its repo in front when the files are grouped by repo. */
  path: string;
  onOpen: () => void;
  className?: string;
}) => (
  <button
    type="button"
    onClick={onOpen}
    title={`Open ${path}`}
    className={cn("flex w-full items-center gap-2 text-left hover:bg-accent", className)}
  >
    <StatusLetter status={entry.status} />
    <bdi className="min-w-0 flex-1 truncate font-mono text-xs [direction:rtl]">{path}</bdi>
    <EntryTally entry={entry} />
  </button>
);
