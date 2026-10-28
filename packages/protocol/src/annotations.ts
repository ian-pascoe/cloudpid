// Annotations (GLOSSARY.md → Annotation; `docs/architecture/diffs-and-review.md` → Annotations and Reviews): the owner's
// drafts on a line range of one side of a diff, or on an element or area of a page in the Browser Pane, kept by the
// Session DO and synced to every client, until they are sent together as a Review. Each is anchored to its source: a
// Call diff (the call, as recorded, which never changes), the Changes (the repo and the HEAD it was written against,
// checked again as the files change), a Comparison, or a page (its URL, the element's selector or the area, the box and
// the viewport it was drawn in, found again by the Pane alone).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over an Annotation's fields.
import * as Schema from "effect/Schema";
import {
  boundedText,
  cleanLine,
  cleanText,
  escapePageText,
  MAX_PAGE_ID,
  oneLine,
} from "./attached-pages.ts";
import { MAX_COMPARISON_BRANCH } from "./comparison.ts";
import { ConversationId } from "./conversation-id.ts";
import { MAX_PAGE_URL, withoutFragment } from "./live-view.ts";
import { WORKSPACE_ROOT } from "./repo.ts";

/** The most drafts a Session keeps. */
export const MAX_ANNOTATIONS = 100;

/** The most characters (UTF-16 code units, as the browser counts them) of the owner's text on one Annotation. */
export const MAX_ANNOTATION_TEXT = 4_000;

/** The most lines an Annotation quotes; the rest of its range is "… n more lines". */
export const MAX_QUOTE_LINES = 50;

/** The most UTF-8 bytes of the lines an Annotation quotes, a newline after each. */
export const MAX_QUOTE_BYTES = 8 * 1024;

/** The longest ID a client may give an Annotation (it makes them, so the card shows at once). */
export const MAX_ANNOTATION_ID = 64;

/** The longest pull request title an Annotation's source keeps (GitHub's own limit is 256). */
export const MAX_PULL_TITLE = 512;

/** The longest path an Annotation names. */
export const MAX_ANNOTATION_PATH = 4_096;

/**
 * The longest CSS selector a page Annotation finds its element by, in UTF-16 code units (and in UTF-8 bytes as the Review
 * writes it, escaped): with the URL and the quote at their limits, 100 page drafts still fit one Review.
 */
export const MAX_ANNOTATION_SELECTOR = 256;

/** The longest tag name a page Annotation keeps of its element. */
export const MAX_ANNOTATION_TAG = 64;

/**
 * The most base64 characters of a page Annotation's crop (about 9 KB of JPEG): 100 drafts' crops come to 1.2 MB, within
 * the `INLINE_IMAGE_BUDGET` one message's images share, and a Review fits them into what its message leaves.
 */
export const MAX_ANNOTATION_CROP = 12_000;

/**
 * The most crops one Review carries to the model: the providers take only so many images in a request (and hold each of
 * them to less past 20), beside the message's other images and the screenshots before it.
 */
export const MAX_REVIEW_CROPS = 20;

/** Which side of the diff an Annotation's lines are on: the old file's (removed lines) or the new file's. */
export const AnnotationSide = Schema.Literals(["old", "new"]);

export type AnnotationSide = typeof AnnotationSide.Type;

/**
 * An Annotation on a Call diff: the call it was drawn from, which never changes, so its drafts are never checked again.
 * `nested` is the call's number in a `codemode` script (`details.diffs`' key), for a call the script made.
 */
export const CallDiffSource = Schema.Struct({
  kind: Schema.Literal("call"),
  /** The conversation whose call it is. */
  conversationId: ConversationId,
  /** The tool call's ID: the `edit` or `write` itself, or the `codemode` call that made it. */
  callId: Schema.String.check(Schema.isMaxLength(256)),
  nested: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
  /** The tool that wrote the file: `edit` or `write`. */
  tool: Schema.String.check(Schema.isMaxLength(64)),
});

export type CallDiffSource = typeof CallDiffSource.Type;

/** An Annotation on the Changes: the repo (its directory below `/workspace`) and the HEAD it was written against. */
export const ChangesSource = Schema.Struct({
  kind: Schema.Literal("changes"),
  repo: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  /** The HEAD commit, null before the repo's first. */
  head: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
});

export type ChangesSource = typeof ChangesSource.Type;

/**
 * An Annotation on a repo's This branch Comparison: the repo, the branch's name (null when HEAD was detached), the base
 * it was compared with, and the merge-base and head SHAs it was written against. A new head moves the drafts that still
 * hold to the new pair.
 */
export const BranchSource = Schema.Struct({
  kind: Schema.Literal("branch"),
  repo: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  branch: Schema.NullOr(Schema.String.check(Schema.isMaxLength(MAX_COMPARISON_BRANCH))),
  base: Schema.String.check(Schema.isMaxLength(MAX_COMPARISON_BRANCH)),
  mergeBase: Schema.String.check(Schema.isMaxLength(64)),
  head: Schema.String.check(Schema.isMaxLength(64)),
});

export type BranchSource = typeof BranchSource.Type;

/**
 * An Annotation on a pull request's Comparison: the repo, the pull request's number and title (as of the Comparison it
 * was written against), and the merge-base and head SHAs. A refresh to a new head moves the drafts that still hold to the
 * new pair, as it does on This branch.
 */
export const PullSource = Schema.Struct({
  kind: Schema.Literal("pull"),
  repo: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  title: Schema.String.check(Schema.isMaxLength(MAX_PULL_TITLE)),
  mergeBase: Schema.String.check(Schema.isMaxLength(64)),
  head: Schema.String.check(Schema.isMaxLength(64)),
});

export type PullSource = typeof PullSource.Type;

/**
 * An Annotation on a repo's file in the Last run (`docs/architecture/diffs-and-review.md` → Run diff): the conversation whose
 * Run it is, the Run, the repo, and the commits of the Run's start and end copies. While the Run is live `end` is null
 * and the drafts follow the Changes' outdated rule; once it ended they are checked a last time and never again.
 */
export const RunSource = Schema.Struct({
  kind: Schema.Literal("run"),
  conversationId: ConversationId,
  /** The Run's ID (`LastRun.run`). */
  run: Schema.String.check(Schema.isMaxLength(64)),
  repo: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  /** The commit of the start copy. */
  start: Schema.String.check(Schema.isMaxLength(64)),
  /** The commit of the end copy; null while the Run is live. */
  end: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
});

export type RunSource = typeof RunSource.Type;

/** The diff a line range was drawn on. */
export const DiffSource = Schema.Union([
  CallDiffSource,
  ChangesSource,
  BranchSource,
  PullSource,
  RunSource,
]);

export type DiffSource = typeof DiffSource.Type;

const Coordinate = Schema.Finite.check(Schema.isBetween({ minimum: -1e7, maximum: 1e7 }));

const Extent = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1e7 }));

/** A rectangle of a page, in CSS px. */
export const PageRect = Schema.Struct({
  x: Coordinate,
  y: Coordinate,
  width: Extent,
  height: Extent,
});

export type PageRect = typeof PageRect.Type;

/** An element a page Annotation picked: a CSS selector that finds it again, and its tag name. */
export const PageElement = Schema.Struct({
  selector: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ANNOTATION_SELECTOR)),
  tag: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ANNOTATION_TAG)),
});

export type PageElement = typeof PageElement.Type;

/**
 * An Annotation on a page in the Browser Pane: the Owner tab's URL (without its fragment) and the Owner tab it was drawn
 * in, the element picked (absent for an area dragged out), its box (or the area) in the viewport's CSS px, how far the
 * page was scrolled, and the viewport's size, all as they were when it was drawn. Everything but the Owner tab's ID came
 * from the page. Its drafts show as pins on whichever Owner tab is at its URL; the Pane finds the element again, and the
 * Session never checks them.
 */
export const PageSource = Schema.Struct({
  kind: Schema.Literal("page"),
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_PAGE_URL)),
  ownerTabId: Schema.String.check(Schema.isMaxLength(MAX_PAGE_ID)),
  element: Schema.optionalKey(PageElement),
  box: PageRect,
  scroll: Schema.Struct({ x: Coordinate, y: Coordinate }),
  viewport: Schema.Struct({ width: Extent, height: Extent }),
});

export type PageSource = typeof PageSource.Type;

/** Where an Annotation was drawn. */
export const AnnotationSource = Schema.Union([
  CallDiffSource,
  ChangesSource,
  BranchSource,
  PullSource,
  RunSource,
  PageSource,
]);

export type AnnotationSource = typeof AnnotationSource.Type;

/**
 * What the Session's last check found of an Annotation on the Changes whose quote is not where it was: `outdated` when the
 * quote is gone from the file (or found more than once), `gone` when the file is no longer in the Changes. Either keeps
 * its place and its quote, and is still sent.
 */
export const AnnotationStatus = Schema.Literals(["outdated", "gone"]);

export type AnnotationStatus = typeof AnnotationStatus.Type;

/** What every draft has: its ID and the conversation it goes to. */
const draftFields = {
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ANNOTATION_ID)),
  /** The subagent conversation the draft goes to; left out, the active Session branch, as `submit`'s. */
  conversationId: Schema.optionalKey(ConversationId),
};

/** A draft on a diff as a client saves it (`annotation_save`): everything but what the Session stamps. */
export const DiffAnnotationDraft = Schema.Struct({
  ...draftFields,
  source: DiffSource,
  /** The file: absolute for a Call diff (resolved against its conversation's directory), within the repo for the Changes. */
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ANNOTATION_PATH)),
  /** Its path before a rename. */
  oldPath: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_ANNOTATION_PATH))),
  side: AnnotationSide,
  /** The first and last line of the range, in that side's file, from 1. */
  start: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  end: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** The range's first lines, as they were when it was drawn (`cutQuote`); the Session cuts what is past the limits. */
  quote: Schema.Array(Schema.String),
  /** How many lines of the range the quote leaves out. */
  more: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The quote's last line is cut short: a line longer than `MAX_QUOTE_BYTES` alone. */
  clipped: Schema.optionalKey(Schema.Boolean),
  /** The owner's text. */
  text: Schema.String.check(Schema.isMaxLength(MAX_ANNOTATION_TEXT)),
});

export type DiffAnnotationDraft = typeof DiffAnnotationDraft.Type;

/** The image types a page Annotation's crop may be. */
export const PageCropType = Schema.Literals(["image/jpeg", "image/png", "image/webp"]);

/** A crop of the spot from the Pane's screen, in base64, at most `MAX_ANNOTATION_CROP` characters. */
export const PageCrop = Schema.Struct({
  mimeType: PageCropType,
  data: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_ANNOTATION_CROP),
    Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
  ),
});

export type PageCrop = typeof PageCrop.Type;

/**
 * A draft on a page as a client saves it: the element's visible text as its quote (lines, cut by `cutPageQuote`; none for
 * an area), and a crop of the spot from the Pane's screen when the Pane had one.
 */
export const PageAnnotationDraft = Schema.Struct({
  ...draftFields,
  source: PageSource,
  quote: Schema.Array(Schema.String),
  more: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  clipped: Schema.optionalKey(Schema.Boolean),
  crop: Schema.optionalKey(PageCrop),
  text: Schema.String.check(Schema.isMaxLength(MAX_ANNOTATION_TEXT)),
});

export type PageAnnotationDraft = typeof PageAnnotationDraft.Type;

/** An Annotation as a client saves it (`annotation_save`): on a diff or on a page. */
export const AnnotationDraft = Schema.Union([DiffAnnotationDraft, PageAnnotationDraft]);

export type AnnotationDraft = typeof AnnotationDraft.Type;

/** What the Session stamps on a draft it keeps: when it was first and last saved. */
const keptFields = { createdAt: Schema.Finite, updatedAt: Schema.Finite };

/** A draft on a diff as the Session keeps it: with when it was first and last saved, and what its last check found. */
export const DiffAnnotation = Schema.Struct({
  ...DiffAnnotationDraft.fields,
  ...keptFields,
  status: Schema.optionalKey(AnnotationStatus),
});

export type DiffAnnotation = typeof DiffAnnotation.Type;

/** A draft on a page as the Session keeps it. The Session never checks it: the Pane finds its element. */
export const PageAnnotation = Schema.Struct({ ...PageAnnotationDraft.fields, ...keptFields });

export type PageAnnotation = typeof PageAnnotation.Type;

/** A draft as the Session keeps it. */
export const Annotation = Schema.Union([DiffAnnotation, PageAnnotation]);

export type Annotation = typeof Annotation.Type;

/** Whether `annotation` is on a page. */
export const isPageAnnotation = <A extends Pick<Annotation, "source">>(
  annotation: A,
): annotation is Extract<A, { readonly source: PageSource }> => annotation.source.kind === "page";

/** Whether `annotation` is on a diff. */
export const isDiffAnnotation = <A extends Pick<Annotation, "source">>(
  annotation: A,
): annotation is Exclude<A, { readonly source: PageSource }> => annotation.source.kind !== "page";

const encoder = new TextEncoder();

const bytesOf = (text: string): number => encoder.encode(text).length;

/** What a piece of a quote costs: its UTF-8 bytes as it is, or as it is written escaped (a page's). */
type Measure = (text: string) => number;

/** `line` cut to at most `bytes` of `measure`, whole code points only. */
const clipLine = (line: string, bytes: number, measure: Measure): string => {
  let used = 0;
  let end = 0;

  for (const point of line) {
    const size = measure(point);

    if (used + size > bytes) break;

    used += size;
    end += point.length;
  }

  return line.slice(0, end);
};

/** A quote within the limits: its lines, how many it leaves out, and whether its last line is cut short. */
export type Quote = {
  readonly quote: readonly string[];
  readonly more: number;
  readonly clipped?: true;
};

/**
 * The quote of a range whose lines are `lines` (and `more` past them already left out): at most `MAX_QUOTE_LINES` lines
 * and `MAX_QUOTE_BYTES` bytes, a newline counted after each, the rest counted in `more`. A first line that alone passes
 * the bytes is kept cut short (`clipped`), so a minified file still quotes something. Cutting a quote that is within the
 * limits leaves it as it is.
 */
export const cutQuote = (lines: readonly string[], more = 0, clipped = false): Quote =>
  cutMeasured(lines, more, clipped, bytesOf);

/**
 * The quote of a page's text, as `cutQuote` cuts one, but measured as the Review writes it, escaped (`escapePageText`: a
 * `"` takes six bytes), so a page's quote takes no more of a Review than a diff's at the limits.
 */
export const cutPageQuote = (lines: readonly string[], more = 0, clipped = false): Quote =>
  cutMeasured(lines, more, clipped, escapedBytes);

const cutMeasured = (
  lines: readonly string[],
  more: number,
  clipped: boolean,
  measure: Measure,
): Quote => {
  const kept: string[] = [];
  let bytes = 0;
  let clip = false;

  for (const line of lines) {
    if (kept.length === MAX_QUOTE_LINES) break;

    const size = measure(line) + 1;

    if (bytes + size > MAX_QUOTE_BYTES) {
      if (kept.length === 0) {
        kept.push(clipLine(line, MAX_QUOTE_BYTES - 1, measure));
        clip = true;
      }

      break;
    }

    kept.push(line);
    bytes += size;
  }

  // A quote already clipped and kept whole stays clipped: its last line is the clipped one.
  const isClipped = clip || (clipped && kept.length === lines.length);
  const left = more + lines.length - kept.length;

  return isClipped ? { quote: kept, more: left, clipped: true } : { quote: kept, more: left };
};

/**
 * The absolute path of an Annotation's file: a Call diff's as recorded, a changed file's (in the Changes, a Comparison or
 * a Run) in its repo's clone.
 */
export const annotationPath = (annotation: Pick<DiffAnnotationDraft, "source" | "path">): string =>
  annotation.source.kind === "call"
    ? annotation.path
    : `${WORKSPACE_ROOT}/${annotation.source.repo}/${annotation.path}`;

/**
 * `path` resolved against directory `cwd`, as a tool resolves the path the model gives it: an absolute path as it is,
 * with `.` and `..` segments folded.
 */
export const resolvePath = (cwd: string, path: string): string => {
  const segments: string[] = [];

  for (const segment of `${path.startsWith("/") ? "" : cwd}/${path}`.split("/")) {
    if (segment === "" || segment === ".") continue;

    if (segment === "..") segments.pop();
    else segments.push(segment);
  }

  return `/${segments.join("/")}`;
};

/** The file's name: the last segment of its path. */
export const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** The range as its chip names it: `12`, or `12–18`. */
export const rangeLabel = (annotation: Pick<DiffAnnotationDraft, "start" | "end">): string =>
  annotation.start === annotation.end
    ? String(annotation.start)
    : `${annotation.start}–${annotation.end}`;

/**
 * Whether two sources are the same diff: the same call (and nested call), the same repo's Changes, the same repo's
 * This branch or the same pull request (whatever pair of commits it was written against), or the same repo in the same
 * Run; or the same page (its URL, in whichever Owner tab).
 */
export const sameSource = (a: AnnotationSource, b: AnnotationSource): boolean => {
  switch (a.kind) {
    case "call":
      return (
        b.kind === "call" &&
        a.conversationId === b.conversationId &&
        a.callId === b.callId &&
        a.nested === b.nested
      );
    case "changes":
      return b.kind === "changes" && a.repo === b.repo;
    case "branch":
      return b.kind === "branch" && a.repo === b.repo;
    case "pull":
      return b.kind === "pull" && a.repo === b.repo && a.number === b.number;
    case "run":
      return b.kind === "run" && a.run === b.run && a.repo === b.repo;
    case "page":
      return b.kind === "page" && a.url === b.url;
  }
};

/** The UTF-8 bytes of `text` as the Review writes it, escaped. */
const escapedBytes: Measure = (text) => bytesOf(escapePageText(text));

/**
 * A page's text on one line, without control characters, cut to `max` code points and to `max` UTF-8 bytes as the
 * Review writes it, escaped.
 */
const pageLine = (text: string, max: number): string => {
  const line = oneLine(boundedText(text, max));

  return escapedBytes(line) <= max ? line : clipLine(line, max, escapedBytes);
};

// Kept apart so no source file spells a whole Secret Reference, which the agent's own Secrets would refuse to write.
const REFERENCE = new RegExp(`${"\\{".repeat(2)}secret:[A-Z_][A-Z0-9_]*${"\\}".repeat(2)}`, "gu");

/** `text` as a regular expression that matches it alone. */
const literally = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");

/**
 * Whether a page draft's `stored` URL is of the page at `url`: the same address, fragment aside, as the Session kept it
 * (`clampPageSource`): cleaned, a held Secret in it standing for any text, and cut at its bound (where only what is
 * kept is compared).
 */
export const isSamePage = (stored: string, url: string): boolean => {
  const live = cleanLine(withoutFragment(url));

  if (stored === live) return true;

  // Cut by code points (it ends with an ellipsis), or by its bytes as the Review writes it (a character's at most six).
  const cut = stored.endsWith("…") || escapedBytes(stored) > MAX_PAGE_URL - 6;
  const kept = stored.endsWith("…") ? stored.slice(0, -1) : stored;
  const pattern = kept.split(REFERENCE).map(literally).join("[\\s\\S]+?");

  return new RegExp(`^${pattern}${cut ? "" : "$"}`, "u").test(live);
};

/**
 * `source` with what the page supplied (its URL, the element's selector and tag) on one line, without control or
 * bidirectional characters, and cut to its bounds, escaped as the Review writes them; the URL without its fragment.
 */
export const clampPageSource = (source: PageSource): PageSource => {
  const { element, ...rest } = source;
  const clamped = { ...rest, url: pageLine(withoutFragment(source.url), MAX_PAGE_URL) };

  return element === undefined
    ? clamped
    : {
        ...clamped,
        element: {
          selector: pageLine(element.selector, MAX_ANNOTATION_SELECTOR),
          tag: pageLine(element.tag, MAX_ANNOTATION_TAG),
        },
      };
};

/**
 * `source` cleaned as `clampPageSource` cleans it (the URL without its fragment), uncut: what the Session redacts
 * Secrets from, so that a Secret split by a character the cleaning drops or folds is whole when it is redacted.
 */
export const cleanPageSource = (source: PageSource): PageSource => {
  const { element, ...rest } = source;
  const cleaned = { ...rest, url: cleanLine(withoutFragment(source.url)) };

  return element === undefined
    ? cleaned
    : {
        ...cleaned,
        element: { selector: cleanLine(element.selector), tag: cleanLine(element.tag) },
      };
};

/** A page's visible text without control or bidirectional characters, uncut. */
export const cleanPageLines = (lines: readonly string[]): string[] =>
  lines.map((line) => cleanText(line));

/** A page's visible text as the lines of a quote: without control or bidirectional characters, cut by `cutPageQuote`. */
export const pageQuote = (lines: readonly string[], more = 0, clipped = false): Quote =>
  cutPageQuote(cleanPageLines(lines), more, clipped);
