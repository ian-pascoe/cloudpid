// The chips of a Review (`docs/spec.md` → Diffs and review → Annotations and Reviews): in a composer, one per draft it
// will send, with a remove button; on a sent Review's message, one per Annotation it sent. Each opens on the quoted code
// (or, on a page, its crop and text) and the owner's text.
// @effect-diagnostics preferEffectArray:off -- the drafts are native arrays.

import {
  type Annotation,
  type AnnotationStatus,
  annotationPath,
  type DiffAnnotation,
  isPageAnnotation,
  type PageCrop,
  type PageSource,
  type ShownReviewAnnotation,
  rangeText,
} from "@cloudpid/protocol";
import { Globe, MessageSquareText, X } from "lucide-react";
import { Popover } from "../components/ui/popover.tsx";
import { cn } from "../lib/utils.ts";
import { chipLabel, pageTarget, statusLabel } from "./drafts.ts";

/** What a chip on a diff opens on: the file and lines, the quoted code as it was, and the owner's text. */
type DiffPeeked = Pick<DiffAnnotation, "side" | "start" | "end" | "more"> & {
  readonly kind: "diff";
  readonly status?: AnnotationStatus | undefined;
  readonly file: string;
  readonly quote: readonly string[];
  readonly text: string;
  /** Whether the lines are as of a call (a Call diff's), which never changes. */
  readonly ofCall: boolean;
};

/** What a chip on a page opens on: the page and element, the crop, the page's text there, and the owner's text. */
type PagePeeked = {
  readonly kind: "page";
  readonly source: PageSource;
  readonly quote: readonly string[];
  readonly more: number;
  readonly text: string;
  readonly crop?: PageCrop | undefined;
};

type Peeked = DiffPeeked | PagePeeked;

/** Quoted lines as they were when drawn, and how many more the quote leaves out: mono on Tinted Wash, scrolling. */
export const QuotedLines = ({ lines, more }: { lines: readonly string[]; more: number }) =>
  lines.length === 0 ? null : (
    <pre className="my-1.5 max-h-48 overflow-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs whitespace-pre">
      {lines.join("\n")}
      {more > 0 && `\n… ${more} more ${more === 1 ? "line" : "lines"}`}
    </pre>
  );

/** A page Annotation's crop: what it was on, as the Browser Pane showed it. */
export const CropImage = ({
  crop,
  className,
}: {
  crop: PageCrop;
  className?: string | undefined;
}) => (
  <img
    src={`data:${crop.mimeType};base64,${crop.data}`}
    alt="What the Annotation is on, as the Browser Pane showed it"
    className={cn("max-h-48 max-w-full self-start rounded-md border object-contain", className)}
  />
);

/** Where a page Annotation is: what it is on (`pageTarget`, its selector on hover) and the page. */
export const PagePlace = ({ source }: { source: Pick<PageSource, "element" | "url"> }) => (
  <p className="text-xs text-muted-foreground">
    <span className="font-mono break-all text-foreground" title={source.element?.selector}>
      {pageTarget(source)}
    </span>{" "}
    on <span className="font-mono break-all text-foreground">{source.url}</span>
  </p>
);

/**
 * A page Annotation as its chip and its pin open on it: where it is, its crop, the page's text there, and the owner's
 * text (none while it is being written).
 */
export const PageDetails = ({
  source,
  crop,
  quote,
  more,
  text,
  className,
}: {
  source: Pick<PageSource, "element" | "url">;
  crop?: PageCrop | undefined;
  quote: readonly string[];
  more: number;
  text?: string | undefined;
  /** The crop's classes: its height where the room is short. */
  className?: string;
}) => (
  <>
    <PagePlace source={source} />
    {crop !== undefined && <CropImage crop={crop} className={className} />}
    <QuotedLines lines={quote} more={more} />
    {text !== undefined && <p className="break-words whitespace-pre-wrap">{text}</p>}
  </>
);

/** The crop, the page's text and the owner's, as a chip on a page opens on them. */
const PagePeek = ({ peeked }: { peeked: PagePeeked }) => (
  <div className="flex w-[min(32rem,calc(100vw-2rem))] flex-col gap-2 p-2 text-sm">
    <PageDetails {...peeked} />
  </div>
);

/** The quoted code and the owner's text, as a chip opens on them. */
const Peek = ({ peeked }: { peeked: Peeked }) => {
  if (peeked.kind === "page") return <PagePeek peeked={peeked} />;

  const status = statusLabel(peeked);

  return (
    <div className="flex w-[min(32rem,calc(100vw-2rem))] flex-col gap-2 p-2 text-sm">
      <p className="text-xs text-muted-foreground">
        <span className="font-mono break-all text-foreground">{peeked.file}</span>,{" "}
        {rangeText(peeked)}
        {peeked.ofCall && ", as of that call"}
        {status !== undefined && <span className="font-medium text-foreground"> · {status}</span>}
      </p>
      <QuotedLines lines={peeked.quote} more={peeked.more} />
      <p className="break-words whitespace-pre-wrap">{peeked.text}</p>
    </div>
  );
};

const chip =
  "inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border bg-background px-2 font-mono text-xs text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring";

/** One chip: its file and range (or element and page), marked when outdated, opening on the quote and text. */
const Chip = ({ label, peeked }: { label: string; peeked: Peeked }) => {
  const status = peeked.kind === "diff" ? statusLabel(peeked) : undefined;
  const Icon = peeked.kind === "page" ? Globe : MessageSquareText;

  return (
    <Popover
      label={`Annotation on ${label}`}
      title={peeked.text}
      className={cn(chip, status !== undefined && "border-dashed text-muted-foreground")}
      trigger={
        <>
          <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{label}</span>
          {status !== undefined && <span className="shrink-0 font-sans">· {status}</span>}
        </>
      }
    >
      <Peek peeked={peeked} />
    </Popover>
  );
};

/** What a chip of `annotation` (a draft, or a sent Review's) opens on. */
const peekOf = (annotation: Annotation | ShownReviewAnnotation): Peeked => {
  if (isPageAnnotation(annotation)) {
    return {
      kind: "page",
      source: annotation.source,
      quote: annotation.quote,
      more: annotation.more,
      text: annotation.text,
      crop: annotation.crop,
    };
  }

  return {
    kind: "diff",
    side: annotation.side,
    start: annotation.start,
    end: annotation.end,
    more: annotation.more,
    status: annotation.status,
    file: "file" in annotation ? annotation.file : annotationPath(annotation),
    quote: annotation.quote,
    text: annotation.text,
    ofCall: annotation.source.kind === "call",
  };
};

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
        Sends as a Review with{" "}
        {drafts.length === 1 ? "1 Annotation" : `${drafts.length} Annotations`}; what you type is
        its summary
      </p>
      <ul aria-label="Annotations to send" className="mt-1.5 flex flex-wrap gap-1.5">
        {drafts.map((draft) => {
          const label = chipLabel(draft);

          return (
            <li key={draft.id} className="flex min-w-0 items-center">
              <Chip label={label} peeked={peekOf(draft)} />
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
  <ul
    aria-label="Annotations"
    className="mt-2 flex flex-wrap justify-end gap-1.5 whitespace-normal"
  >
    {annotations.map((annotation, index) => (
      <li key={index} className="min-w-0">
        <Chip label={chipLabel(annotation)} peeked={peekOf(annotation)} />
      </li>
    ))}
  </ul>
);
