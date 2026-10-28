// Lining up a changed file's two sides (`docs/architecture/diffs-and-review.md` → Diff pane), run in a Web Worker of its own
// (`line-up.worker.ts`) so a hard pair never holds the page: jsdiff, with its `timeout` at 2 s. Past it the file is shown
// as a whole-file replacement (every old line removed, every new one added), marked so. In the browser the clock moves
// while code runs, so the timeout fires; it blocks that worker for those 2 s, and only that worker.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over values, called from a worker, over native arrays.
import { createTwoFilesPatch } from "diff";

/** How long jsdiff may line one pair up before the file is shown replaced whole. */
export const LINE_UP_TIMEOUT_MS = 2000;

/** Lines of unchanged text around each change, as a Call diff has. */
const CONTEXT_LINES = 4;

/** The name a missing side has in a patch's header. */
const MISSING = "/dev/null";

/** A pair to line up: a side is null where the file does not exist (added, or deleted). */
export interface LineUpRequest {
  readonly oldName: string | null;
  readonly newName: string | null;
  readonly oldText: string | null;
  readonly newText: string | null;
}

/** A unified diff of the pair, and whether it is the whole-file replacement the budget fell back to. */
export interface LineUp {
  readonly patch: string;
  readonly replaced: boolean;
}

/** A side's lines, and whether its last one ends in a newline. */
interface Side {
  readonly lines: readonly string[];
  readonly ended: boolean;
}

/** The lines of `text` and whether its last one ends in a newline. */
const linesOf = (text: string): Side => {
  if (text === "") return { lines: [], ended: true };

  const ended = text.endsWith("\n");
  const lines = (ended ? text.slice(0, -1) : text).split("\n");

  return { lines, ended };
};

/** `start,count` of a side in a hunk header, 0 for an empty side as git writes it. */
const range = (count: number): string => `${count === 0 ? 0 : 1},${count}`;

const NO_NEWLINE = "\\ No newline at end of file";

/** One side's lines, each with its mark, and git's note after a last line with no newline. */
const sideLines = (mark: string, side: Side): string[] => {
  const written = side.lines.map((line) => `${mark}${line}`);

  if (!side.ended) written.push(NO_NEWLINE);

  return written;
};

/** A patch that removes all of `oldText` and adds all of `newText`, in one hunk: linear in their length. */
export const wholeFilePatch = (
  oldName: string,
  newName: string,
  oldText: string,
  newText: string,
): string => {
  const header = `--- ${oldName}\n+++ ${newName}\n`;
  const before = linesOf(oldText);
  const after = linesOf(newText);

  if (before.lines.length === 0 && after.lines.length === 0) return header;

  const body = [
    `@@ -${range(before.lines.length)} +${range(after.lines.length)} @@`,
    ...sideLines("-", before),
    ...sideLines("+", after),
  ];

  return `${header}${body.join("\n")}\n`;
};

/** The pair lined up within `timeoutMs`, or replaced whole past it; an added or deleted file is written whole. */
export const lineUp = (request: LineUpRequest, timeoutMs: number = LINE_UP_TIMEOUT_MS): LineUp => {
  const oldName = request.oldName ?? MISSING;
  const newName = request.newName ?? MISSING;
  const oldText = request.oldText ?? "";
  const newText = request.newText ?? "";

  if (request.oldText === null || request.newText === null) {
    return { patch: wholeFilePatch(oldName, newName, oldText, newText), replaced: false };
  }

  const patch = createTwoFilesPatch(oldName, newName, oldText, newText, undefined, undefined, {
    context: CONTEXT_LINES,
    timeout: timeoutMs,
  });

  return patch === undefined
    ? { patch: wholeFilePatch(oldName, newName, oldText, newText), replaced: true }
    : { patch, replaced: false };
};
