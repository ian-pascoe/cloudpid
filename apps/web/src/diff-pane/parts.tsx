// Small pieces the Changes show with wherever they appear: the chip, the Session details, the Diff pane's file list and
// headers. A file's status as a letter, and `+a −d` with "≈" where the counts are whole-file numbers.

import type { ChangeEntry, ChangeStatus } from "@cloudpid/protocol";
import { cn } from "../lib/utils.ts";

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

/**
 * `+a −d`: the lines added in Run Green and deleted in Brick Red, "≈" before them when they are whole-file numbers. A
 * file whose counts are not known (binary, or a side too large to read) shows none.
 */
export const ChangeTally = ({
  additions,
  deletions,
  approximate = false,
  className,
}: {
  additions: number | null;
  deletions: number | null;
  approximate?: boolean | undefined;
  className?: string;
}) =>
  additions === null || deletions === null ? null : (
    <span
      className={cn("tabular shrink-0 font-mono text-xs whitespace-nowrap", className)}
      title={approximate ? "Whole-file counts: lining the file up took too long" : undefined}
    >
      {approximate && <span className="text-muted-foreground">≈</span>}
      <span className="text-success">+{additions}</span>{" "}
      <span className="text-destructive">−{deletions}</span>
    </span>
  );

/** A file's own `+a −d`, or what it is instead: "Binary", "Too large to show". */
export const EntryTally = ({ entry }: { entry: ChangeEntry }) => {
  if (entry.binary === true) {
    return <span className="shrink-0 text-xs text-muted-foreground">Binary</span>;
  }

  return (
    <>
      {entry.tooLarge === true && (
        <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
          Too large to show
        </span>
      )}
      <ChangeTally
        additions={entry.additions}
        deletions={entry.deletions}
        approximate={entry.approximate}
      />
    </>
  );
};

/** "1 file", "12 files". */
export const filesLabel = (files: number): string => `${files} file${files === 1 ? "" : "s"}`;
