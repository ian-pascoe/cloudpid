// The owner's draft Annotations as the web app shows them (`docs/spec.md` → Diffs and review → Annotations and Reviews):
// which drafts sit on a diff, where in it, which go to a composer, and what a chip and a lane say of them. Pure.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over the Session's arrays.

import {
  type Annotation,
  type AnnotationDraft,
  type AnnotationStatus,
  type ConversationId,
  type DiffAnnotation,
  type DiffAnnotationDraft,
  type DiffSource,
  fileName,
  isDiffAnnotation,
  isPageAnnotation,
  type PageSource,
  rangeLabel,
  reviewTitle,
  sameSource,
  type ShownReviewAnnotation,
} from "@cloudpid/protocol";
import type { DiffLineAnnotation } from "@pierre/diffs";
import type * as Types from "effect/Types";
import { librarySide, type PickedLines } from "./selection.ts";

/**
 * A diff drafts are drawn on: where it comes from (a call, or a repo's Changes) and the file, and the conversation its
 * drafts go to (a subagent's, for its own calls; the active branch's when absent).
 */
export interface DiffAnchor {
  readonly source: DiffSource;
  readonly path: string;
  readonly oldPath?: string | undefined;
  readonly conversationId?: number | undefined;
}

/**
 * The drafts on `anchor`'s diff: of the same call, whose diff is of one file (its path made absolute by the Session), or
 * of the same repo's Changes and file.
 */
export const draftsOn = (
  annotations: readonly Annotation[],
  anchor: Pick<DiffAnchor, "source" | "path">,
): readonly DiffAnnotation[] =>
  annotations
    .filter(isDiffAnnotation)
    .filter(
      (draft) =>
        sameSource(draft.source, anchor.source) &&
        (anchor.source.kind === "call" || draft.path === anchor.path),
    );

/** The drafts the composer of `conversationId` sends (the active branch's when undefined), oldest first. */
export const draftsTo = (
  annotations: readonly Annotation[],
  conversationId: number | undefined,
): readonly Annotation[] => annotations.filter((draft) => draft.conversationId === conversationId);

/** A diff's drafts, and where they show in it. */
export interface DiffDrafts {
  readonly drafts: readonly DiffAnnotation[];
  readonly lineAnnotations: DiffLineAnnotation<AnnotationSlot>[];
}

/**
 * The drafts of one diff of a view (`diff`: the Pane's file ID, or a card's one diff) on `anchor`, and where they show,
 * with the editor of a new draft when the view's editor (`open`) is open in that diff. Undefined `anchor`: none.
 */
export const diffDrafts = (
  annotations: readonly Annotation[],
  anchor: DiffAnchor | undefined,
  open: { readonly diff: string | null; readonly picked: PickedLines | null },
  diff: string,
): DiffDrafts => {
  const drafts = anchor === undefined ? [] : draftsOn(annotations, anchor);

  return {
    drafts,
    lineAnnotations: lineAnnotationsOf(drafts, open.diff === diff ? open.picked : null),
  };
};

/** What a line annotation of a diff holds: a draft, by its ID, or the editor of a new one. */
export type AnnotationSlot =
  | { readonly kind: "draft"; readonly id: string }
  | { readonly kind: "new" };

/**
 * Where `drafts` show in their diff: each under its last line, on its side, then the editor of a new draft under the
 * lines it was opened on.
 */
export const lineAnnotationsOf = (
  drafts: readonly DiffAnnotation[],
  editing: PickedLines | null,
): DiffLineAnnotation<AnnotationSlot>[] => {
  const shown: DiffLineAnnotation<AnnotationSlot>[] = drafts.map((draft) => ({
    side: librarySide(draft.side),
    lineNumber: draft.end,
    metadata: { kind: "draft", id: draft.id },
  }));

  if (editing !== null) {
    shown.push({
      side: librarySide(editing.side),
      lineNumber: editing.end,
      metadata: { kind: "new" },
    });
  }

  return shown;
};

/** A new draft of `picked` on `anchor`'s diff, with the owner's `text`. */
export const newDraft = (
  id: string,
  anchor: DiffAnchor,
  picked: PickedLines,
  text: string,
): DiffAnnotationDraft => {
  const draft: Types.Mutable<DiffAnnotationDraft> = {
    id,
    source: anchor.source,
    path: anchor.path,
    side: picked.side,
    start: picked.start,
    end: picked.end,
    quote: picked.quote,
    more: picked.more,
    text,
  };

  if (anchor.oldPath !== undefined && anchor.oldPath !== anchor.path)
    draft.oldPath = anchor.oldPath;

  if (anchor.conversationId !== undefined) {
    // SAFETY: a subagent's conversation the Session named.
    draft.conversationId = anchor.conversationId as ConversationId;
  }

  if (picked.clipped === true) draft.clipped = true;

  return draft;
};

/** `draft` as saved again with new `text`: the Session keeps everything else it had. */
export const editedDraft = (draft: Annotation, text: string): AnnotationDraft => {
  if (isPageAnnotation(draft)) {
    const { createdAt: _created, updatedAt: _updated, ...rest } = draft;

    return { ...rest, text };
  }

  const { createdAt: _created, updatedAt: _updated, status: _status, ...rest } = draft;

  return { ...rest, text };
};

/** A page's address as a chip names it: its host and path, without the scheme or query. */
export const pageAddress = (url: string): string => {
  if (!URL.canParse(url)) return url;

  const { host, pathname } = new URL(url);

  return pathname === "/" ? host : `${host}${pathname}`;
};

/**
 * What a page Annotation is on, as everything that shows one names it (its chip, its pin, its editor): its element's tag,
 * as `<button>`, or an area.
 */
export const pageTarget = (source: Pick<PageSource, "element">): string =>
  source.element === undefined ? "An area" : `<${source.element.tag}>`;

/**
 * What a chip names a draft by: on a diff, its file's name and range, as `a.ts:12–18`; on a page, what it is on and the
 * page, as `<button> · app.test/login`.
 */
export const chipLabel = (annotation: Annotation | ShownReviewAnnotation): string =>
  isPageAnnotation(annotation)
    ? `${pageTarget(annotation.source)} · ${pageAddress(annotation.source.url)}`
    : `${fileName(annotation.path)}:${rangeLabel(annotation)}`;

/** What a draft's mark says: its lines changed since, or its file left the Changes. */
export const statusLabel = (draft: {
  readonly status?: AnnotationStatus | undefined;
}): string | undefined => {
  switch (draft.status) {
    case "outdated":
      return "Outdated";
    case "gone":
      return "No longer in the diff";
    case undefined:
      return undefined;
  }
};

/** What a lane shows of a Review: the summary, then how many Annotations it sends. */
export const reviewLaneText = (display: string, count: number): string => {
  const text = display.trim();

  return text === "" ? reviewTitle(count) : `${text} · ${reviewTitle(count)}`;
};
