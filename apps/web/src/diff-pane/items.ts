// The Diff pane's files as `CodeView` items: a loaded file draws its diff, any other its header alone (a placeholder
// with no lines). An item whose drawing did not change is the same object, with the same version, as before, so the
// library leaves it as it is. Part of the Pane's lazy chunk.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over values, over native arrays and maps.

import type { CodeViewDiffItem, FileDiffMetadata } from "@pierre/diffs";
import { placeholderDiff, type FileNames } from "./file-diff.ts";
import type { Loads } from "./loader.ts";
import type { PaneFile } from "./pane-files.ts";

/** The items, by file ID, as last built. */
export type Items = ReadonlyMap<string, CodeViewDiffItem<undefined>>;

/** The header-only drawing of `names`: `before`'s when it is one with the same names, so the item stays as it is. */
const placeholderFor = (names: FileNames, before: FileDiffMetadata | undefined) => {
  const placeholder = placeholderDiff(names);

  return before !== undefined &&
    before.hunks.length === 0 &&
    before.name === placeholder.name &&
    before.prevName === placeholder.prevName &&
    before.type === placeholder.type
    ? before
    : placeholder;
};

/** The items of `files`, reusing those of `before` whose drawing is the same. */
export const itemsOf = (
  files: readonly PaneFile[],
  folded: ReadonlySet<string>,
  loads: Loads,
  before: Items,
): Items =>
  new Map(
    files.map((file) => {
      const contents = loads.loaded.get(file.id)?.contents;
      const ready = contents?.kind === "ready" ? contents.diff : undefined;
      const previous = before.get(file.id);
      // A file with no lines to draw stays header-only, whatever its fold says.
      const collapsed = folded.has(file.id) || ready === undefined;

      const fileDiff = ready ?? placeholderFor(file.names, previous?.fileDiff);

      if (
        previous !== undefined &&
        previous.fileDiff === fileDiff &&
        previous.collapsed === collapsed
      ) {
        return [file.id, previous];
      }

      return [
        file.id,
        {
          id: file.id,
          type: "diff",
          fileDiff,
          collapsed,
          version: (previous?.version ?? 0) + 1,
        },
      ];
    }),
  );
