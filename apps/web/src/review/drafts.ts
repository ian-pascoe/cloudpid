// The owner's draft Annotations as the web app shows them (`docs/spec.md` → Diffs and review → Annotations and Reviews):
// which drafts sit on a diff, where in it, which go to a composer, and what a chip and a lane say of them. Pure.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over the Session's arrays.

import {
  type Annotation,
  type AnnotationDraft,
  type AnnotationSource,
  type AnnotationStatus,
  type ConversationId,
  fileName,
  rangeLabel,
  reviewTitle,
  sameSource,
} from "@cloudpid/protocol";
import type { DiffLineAnnotation } from "@pierre/diffs";
import type * as Types from "effect/Types";
import { librarySide, type PickedLines } from "./selection.ts";

/**
 * A diff drafts are drawn on: where it comes from (a call, or a repo's Changes) and the file, and the conversation its
 * drafts go to (a subagent's, for its own calls; the active branch's when absent).
 */
export interface DiffAnchor {
  readonly source: AnnotationSource;
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
): readonly Annotation[] =>
  annotations.filter(
    (draft) =>
      sameSource(draft.source, anchor.source) &&
      (anchor.source.kind === "call" || draft.path === anchor.path),
  );

/** The drafts the composer of `conversationId` sends (the active branch's when undefined), oldest first. */
export const draftsTo = (
  annotations: readonly Annotation[],
  conversationId: number | undefined,
): readonly Annotation[] => annotations.filter((draft) => draft.conversationId === conversationId);

/** What a line annotation of a diff holds: a draft, by its ID, or the editor of a new one. */
export type AnnotationSlot = { readonly kind: "draft"; readonly id: string } | { readonly kind: "new" };

/**
 * Where `drafts` show in their diff: each under its last line, on its side, then the editor of a new draft under the
 * lines it was opened on.
 */
export const lineAnnotationsOf = (
  drafts: readonly Annotation[],
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
): AnnotationDraft => {
  const draft: Types.Mutable<AnnotationDraft> = {
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

  if (anchor.oldPath !== undefined && anchor.oldPath !== anchor.path) draft.oldPath = anchor.oldPath;

  if (anchor.conversationId !== undefined) {
    // SAFETY: a subagent's conversation the Session named.
    draft.conversationId = anchor.conversationId as ConversationId;
  }

  if (picked.clipped === true) draft.clipped = true;

  return draft;
};

/** `draft` as saved again with new `text`: the Session keeps everything else it had. */
export const editedDraft = (draft: Annotation, text: string): AnnotationDraft => {
  const { createdAt: _created, updatedAt: _updated, status: _status, ...rest } = draft;

  return { ...rest, text };
};

/** What a chip names a draft by: its file's name and range, as `a.ts:12–18`. */
export const chipLabel = (draft: Pick<Annotation, "path" | "start" | "end">): string =>
  `${fileName(draft.path)}:${rangeLabel(draft)}`;

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
