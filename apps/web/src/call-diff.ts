// The Call diff of an `edit` card (`docs/spec.md` → Diffs and review): the patch the call recorded, its `+n −m`, the cap
// on how much of it a card shows, and whether it is laid out split or stacked.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, called from React.
import * as Arr from "effect/Array";
import type { TranscriptPart } from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const Recorded = Schema.Struct({ patch: Schema.NonEmptyString });

/** Decodes the patch of an `edit`'s `details`, and of a card's artifact, which carries it under the same name. */
export const decodeRecorded = Schema.decodeUnknownOption(Recorded);

/** The most diff lines a card shows before "Show all n lines". */
export const CALL_DIFF_LINE_CAP = 2000;

/** How a diff is laid out: in two columns, or stacked. */
export type DiffStyle = "split" | "unified";

/** The card width, in px, from which a diff is split in two columns; narrower, it is stacked. */
export const SPLIT_MIN_WIDTH = 720;

export const diffStyleFor = (width: number): DiffStyle =>
  width >= SPLIT_MIN_WIDTH ? "split" : "unified";

/** The marker after a line that has no newline at the end of the file. */
const isMarker = (line: string): boolean => line.startsWith("\\");

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

type Hunk = {
  readonly oldStart: number;
  readonly newStart: number;
  /** What follows the closing `@@` of the header, such as a function name. */
  readonly tail: string;
  /** The hunk's lines as they are written, with their `+`, `-` or space, and the no-newline markers. */
  readonly body: readonly string[];
};

type ParsedPatch = { readonly head: readonly string[]; readonly hunks: readonly Hunk[] };

/**
 * A unified patch cut into its file headers and hunks. A hunk ends where its header's counts say, so a removed line
 * that reads `--- x` is a line of the hunk and not the next file's header.
 */
const parsePatch = (patch: string): ParsedPatch => {
  const lines = patch.split("\n");
  const head: string[] = [];
  const hunks: Hunk[] = [];
  let index = 0;

  while (index < lines.length && !HUNK_HEADER.test(lines[index] ?? "")) {
    head.push(lines[index] ?? "");
    index += 1;
  }

  while (index < lines.length) {
    const found = HUNK_HEADER.exec(lines[index] ?? "");

    if (found === null) {
      index += 1;
      continue;
    }

    let oldLeft = Number(found[2] ?? 1);
    let newLeft = Number(found[4] ?? 1);
    const body: string[] = [];

    index += 1;

    while (index < lines.length && (oldLeft > 0 || newLeft > 0 || isMarker(lines[index] ?? ""))) {
      const line = lines[index] ?? "";

      if (isMarker(line)) {
        body.push(line);
      } else if (line.startsWith("+")) {
        newLeft -= 1;
        body.push(line);
      } else if (line.startsWith("-")) {
        oldLeft -= 1;
        body.push(line);
      } else {
        oldLeft -= 1;
        newLeft -= 1;
        body.push(line);
      }

      index += 1;
    }

    hunks.push({
      oldStart: Number(found[1]),
      newStart: Number(found[3]),
      tail: found[5] ?? "",
      body,
    });
  }

  return { head, hunks };
};

/** The added and removed lines of a patch, or undefined where it has no hunk. */
export const patchCounts = (
  patch: string,
): { readonly additions: number; readonly deletions: number } | undefined => {
  const { hunks } = parsePatch(patch);

  if (hunks.length === 0) return undefined;

  let additions = 0;
  let deletions = 0;

  for (const hunk of hunks) {
    for (const line of hunk.body) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }

  return { additions, deletions };
};

/** A patch cut to a number of lines: the patch to show, the lines the whole one has, and whether it was cut. */
export type CappedPatch = {
  readonly patch: string;
  readonly lines: number;
  readonly capped: boolean;
};

/** How many lines of the old file and of the new file the lines of a hunk's body cover. */
const sideCounts = (body: readonly string[]) => {
  const lines = Arr.filter(body, (line) => !isMarker(line));
  const added = Arr.filter(lines, (line) => line.startsWith("+")).length;
  const removed = Arr.filter(lines, (line) => line.startsWith("-")).length;

  return { old: lines.length - added, new: lines.length - removed };
};

/**
 * A side with no lines is written as the unified format has it, its start the line before where the lines would be: a
 * cut that keeps only added lines of a hunk that had old ones gives `-N-1,0`. A side that had none to begin with already
 * has that start.
 */
const sideStart = (start: number, count: number, wholeCount: number): number =>
  count === 0 && wholeCount > 0 ? start - 1 : start;

const hunkText = (hunk: Hunk, body: readonly string[]): string => {
  const kept = sideCounts(body);
  const whole = sideCounts(hunk.body);
  const oldStart = sideStart(hunk.oldStart, kept.old, whole.old);
  const newStart = sideStart(hunk.newStart, kept.new, whole.new);

  return Arr.join(
    Arr.map(
      [`@@ -${oldStart},${kept.old} +${newStart},${kept.new} @@${hunk.tail}`, ...body],
      (line) => `${line}\n`,
    ),
    "",
  );
};

/**
 * `patch` cut to its first `cap` diff lines (the lines of its hunks, whether added, removed or unchanged), with the last
 * hunk's counts written again so what is left is a patch of its own. A patch within the cap is returned as it is. It
 * handles the patch of one file, as an `edit` records (one `---`/`+++` header pair); a patch of several files would keep
 * only the first file's header.
 */
export const capPatch = (patch: string, cap: number = CALL_DIFF_LINE_CAP): CappedPatch => {
  const parsed = parsePatch(patch);

  const lines = Arr.reduce(
    parsed.hunks,
    0,
    (total, hunk) => total + Arr.filter(hunk.body, (line) => !isMarker(line)).length,
  );

  if (lines <= cap) return { patch, lines, capped: false };

  let text = Arr.join(
    Arr.map(parsed.head, (line) => `${line}\n`),
    "",
  );

  let left = cap;

  for (const hunk of parsed.hunks) {
    if (left <= 0) break;

    const body: string[] = [];

    for (const line of hunk.body) {
      if (!isMarker(line)) {
        if (left <= 0) break;

        left -= 1;
      }

      body.push(line);
    }

    text += hunkText(hunk, body);
  }

  return { patch: text, lines, capped: true };
};

/**
 * The patch a finished tool call's `details` record for the card's Call diff: only `edit` records one, a call that
 * failed has none, and nothing else is shown as a diff.
 */
export const callDiffPatch = (
  toolName: string,
  details: Extract<TranscriptPart, { type: "tool-result" }>["details"],
  isError: boolean,
): string | undefined =>
  toolName === "edit" && !isError
    ? Option.getOrUndefined(Option.map(decodeRecorded(details), (found) => found.patch))
    : undefined;
