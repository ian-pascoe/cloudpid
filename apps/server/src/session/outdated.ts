// The outdated check of drafts on the Changes (`docs/spec.md` → Diffs and review → Annotations and Reviews): a draft's
// quote compared with the lines of its side of the file as they are now. Still in place, nothing changes; found exactly
// once elsewhere, the draft moves there silently (one edit above the drafts must not make them all outdated); otherwise
// it is marked outdated, or "no longer in the diff" when its file has left the Changes. A Call diff never changes, so
// its drafts are never checked. Nor are a page's: the Session cannot see the page, and the Browser Pane finds each
// one's element again itself, saying "not found on the page" when it cannot. Pure: the Session reads the files and
// applies what this finds (`annotations.ts`).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over lines of text.
import type {
  DiffAnnotation,
  ChangeEntry,
  ChangeFile,
  Comparison,
  RepoChanges,
} from "@cloudpid/protocol";

/** What a check of a quote against its side's lines found. */
export type QuoteCheck =
  | { readonly kind: "same" }
  | { readonly kind: "moved"; readonly start: number; readonly end: number }
  | { readonly kind: "outdated" };

/** A file's text as lines, as the browser quotes them: no line ending, the last newline ending a line. */
export const linesOf = (text: string): readonly string[] => {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));

  if (lines.at(-1) === "") lines.pop();

  return lines;
};

/**
 * Where `annotation`'s quote is in `lines`: at its place, exactly once elsewhere (its range moved with it, the same
 * length), or neither. A clipped quote's last line need only start the same.
 */
export const checkQuote = (
  annotation: Pick<DiffAnnotation, "start" | "end" | "quote" | "clipped">,
  lines: readonly string[],
): QuoteCheck => {
  const { quote } = annotation;

  if (quote.length === 0) return { kind: "same" };

  const matchesAt = (at: number): boolean =>
    quote.every((quoted, index) => {
      const line = lines[at + index];

      if (line === undefined) return false;

      return annotation.clipped === true && index === quote.length - 1
        ? line.startsWith(quoted)
        : line === quoted;
    });

  if (matchesAt(annotation.start - 1)) return { kind: "same" };

  let found: number | undefined;

  for (let at = 0; at + quote.length <= lines.length; at++) {
    if (!matchesAt(at)) continue;

    // Twice: the draft cannot tell which is its own.
    if (found !== undefined) return { kind: "outdated" };

    found = at;
  }

  return found === undefined
    ? { kind: "outdated" }
    : { kind: "moved", start: found + 1, end: found + 1 + annotation.end - annotation.start };
};

/** Where a draft on the Changes stands in a new list: its file to read, gone from the Changes, or not to be told. */
export type ListedFile =
  | { readonly kind: "file"; readonly repo: RepoChanges; readonly entry: ChangeEntry }
  | { readonly kind: "gone" }
  | { readonly kind: "unknown" };

/**
 * Find a draft's file in `repos`, by its path (a rename's new path). A repo that is not listed or failed to list, or
 * that has more files than the list holds, cannot say the file is gone, so the draft stays as it is.
 */
export const listedFile = (
  annotation: Pick<DiffAnnotation, "source" | "path">,
  repos: readonly RepoChanges[],
): ListedFile => {
  const { source } = annotation;

  if (source.kind !== "changes") return { kind: "unknown" };

  const repo = repos.find((each) => each.repo === source.repo);

  if (repo === undefined || repo.error !== undefined) return { kind: "unknown" };

  const entry = repo.files.find((file) => file.path === annotation.path);

  if (entry !== undefined) return { kind: "file", repo, entry };

  return repo.more > 0 ? { kind: "unknown" } : { kind: "gone" };
};

/** The lines of the draft's side of `file`, or undefined when that side has no text to compare (binary, too large). */
export const sideLines = (
  annotation: Pick<DiffAnnotation, "side">,
  file: ChangeFile,
): readonly string[] | undefined => {
  const side = annotation.side === "old" ? file.old : file.new;

  if (side === null) return [];

  return side.kind === "text" ? linesOf(side.text) : undefined;
};

/** The pair of commits a Comparison is made of, and what it is named: where a draft on This branch moves to. */
export type BranchPair = Pick<Comparison, "branch" | "base" | "mergeBase" | "head" | "pull">;

/** Where `annotation`'s file stands in a Comparison: its entry, gone from it, or not to be told. */
export type ComparedFile =
  | { readonly kind: "file"; readonly entry: ChangeEntry }
  | { readonly kind: "gone" }
  | { readonly kind: "unknown" };

/**
 * Find a draft's file in `comparison`, by its path (a rename's new path). A Comparison that lists only some of its files
 * cannot say the file is gone, so the draft stays as it is.
 */
export const comparedFile = (
  annotation: Pick<DiffAnnotation, "path">,
  comparison: Pick<Comparison, "files" | "more">,
): ComparedFile => {
  const entry = comparison.files.find((file) => file.path === annotation.path);

  if (entry !== undefined) return { kind: "file", entry };

  return comparison.more > 0 ? { kind: "unknown" } : { kind: "gone" };
};

/**
 * `annotation` after a check: moved, marked, or back in place. A quote found where it was, or moved, clears an earlier
 * mark and takes the HEAD of the repo's Changes now (or, for a draft on This branch, the pair of commits now
 * compared); a marked draft keeps its place, its quote and the HEAD or pair it was written against.
 */
export const checked = (
  annotation: DiffAnnotation,
  result: QuoteCheck | { readonly kind: "gone" },
  head: string | null,
  pair?: BranchPair,
): DiffAnnotation => {
  const { status: _status, ...rest } = annotation;

  const source =
    annotation.source.kind === "changes"
      ? { ...annotation.source, head }
      : annotation.source.kind === "branch" && pair !== undefined
        ? {
            ...annotation.source,
            branch: pair.branch,
            base: pair.base,
            mergeBase: pair.mergeBase,
            head: pair.head,
          }
        : annotation.source.kind === "pull" && pair !== undefined
          ? {
              ...annotation.source,
              title: pair.pull?.title ?? annotation.source.title,
              mergeBase: pair.mergeBase,
              head: pair.head,
            }
          : annotation.source;

  switch (result.kind) {
    case "same":
      return { ...rest, source };
    case "moved":
      return { ...rest, source, start: result.start, end: result.end };
    case "outdated":
      return { ...annotation, status: "outdated" };
    case "gone":
      return { ...annotation, status: "gone" };
  }
};
