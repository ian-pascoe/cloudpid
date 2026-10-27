// The lines a gutter selection in a diff picks for an Annotation (`docs/spec.md` → Diffs and review → Annotations and
// Reviews): one side's range and its lines as they read now, the quote the draft keeps. Pure, over @pierre/diffs' parsed
// file, so it is tested without drawing anything.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over the library's arrays.

import { type AnnotationSide, cutQuote, type Quote } from "@cloudpid/protocol";
import type { FileDiffMetadata, SelectedLineRange, SelectionSide } from "@pierre/diffs";

/** What a selection picked: one side's first and last line, and the quote of them. */
export interface PickedLines extends Quote {
  readonly side: AnnotationSide;
  readonly start: number;
  readonly end: number;
}

/** The library's name of a side. */
export const librarySide = (side: AnnotationSide): SelectionSide =>
  side === "old" ? "deletions" : "additions";

/** One drawn row: a context line has a number on both sides, a removed or added line on one. */
interface Row {
  readonly old?: number;
  readonly new?: number;
}

/** A line's text without its line ending. */
const bare = (line: string): string => line.replace(/\r?\n$/u, "");

/**
 * The rows of `diff` in the order a stacked diff draws them, and each side's lines by number: a hunk's context lines,
 * then each change's removed lines before its added ones.
 */
const rowsOf = (diff: FileDiffMetadata) => {
  const rows: Row[] = [];
  const lines = { old: new Map<number, string>(), new: new Map<number, string>() };

  const put = (side: "old" | "new", number: number, text: string | undefined) => {
    if (text !== undefined) lines[side].set(number, bare(text));
  };

  for (const hunk of diff.hunks) {
    let oldNumber = hunk.deletionStart;
    let newNumber = hunk.additionStart;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let index = 0; index < content.lines; index++) {
          rows.push({ old: oldNumber, new: newNumber });
          put("old", oldNumber, diff.deletionLines[content.deletionLineIndex + index]);
          put("new", newNumber, diff.additionLines[content.additionLineIndex + index]);
          oldNumber += 1;
          newNumber += 1;
        }

        continue;
      }

      for (let index = 0; index < content.deletions; index++) {
        rows.push({ old: oldNumber });
        put("old", oldNumber, diff.deletionLines[content.deletionLineIndex + index]);
        oldNumber += 1;
      }

      for (let index = 0; index < content.additions; index++) {
        rows.push({ new: newNumber });
        put("new", newNumber, diff.additionLines[content.additionLineIndex + index]);
        newNumber += 1;
      }
    }
  }

  return { rows, lines };
};

/** Where a selection's end sits among the rows: the row with that number on that side. */
const rowIndex = (rows: readonly Row[], number: number, side: SelectionSide | undefined) =>
  rows.findIndex((row) => (side === "deletions" ? row.old === number : row.new === number));

/**
 * The lines `range` picks in `diff`, on one side: the new file's when it takes an added line or only context, the old
 * file's when it takes removed lines and no added one. Across a change, the draft is on what the change made. The range
 * runs from the side's first picked line to its last, and stops at a gap the diff does not draw (between two hunks of a
 * patch), so its quote is whole. Undefined when it picks no line.
 */
export const pickLines = (
  diff: FileDiffMetadata,
  range: SelectedLineRange,
): PickedLines | undefined => {
  const { rows, lines } = rowsOf(diff);
  const from = rowIndex(rows, range.start, range.side);
  const to = rowIndex(rows, range.end, range.endSide ?? range.side);

  if (from === -1 || to === -1) return undefined;

  const picked = rows.slice(Math.min(from, to), Math.max(from, to) + 1);
  const added = picked.some((row) => row.old === undefined);
  const removed = picked.some((row) => row.new === undefined);

  // Only context: the side the selection started on.
  const side: AnnotationSide =
    added || (!removed && range.side !== "deletions") ? "new" : "old";

  const numbers = picked.flatMap((row) => {
    const number = row[side];

    return number === undefined ? [] : [number];
  });

  const [start] = numbers;

  if (start === undefined) return undefined;

  const quoted: string[] = [];
  let end = start;

  for (const number of numbers) {
    const text = lines[side].get(number);

    // A gap: the range ends at the last line before it.
    if (text === undefined || number !== start + quoted.length) break;

    quoted.push(text);
    end = number;
  }

  return { side, start, end, ...cutQuote(quoted) };
};
