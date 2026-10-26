// The Call diff of an `edit` card (`docs/spec.md` → Diffs and review): the patch the call recorded, its `+n −m`, the cap
// on how much of it a card shows, and whether it is laid out split or stacked.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, called from React.
import * as Arr from "effect/Array";
import type { TranscriptPart } from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeDetails = Schema.decodeUnknownOption(Schema.Struct({ patch: Schema.NonEmptyString }));

/** The most diff lines a card shows before "Show all n lines". */
export const CALL_DIFF_LINE_CAP = 2000;

/** The card width, in px, from which a diff is split in two columns; narrower, it is stacked. */
export const SPLIT_MIN_WIDTH = 720;

export const diffStyleFor = (width: number): "split" | "unified" =>
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

const hunkText = (hunk: Hunk, body: readonly string[]): string => {
  const kept = Arr.filter(body, (line) => !isMarker(line));
  const added = Arr.filter(kept, (line) => line.startsWith("+")).length;
  const removed = Arr.filter(kept, (line) => line.startsWith("-")).length;
  const oldCount = kept.length - added;
  const newCount = kept.length - removed;

  return Arr.join(
    Arr.map(
      [`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@${hunk.tail}`, ...body],
      (line) => `${line}\n`,
    ),
    "",
  );
};

/**
 * `patch` cut to its first `cap` diff lines (the lines of its hunks, whether added, removed or unchanged), with the last
 * hunk's counts written again so what is left is a patch of its own. A patch within the cap is returned as it is.
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
    ? Option.getOrUndefined(Option.map(decodeDetails(details), (found) => found.patch))
    : undefined;
