// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
// What the model sees of a tool's text: the head of it within the output limits, and a note saying what was left.
//
// Ported from pi-web-tools' `src/web-tool-output.ts` (see ../../NOTICE.md). The original saved a truncated result in
// full to a temporary file and named the path. A Worker has no file system the model can read, so nothing is spilled:
// the continuation note names the `offset` that reads on (the page is fetched again for it), and a result that cannot be
// paged says how to ask for less. The limits are the Harness's own (50 KiB, 2,000 lines), so it never cuts these again.
import * as Arr from "effect/Array";

export const OUTPUT_MAX_BYTES = 50 * 1024;
export const OUTPUT_MAX_LINES = 2000;

/** Largest UTF-8 size of the text a program (code mode) receives as structured output. */
export const STRUCTURED_MAX_BYTES = 1024 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const byteLength = (text: string): number => encoder.encode(text).length;

/** Lines the note for a truncated result adds: a blank line and the note itself. */
const NOTE_LINES = 2;

/** The first `maxBytes` of `text`, cut on a character boundary. */
const cutBytes = (text: string, maxBytes: number): string => {
  const bytes = encoder.encode(text);

  if (bytes.length <= maxBytes) return text;

  let end = maxBytes;

  // Back up over UTF-8 continuation bytes so a multi-byte character is never split.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;

  return decoder.decode(bytes.subarray(0, end));
};

/** Text for programs: the head of a result, cut on a character boundary at the structured limit. */
export const boundStructuredText = (text: string) => {
  const content = cutBytes(text, STRUCTURED_MAX_BYTES);

  return { content, truncated: content.length < text.length };
};

/** How much of a text fits a budget. */
type Head = {
  readonly content: string;
  /** Whole lines of the text that `content` holds; 0 when the first line alone is over the byte budget. */
  readonly lines: number;
  readonly truncated: boolean;
  /** `content` is the cut start of an oversized first line. */
  readonly cutFirstLine: boolean;
};

/** The head of `text` within `maxBytes` and `maxLines`, in whole lines; the cut start of line 1 if it alone is too long. */
const head = (text: string, maxBytes: number, maxLines: number): Head => {
  let bytes = 0;
  let lines = 0;
  let position = 0;

  while (lines < maxLines) {
    const newline = text.indexOf("\n", position);
    const end = newline === -1 ? text.length : newline;
    const size = byteLength(text.slice(position, end)) + (lines > 0 ? 1 : 0);

    if (bytes + size > maxBytes) break;

    bytes += size;
    lines++;

    if (newline === -1) return { content: text, lines, truncated: false, cutFirstLine: false };

    position = newline + 1;
  }

  if (lines === 0) {
    return { content: cutBytes(text, maxBytes), lines: 0, truncated: true, cutFirstLine: true };
  }

  return { content: text.slice(0, position - 1), lines, truncated: true, cutFirstLine: false };
};

/** The number of lines in `text` as `split("\n")` counts them. */
export const countLines = (text: string): number => {
  let lines = 1;
  let position = text.indexOf("\n");

  while (position !== -1) {
    lines++;
    position = text.indexOf("\n", position + 1);
  }

  return lines;
};

/** Where a text sits within the longer one it was selected from, in 1-indexed lines. */
export type LineWindow = {
  /** Line of the source that the first line of the text came from. */
  readonly firstLine: number;
  /** Line count of the whole source. */
  readonly totalLines: number;
};

const lineWord = (count: number): string => (count === 1 ? "line remains" : "lines remain");

/** The note after `shownLines` lines. `remaining` is derived unless the caller sizes the worst case. */
const continuationNote = (
  window: LineWindow,
  shownLines: number,
  remaining = window.totalLines - (window.firstLine + shownLines - 1),
): string => {
  const lastLine = window.firstLine + shownLines - 1;

  return `[Showing lines ${window.firstLine}-${lastLine} of ${window.totalLines}. ${remaining} ${lineWord(remaining)}. Use offset=${lastLine + 1} to continue.]`;
};

/** The note for a first line too long to show whole: it is cut, and where to read on, if any line follows. */
const cutLineNote = (window: LineWindow): string =>
  window.firstLine >= window.totalLines
    ? `[Line ${window.firstLine} is longer than the ${OUTPUT_MAX_BYTES / 1024} KiB output limit and is cut here; the rest of it cannot be read.]`
    : `[Line ${window.firstLine} is longer than the ${OUTPUT_MAX_BYTES / 1024} KiB output limit and is cut here; the rest of it cannot be read. Use offset=${window.firstLine + 1} to continue after it.]`;

/** The note after `shown` lines of the text, or nothing when no source line remains. */
const continuationSuffix = (window: LineWindow, shown: Head): string => {
  if (shown.cutFirstLine) return `\n\n${cutLineNote(window)}`;

  if (window.firstLine + shown.lines - 1 >= window.totalLines) return "";

  return `\n\n${continuationNote(window, shown.lines)}`;
};

/** Bytes to reserve for the longest note any amount of shown text can need. */
const largestSuffixBytes = (window: LineWindow, textLines: number): number =>
  Math.max(
    byteLength(`\n\n${continuationNote(window, textLines, window.totalLines - window.firstLine)}`),
    byteLength(`\n\n${cutLineNote(window)}`),
  );

/** Model-visible text, and whether it is cut. */
export type FittedOutput = { readonly content: string; readonly truncated: boolean };

/**
 * `text` as the model sees it. A result within the limits is returned whole, with a note when the window it was
 * selected from has lines after it. A longer one is cut to whole lines, with the room for its note reserved inside the
 * limits, and the note names the `offset` that reads on from the last line shown.
 */
export const fitWindowedOutput = (text: string, window: LineWindow): FittedOutput => {
  const textLines = countLines(text);

  const suffix = continuationSuffix(window, {
    content: text,
    lines: textLines,
    truncated: false,
    cutFirstLine: false,
  });

  const initial = head(`${text}${suffix}`, OUTPUT_MAX_BYTES, OUTPUT_MAX_LINES);

  if (!initial.truncated) return { content: `${text}${suffix}`, truncated: false };

  const visible = head(
    text,
    OUTPUT_MAX_BYTES - largestSuffixBytes(window, textLines),
    OUTPUT_MAX_LINES - NOTE_LINES,
  );

  const note = continuationSuffix(window, visible);

  return {
    content: visible.content === "" ? note.trimStart() : `${visible.content}${note}`,
    truncated: true,
  };
};

/**
 * Text with no window to page through (a search result): within the limits it is returned whole, otherwise cut to
 * whole lines with a note that says what to change to read less.
 */
export const fitOutput = (text: string, advice: string): FittedOutput => {
  const initial = head(text, OUTPUT_MAX_BYTES, OUTPUT_MAX_LINES);

  if (!initial.truncated) return { content: text, truncated: false };

  const total = countLines(text);

  const note = (shown: number): string =>
    `\n\n[Output truncated to the first ${shown} of ${total} lines. ${advice}]`;

  const visible = head(
    text,
    OUTPUT_MAX_BYTES - byteLength(note(OUTPUT_MAX_LINES)),
    OUTPUT_MAX_LINES - NOTE_LINES,
  );

  return { content: `${visible.content}${note(visible.lines)}`, truncated: true };
};

/** The lines `offset` (1-indexed) to `offset + limit - 1` of `content`, and the window they sit in. */
export const selectLines = (
  content: string,
  offset: number | undefined,
  limit: number | undefined,
):
  | { readonly text: string; readonly window: LineWindow; readonly lastLine: number }
  | undefined => {
  const lines = content.split("\n");
  const start = (offset ?? 1) - 1;

  if (start >= lines.length) return undefined;

  const end = limit === undefined ? lines.length : Math.min(start + limit, lines.length);
  const requested = offset !== undefined || limit !== undefined;

  return {
    text: requested ? Arr.join(lines.slice(start, end), "\n") : content,
    window: { firstLine: start + 1, totalLines: lines.length },
    lastLine: end,
  };
};
