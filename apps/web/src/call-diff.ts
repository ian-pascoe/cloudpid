// The Call diff of an `edit` or `write` card, and of the calls a `codemode` card lists (`docs/spec.md` → Diffs and
// review): what the call recorded of its change, its `+n −m`, the cap on how much of the patch a card shows, and whether
// it is laid out split or stacked.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, called from React.
import * as Arr from "effect/Array";
import type { TranscriptPart } from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * What a card shows of a call's change: its patch, or that there is none to show (`unavailable`: the files were too
 * large, or the old one binary or unreadable), and whether the call made a new file (`created`).
 */
export const CallDiff = Schema.Struct({
  patch: Schema.optional(Schema.NonEmptyString),
  created: Schema.optional(Schema.Literal(true)),
  unavailable: Schema.optional(Schema.Literal(true)),
});

export type CallDiff = typeof CallDiff.Type;

/** Decodes a card's artifact, which carries its Call diff as `diff`. */
export const decodeCardDiff = Schema.decodeUnknownOption(Schema.Struct({ diff: CallDiff }));

/** What a tool records in its result's `details`: `edit` a `patch`, `write` and the `codemode` calls these and flags. */
const Recorded = Schema.Struct({
  patch: Schema.optional(Schema.String),
  created: Schema.optional(Schema.Boolean),
  tooLarge: Schema.optional(Schema.Boolean),
  binary: Schema.optional(Schema.Boolean),
});

/** Decodes what a result's `details`, or a `codemode` result's entry for a nested call, record of a change. */
export const decodeRecorded = Schema.decodeUnknownOption(Recorded);

/** The Call diff of recorded details: none where they record no patch and no reason for there being none. */
export const toCallDiff = (recorded: typeof Recorded.Type): Option.Option<CallDiff> => {
  const created = recorded.created === true ? ({ created: true } as const) : {};

  if (recorded.patch !== undefined && recorded.patch !== "") {
    return Option.some({ ...created, patch: recorded.patch });
  }

  return recorded.tooLarge === true || recorded.binary === true
    ? Option.some({ ...created, unavailable: true })
    : Option.none();
};

type ResultDetails = Extract<TranscriptPart, { type: "tool-result" }>["details"];

/** The Call diff in a tool result's `details`. */
export const callDiffFrom = (details: ResultDetails): CallDiff | undefined =>
  Option.getOrUndefined(Option.flatMap(decodeRecorded(details), toCallDiff));

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

/** The lines a patch adds and removes. */
export type DiffCounts = { readonly additions: number; readonly deletions: number };

/** The added and removed lines of a patch, or undefined where it has no hunk. */
export const patchCounts = (patch: string): DiffCounts | undefined => {
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
 * The Call diff a finished tool call's `details` record for its card: `edit` and `write` record one, a call that failed
 * has none, a `write` from before the wrapper has none, and nothing else is shown as a diff.
 */
export const callDiffOf = (
  toolName: string,
  details: ResultDetails,
  isError: boolean,
): CallDiff | undefined =>
  (toolName === "edit" || toolName === "write") && !isError ? callDiffFrom(details) : undefined;

/** A Call diff's added and removed lines; undefined where it has no patch, or its patch changes nothing. */
export const callDiffCounts = (diff: CallDiff): DiffCounts | undefined =>
  diff.patch === undefined ? undefined : patchCounts(diff.patch);

/** The lines the Call diffs add and remove together; undefined where none of them changes a line. */
export const diffTotals = (diffs: readonly (CallDiff | undefined)[]): DiffCounts | undefined => {
  let additions = 0;
  let deletions = 0;
  let counted = false;

  for (const diff of diffs) {
    const counts = diff === undefined ? undefined : callDiffCounts(diff);

    if (counts === undefined) continue;

    counted = true;
    additions += counts.additions;
    deletions += counts.deletions;
  }

  return counted ? { additions, deletions } : undefined;
};
