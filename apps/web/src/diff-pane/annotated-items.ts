// The Diff pane's items with their files' drafts on them (`docs/spec.md` → Diffs and review → Annotations and Reviews):
// each item takes the line annotations of its file, and an item whose annotations moved is a new object with a higher
// version, so the library draws them again; one whose item and annotations are as before is the same object. Part of
// the Pane's lazy chunk.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over values, over native arrays and maps.

import type { RepoChanges } from "@cloudpid/protocol";
import type { CodeViewDiffItem, DiffLineAnnotation } from "@pierre/diffs";
import type { AnnotationSlot, DiffAnchor } from "../review/drafts.ts";
import type { PaneFile } from "./pane-files.ts";

export type AnnotatedItem = CodeViewDiffItem<AnnotationSlot>;

/** One annotated item, with what it was made from: the plain item, and its annotations' places. */
interface Made {
  readonly base: CodeViewDiffItem<undefined>;
  readonly places: string;
  readonly item: AnnotatedItem;
}

/** The items as last annotated, by file ID. */
export type Annotated = ReadonlyMap<string, Made>;

/**
 * What drafts on `file` anchor to: its repo's Changes at the HEAD listed, and its path in the repo (a rename's new one,
 * with the old). They go to the active branch's composer.
 */
export const paneAnchor = (file: PaneFile, repos: readonly RepoChanges[]): DiffAnchor => ({
  source: {
    kind: "changes",
    repo: file.repo,
    head: repos.find((repo) => repo.repo === file.repo)?.head.commit ?? null,
  },
  path: file.entry.path,
  oldPath: file.entry.oldPath,
});

/** Where annotations sit, as one string: two lists that say the same compare equal. */
const placesOf = (annotations: readonly DiffLineAnnotation<AnnotationSlot>[]): string =>
  annotations
    .map(
      ({ side, lineNumber, metadata }) =>
        `${side}:${lineNumber}:${metadata.kind === "draft" ? metadata.id : "new"}`,
    )
    .join("|");

/** `items` with the annotations `annotationsOf` gives each, reusing what `before` made that is the same. */
export const annotatedItems = (
  items: readonly CodeViewDiffItem<undefined>[],
  annotationsOf: (id: string) => readonly DiffLineAnnotation<AnnotationSlot>[],
  before: Annotated,
): Annotated =>
  new Map(
    items.map((base) => {
      const annotations = annotationsOf(base.id);
      const places = placesOf(annotations);
      const previous = before.get(base.id);

      if (previous !== undefined && previous.base === base && previous.places === places) {
        return [base.id, previous];
      }

      // A plain item with no annotations is drawn as it is.
      const { annotations: _none, ...rest } = base;

      const item: AnnotatedItem = {
        ...rest,
        annotations: [...annotations],
        version: Math.max(base.version ?? 0, previous?.item.version ?? 0) + 1,
      };

      return [base.id, { base, places, item }];
    }),
  );
