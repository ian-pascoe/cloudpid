// Annotations (GLOSSARY.md → Annotation; `docs/spec.md` → Diffs and review → Annotations and Reviews): the owner's
// drafts on a line range of one side of a diff, kept by the Session DO and synced to every client, until they are sent
// together as a Review. Each is anchored to its source: a Call diff (the call, as recorded, which never changes) or the
// Changes (the repo and the HEAD it was written against, checked again as the files change).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over an Annotation's fields.
import * as Schema from "effect/Schema";
import { ConversationId } from "./conversation-id.ts";
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

/** The longest path an Annotation names. */
export const MAX_ANNOTATION_PATH = 4_096;

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

/** Where an Annotation was drawn. */
export const AnnotationSource = Schema.Union([CallDiffSource, ChangesSource]);

export type AnnotationSource = typeof AnnotationSource.Type;

/**
 * What the Session's last check found of an Annotation on the Changes whose quote is not where it was: `outdated` when the
 * quote is gone from the file (or found more than once), `gone` when the file is no longer in the Changes. Either keeps
 * its place and its quote, and is still sent.
 */
export const AnnotationStatus = Schema.Literals(["outdated", "gone"]);

export type AnnotationStatus = typeof AnnotationStatus.Type;

/** An Annotation as a client saves it (`annotation_save`): everything but what the Session stamps. */
export const AnnotationDraft = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ANNOTATION_ID)),
  /** The subagent conversation the draft goes to; left out, the active Session branch, as `submit`'s. */
  conversationId: Schema.optionalKey(ConversationId),
  source: AnnotationSource,
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

export type AnnotationDraft = typeof AnnotationDraft.Type;

/** A draft as the Session keeps it: with when it was first and last saved, and what its last check found. */
export const Annotation = Schema.Struct({
  ...AnnotationDraft.fields,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  status: Schema.optionalKey(AnnotationStatus),
});

export type Annotation = typeof Annotation.Type;

const encoder = new TextEncoder();

const bytesOf = (text: string): number => encoder.encode(text).length;

/** `line` cut to at most `bytes` UTF-8 bytes, whole code points only. */
const clipLine = (line: string, bytes: number): string => {
  let used = 0;
  let end = 0;

  for (const point of line) {
    const size = bytesOf(point);

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
export const cutQuote = (lines: readonly string[], more = 0, clipped = false): Quote => {
  const kept: string[] = [];
  let bytes = 0;
  let clip = false;

  for (const line of lines) {
    if (kept.length === MAX_QUOTE_LINES) break;

    const size = bytesOf(line) + 1;

    if (bytes + size > MAX_QUOTE_BYTES) {
      if (kept.length === 0) {
        kept.push(clipLine(line, MAX_QUOTE_BYTES - 1));
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

/** The absolute path of an Annotation's file: a Call diff's as recorded, a changed file's in its repo's clone. */
export const annotationPath = (annotation: Pick<AnnotationDraft, "source" | "path">): string =>
  annotation.source.kind === "changes"
    ? `${WORKSPACE_ROOT}/${annotation.source.repo}/${annotation.path}`
    : annotation.path;

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
export const rangeLabel = (annotation: Pick<AnnotationDraft, "start" | "end">): string =>
  annotation.start === annotation.end
    ? String(annotation.start)
    : `${annotation.start}–${annotation.end}`;

/** Whether two sources are the same diff: the same call (and nested call), or the same repo's Changes. */
export const sameSource = (a: AnnotationSource, b: AnnotationSource): boolean =>
  a.kind === "call"
    ? b.kind === "call" &&
      a.conversationId === b.conversationId &&
      a.callId === b.callId &&
      a.nested === b.nested
    : b.kind === "changes" && a.repo === b.repo;
