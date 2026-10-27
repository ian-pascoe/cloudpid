// A Review (GLOSSARY.md → Review; `docs/spec.md` → Diffs and review → Annotations and Reviews): the owner's drafts sent
// together as one message. The model gets Markdown, after the owner's summary; the `cloudpid.user` entry's data keeps
// where each Annotation's quote and text sit in that Markdown, so the transcript's Review card shows them without the
// entry holding them twice (at the limits, twice would not fit one stored message).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions building and reading text.
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import {
  type Annotation,
  annotationPath,
  AnnotationSide,
  AnnotationSource,
  AnnotationStatus,
} from "./annotations.ts";

/** Where a piece of text sits in the Review's Markdown: from, and up to, in UTF-16 code units. */
const Span = Schema.Tuple([Schema.Int, Schema.Int]);

/** An Annotation as a sent Review keeps it: its anchor and range, and where its quote and text sit in the Markdown. */
export const ReviewAnnotation = Schema.Struct({
  source: AnnotationSource,
  path: Schema.String,
  oldPath: Schema.optionalKey(Schema.String),
  side: AnnotationSide,
  start: Schema.Int,
  end: Schema.Int,
  more: Schema.Int,
  clipped: Schema.optionalKey(Schema.Boolean),
  status: Schema.optionalKey(AnnotationStatus),
  quote: Span,
  text: Span,
});

export type ReviewAnnotation = typeof ReviewAnnotation.Type;

/** A `cloudpid.user` entry's `review`: the Annotations in the order the Markdown numbers them, and its length. */
export const ReviewData = Schema.Struct({
  /** How long the Review's Markdown is: it ends the model message's first text. */
  length: Schema.Int,
  annotations: Schema.Array(ReviewAnnotation),
});

export type ReviewData = typeof ReviewData.Type;

/** A sent Annotation as the Review card shows it: its anchor and range, with its quote and the owner's text. */
export type ShownReviewAnnotation = Omit<ReviewAnnotation, "quote" | "text"> & {
  /** The absolute path. */
  readonly file: string;
  readonly quote: readonly string[];
  readonly text: string;
};

/** The fence language of the files the agent reads most, by extension. */
const LANGUAGES = new Map<string, string>(Record.toEntries({
  ts: "ts",
  tsx: "tsx",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  json: "json",
  jsonc: "jsonc",
  md: "md",
  mdx: "mdx",
  css: "css",
  scss: "scss",
  html: "html",
  vue: "vue",
  svelte: "svelte",
  py: "python",
  rb: "ruby",
  rs: "rust",
  go: "go",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "sh",
  bash: "bash",
  zsh: "zsh",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  graphql: "graphql",
  proto: "proto",
  tf: "hcl",
}));

/** The language a fence of `path`'s lines is named by; empty when none is known. */
export const languageOf = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);

  if (name === "Dockerfile") return "dockerfile";

  if (name === "Makefile") return "makefile";

  const dot = name.lastIndexOf(".");

  return dot <= 0 ? "" : (LANGUAGES.get(name.slice(dot + 1).toLowerCase()) ?? "");
};

/** "lines 12–18", "line 12", or "removed lines 10–12" on the old side. */
export const rangeText = (annotation: Pick<Annotation, "side" | "start" | "end">): string => {
  const lines =
    annotation.start === annotation.end
      ? `line ${annotation.start}`
      : `lines ${annotation.start}–${annotation.end}`;

  return annotation.side === "old" ? `removed ${lines}` : lines;
};

/** The source an Annotation was drawn on, as one group of the Review. */
const groupKey = (annotation: Annotation): string =>
  annotation.source.kind === "changes"
    ? `changes:${annotation.source.repo}`
    : `call:${annotation.source.conversationId}:${annotation.source.callId}:${annotation.source.nested ?? ""}`;

/** The heading of a source's group. */
const groupHeading = (annotation: Annotation): string =>
  annotation.source.kind === "changes"
    ? `Uncommitted Changes in \`${annotation.source.repo}\``
    : `Your \`${annotation.source.tool}\` call on \`${annotationPath(annotation)}\`: lines as of that call`;

/** A fence longer than any run of backticks in `lines`. */
const fenceFor = (lines: readonly string[]): string => {
  let longest = 0;

  for (const line of lines) {
    for (const run of line.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  }

  return "`".repeat(Math.max(3, longest + 1));
};

/** What follows a quote that leaves something out. */
const leftOut = (annotation: Annotation): string | undefined => {
  if (annotation.more > 0) {
    return `… ${annotation.more} more ${annotation.more === 1 ? "line" : "lines"}`;
  }

  return annotation.clipped === true ? "… the line goes on" : undefined;
};

/** What an Annotation that its last check moved away from says. */
const statusText = (annotation: Annotation): string | undefined => {
  switch (annotation.status) {
    case "outdated":
      return "These lines have changed since.";
    case "gone":
      return "These lines are no longer in the diff.";
    case undefined:
      return undefined;
  }
};

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The groups of a Review: the Changes first, by repo, then the Call diffs, in the order of their first draft; within
 * each, its Annotations by file, then line (removed lines first where both sides start at one).
 */
const ordered = (annotations: readonly Annotation[]): Annotation[][] => {
  const groups = new Map<string, Annotation[]>();

  for (const annotation of annotations) {
    const key = groupKey(annotation);

    groups.set(key, [...(groups.get(key) ?? []), annotation]);
  }

  const first = (group: readonly Annotation[]) => Math.min(...group.map((each) => each.createdAt));

  return [...groups.values()]
    .map((group) =>
      group.toSorted(
        (a, b) =>
          compareText(a.path, b.path) ||
          a.start - b.start ||
          compareText(a.side, b.side) ||
          a.end - b.end,
      ),
    )
    .toSorted((a, b) => {
      const [x, y] = [a[0], b[0]];

      if (x === undefined || y === undefined) return 0;

      if (x.source.kind !== y.source.kind) return x.source.kind === "changes" ? -1 : 1;

      return x.source.kind === "changes" && y.source.kind === "changes"
        ? compareText(x.source.repo, y.source.repo)
        : first(a) - first(b);
    });
};

/** The heading a Review's Markdown starts with: `Review: n Annotations`. */
export const reviewTitle = (count: number): string =>
  `Review: ${count} ${count === 1 ? "Annotation" : "Annotations"}`;

/**
 * The Markdown the model gets for `annotations` (after the owner's summary, which the Session puts first), and the data
 * the Review's entry keeps. The Annotations are grouped by source, then file, then line, and numbered, so the agent can
 * refer to "Annotation 2". Each names its absolute path and range, quotes its lines in a fence named by the file's
 * language, and gives the owner's text; one whose lines have changed since says so.
 */
export type RenderedReview = { readonly markdown: string; readonly data: ReviewData };

export const renderReview = (annotations: readonly Annotation[]): RenderedReview => {
  let markdown = `## ${reviewTitle(annotations.length)}`;
  const sent: ReviewAnnotation[] = [];
  let number = 0;

  const add = (text: string): readonly [number, number] => {
    const from = markdown.length;

    markdown += text;

    return [from, markdown.length];
  };

  for (const group of ordered(annotations)) {
    const [head] = group;

    if (head === undefined) continue;

    markdown += `\n\n### ${groupHeading(head)}`;

    for (const annotation of group) {
      number += 1;

      const fence = fenceFor(annotation.quote);

      markdown += `\n\n**Annotation ${number}**: \`${annotationPath(annotation)}\`, ${rangeText(annotation)}`;

      if (annotation.oldPath !== undefined) markdown += ` (renamed from \`${annotation.oldPath}\`)`;

      markdown += `\n\n${fence}${languageOf(annotation.path)}\n`;

      const quote = add(annotation.quote.join("\n"));

      markdown += `\n${fence}`;

      const after = leftOut(annotation);

      if (after !== undefined) markdown += `\n${after}`;

      const status = statusText(annotation);

      if (status !== undefined) markdown += `\n\n${status}`;

      markdown += "\n\n";

      const text = add(annotation.text);

      const item: Types.Mutable<ReviewAnnotation> = {
        source: annotation.source,
        path: annotation.path,
        side: annotation.side,
        start: annotation.start,
        end: annotation.end,
        more: annotation.more,
        quote,
        text,
      };

      if (annotation.oldPath !== undefined) item.oldPath = annotation.oldPath;

      if (annotation.clipped === true) item.clipped = true;

      if (annotation.status !== undefined) item.status = annotation.status;

      sent.push(item);
    }
  }

  return { markdown, data: { length: markdown.length, annotations: sent } };
};

/** The model message's text for a Review: the summary the owner typed (expanded), then the Review's Markdown. */
export const reviewMessage = (summary: string, markdown: string): string =>
  summary.trim() === "" ? markdown : `${summary}\n\n${markdown}`;

/**
 * The Annotations of a sent Review as its card shows them, read from `text` (the model message's first text, which the
 * Review's Markdown ends) by where `data` says each quote and text sit. A text the data does not fit shows none.
 */
export const shownReview = (
  text: string,
  data: ReviewData,
): ReadonlyArray<ShownReviewAnnotation> => {
  const markdown = text.length >= data.length ? text.slice(text.length - data.length) : "";

  const slice = ([from, to]: readonly [number, number]) =>
    from >= 0 && to >= from && to <= markdown.length ? markdown.slice(from, to) : undefined;

  return data.annotations.map(({ quote, text: said, ...rest }) => ({
    ...rest,
    file: annotationPath(rest),
    quote: slice(quote)?.split("\n") ?? [],
    text: slice(said) ?? "",
  }));
};
