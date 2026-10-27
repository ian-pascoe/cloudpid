// The chips of a Review (`docs/spec.md` → Diffs and review → Annotations and Reviews): in a composer, one per draft it
// will send, with a remove button; on a sent Review's message, one per Annotation it sent. Each opens on the quoted code
// and the owner's text.
// @effect-diagnostics preferEffectArray:off -- the drafts are native arrays.

import {
  type Annotation,
  type AnnotationStatus,
  annotationPath,
  type ShownReviewAnnotation,
  rangeText,
} from "@cloudpid/protocol";
import { MessageSquareText, X } from "lucide-react";
import { Popover } from "../components/ui/popover.tsx";
import { cn } from "../lib/utils.ts";
import { chipLabel, statusLabel } from "./drafts.ts";

/** What a chip opens on: the file and lines, the quoted code as it was, and the owner's text. */
type Peeked = Pick<Annotation, "side" | "start" | "end" | "more"> & {
  readonly status?: AnnotationStatus | undefined;
  readonly file: string;
  readonly quote: readonly string[];
  readonly text: string;
  /** Whether the lines are as of a call (a Call diff's), which never changes. */
  readonly ofCall: boolean;
};

/** The quoted code and the owner's text, as a chip opens on them. */
const Peek = ({ peeked }: { peeked: Peeked }) => {
  const status = statusLabel(peeked);

  return (
    <div className="flex w-[min(32rem,calc(100vw-2rem))] flex-col gap-2 p-2 text-sm">
      <p className="text-xs text-muted-foreground">
        <span className="font-mono break-all text-foreground">{peeked.file}</span>,{" "}
        {rangeText(peeked)}
        {peeked.ofCall && ", as of that call"}
        {status !== undefined && <span className="font-medium text-foreground"> · {status}</span>}
      </p>
      {peeked.quote.length > 0 && (
        <pre className="max-h-48 overflow-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs whitespace-pre">
          {peeked.quote.join("\n")}
          {peeked.more > 0 && `\n… ${peeked.more} more ${peeked.more === 1 ? "line" : "lines"}`}
        </pre>
      )}
      <p className="break-words whitespace-pre-wrap">{peeked.text}</p>
    </div>
  );
};

const chip =
  "inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-background px-2 font-mono text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring";

/** One chip: its file and range, marked when outdated, opening on the quote and text. */
const Chip = ({ label, peeked }: { label: string; peeked: Peeked }) => (
  <Popover
    label={`Annotation on ${label}`}
    title={peeked.text}
    className={cn(chip, peeked.status !== undefined && "border-dashed text-muted-foreground")}
    trigger={
      <>
        <MessageSquareText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{label}</span>
        {peeked.status !== undefined && (
          <span className="shrink-0 font-sans">· {statusLabel(peeked)}</span>
        )}
      </>
    }
  >
    <Peek peeked={peeked} />
  </Popover>
);

const peekOfDraft = (draft: Annotation): Peeked => ({
  side: draft.side,
  start: draft.start,
  end: draft.end,
  more: draft.more,
  status: draft.status,
  file: annotationPath(draft),
  quote: draft.quote,
  text: draft.text,
  ofCall: draft.source.kind === "call",
});

/**
 * The drafts a composer will send as its Review, as chips above its input: each opens on its quote and text, and its ×
 * deletes it (for every client). Edit a draft in its diff.
 */
export const DraftChips = ({
  drafts,
  onRemove,
}: {
  drafts: readonly Annotation[];
  onRemove: (id: string) => void;
}) =>
  drafts.length === 0 ? null : (
    <div className="px-3 pt-2.5">
      <p className="text-xs text-muted-foreground">
        Sends as a Review with {drafts.length === 1 ? "1 Annotation" : `${drafts.length} Annotations`}
        ; what you type is its summary
      </p>
      <ul aria-label="Annotations to send" className="mt-1.5 flex flex-wrap gap-1.5">
        {drafts.map((draft) => {
          const label = chipLabel(draft);

          return (
            <li key={draft.id} className="flex min-w-0 items-center">
              <Chip label={label} peeked={peekOfDraft(draft)} />
              <button
                type="button"
                aria-label={`Delete the Annotation on ${label}`}
                title="Delete this Annotation"
                onClick={() => {
                  onRemove(draft.id);
                }}
                className="touch-target ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );

/** A sent Review's Annotations, as chips under its summary: each opens on the code it quoted and the owner's text. */
export const ReviewChips = ({ annotations }: { annotations: readonly ShownReviewAnnotation[] }) => (
  <ul aria-label="Annotations" className="mt-2 flex flex-wrap justify-end gap-1.5 whitespace-normal">
    {annotations.map((annotation, index) => (
      <li key={index} className="min-w-0">
        <Chip
          label={chipLabel(annotation)}
          peeked={{ ...annotation, ofCall: annotation.source.kind === "call" }}
        />
      </li>
    ))}
  </ul>
);
