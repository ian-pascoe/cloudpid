// The difference an Agent change made to a long value, a script or a `mise.toml` (`docs/architecture/agent-changes.md`):
// its lines with a `+` or `-`, and the runs of lines that stayed folded to a count. Shown on the call's card in the
// transcript and in the Settings page's Agent changes section.
import * as Arr from "effect/Array";
import type { DiffRow } from "./line-diff.ts";
import { cn } from "./lib/utils.ts";

const PREFIX = { added: "+ ", removed: "- ", same: "  " } as const;

export const ChangeDiff = ({ rows }: { rows: ReadonlyArray<DiffRow> }) => (
  <pre
    aria-label="Difference"
    className="max-h-72 overflow-auto rounded bg-muted py-1 font-mono text-xs break-all whitespace-pre-wrap"
  >
    {rows.length === 0 ? (
      <div className="px-2 text-muted-foreground italic">No lines</div>
    ) : (
      Arr.map(rows, (row, index) =>
        row.kind === "skipped" ? (
          <div key={index} className="px-2 text-muted-foreground italic">
            … {row.count} unchanged line{row.count === 1 ? "" : "s"}
          </div>
        ) : (
          <div
            key={index}
            className={cn(
              "px-2",
              row.kind === "added" && "bg-success/15 text-success",
              row.kind === "removed" && "bg-destructive/15 text-destructive",
            )}
          >
            {PREFIX[row.kind]}
            {row.text}
          </div>
        ),
      )
    )}
  </pre>
);
