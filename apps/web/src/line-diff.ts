// A line diff for the long values of an Agent change (`docs/spec.md` → Agent changes): a script or a `mise.toml` is
// shown as what was added and removed, with a few lines of the text around each change, instead of twice in full.
import type { AgentChange } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";

/** One line of a diff: kept (`same`), taken out (`removed`) or put in (`added`). */
export type DiffLine = {
  readonly kind: "same" | "removed" | "added";
  readonly text: string;
};

/** A diff as it is shown: its lines, and runs of unchanged lines folded into the count they hide. */
export type DiffRow = DiffLine | { readonly kind: "skipped"; readonly count: number };

/** The most cells of the table the changed middle of two texts may need before they are shown as replaced wholesale. */
const MAX_CELLS = 4_000_000;

const linesOf = (text: string): ReadonlyArray<string> =>
  text === "" ? [] : text.replace(/\n$/, "").split("\n");

/** The lines of `before` and `after` that differ: a longest common subsequence, or a wholesale replacement when huge. */
const diffMiddle = (
  before: ReadonlyArray<string>,
  after: ReadonlyArray<string>,
): ReadonlyArray<DiffLine> => {
  const removed = Arr.map(before, (text): DiffLine => ({ kind: "removed", text }));
  const added = Arr.map(after, (text): DiffLine => ({ kind: "added", text }));

  if (before.length === 0 || after.length === 0) return [...removed, ...added];

  if ((before.length + 1) * (after.length + 1) > MAX_CELLS) return [...removed, ...added];

  const width = after.length + 1;

  // common[i * width + j]: the length of the longest common subsequence of before[i..] and after[j..].
  const common = new Uint32Array((before.length + 1) * width);

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      common[i * width + j] =
        before[i] === after[j]
          ? (common[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(common[(i + 1) * width + j] ?? 0, common[i * width + j + 1] ?? 0);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < before.length && j < after.length) {
    const left = before[i] ?? "";
    const right = after[j] ?? "";

    if (left === right) {
      lines.push({ kind: "same", text: left });
      i += 1;
      j += 1;
    } else if ((common[(i + 1) * width + j] ?? 0) >= (common[i * width + j + 1] ?? 0)) {
      lines.push({ kind: "removed", text: left });
      i += 1;
    } else {
      lines.push({ kind: "added", text: right });
      j += 1;
    }
  }

  for (; i < before.length; i += 1) lines.push({ kind: "removed", text: before[i] ?? "" });

  for (; j < after.length; j += 1) lines.push({ kind: "added", text: after[j] ?? "" });

  return lines;
};

/** The lines that take `before` to `after`, the lines both have kept: removed lines come before the added ones that replace them. */
export const diffLines = (before: string, after: string): ReadonlyArray<DiffLine> => {
  const left = linesOf(before);
  const right = linesOf(after);

  let start = 0;

  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;

  let end = 0;

  while (
    end < left.length - start &&
    end < right.length - start &&
    left[left.length - 1 - end] === right[right.length - 1 - end]
  ) {
    end += 1;
  }

  return [
    ...Arr.map(Arr.take(left, start), (text): DiffLine => ({ kind: "same", text })),
    ...diffMiddle(left.slice(start, left.length - end), right.slice(start, right.length - end)),
    ...Arr.map(Arr.takeRight(left, end), (text): DiffLine => ({ kind: "same", text })),
  ];
};

/** `lines` with each run of unchanged lines folded to `context` lines beside a change, and a count of the rest. */
export const foldDiff = (lines: ReadonlyArray<DiffLine>, context = 3): ReadonlyArray<DiffRow> => {
  const near = Arr.map(lines, (_, index) =>
    Arr.some(
      Arr.range(Math.max(0, index - context), Math.min(lines.length - 1, index + context)),
      (other) => lines[other]?.kind !== "same",
    ),
  );

  const rows: DiffRow[] = [];
  let hidden = 0;

  lines.forEach((line, index) => {
    if (near[index] === true) {
      if (hidden > 0) rows.push({ kind: "skipped", count: hidden });

      hidden = 0;
      rows.push(line);
    } else {
      hidden += 1;
    }
  });

  if (hidden > 0) rows.push({ kind: "skipped", count: hidden });

  return rows;
};

/** The fields whose values are long text, which an Agent change shows as a diff. */
const TEXT_FIELDS: ReadonlySet<string> = new Set(["setupScript", "startScript", "toolchains"]);

/**
 * The diff to show for an Agent change of `field` from `before` to `after`, or undefined where the two values are shown
 * in full instead: only a script or the Toolchains, which are text (none is the empty text).
 */
export const changeDiff = (
  field: string,
  before: AgentChange["before"],
  after: AgentChange["after"],
): ReadonlyArray<DiffRow> | undefined => {
  if (!TEXT_FIELDS.has(field)) return undefined;

  const asText = (value: AgentChange["before"]): string | undefined =>
    value === null ? "" : Predicate.isString(value) ? value : undefined;

  const left = asText(before);
  const right = asText(after);

  return left === undefined || right === undefined ? undefined : foldDiff(diffLines(left, right));
};
