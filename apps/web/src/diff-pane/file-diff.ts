// A changed file as `@pierre/diffs` draws it in the Diff pane: its lined-up patch over both whole sides (so unchanged
// lines can be expanded), named as the Pane shows it, or a placeholder with no lines while its contents are not loaded,
// cannot be shown, or the file is folded. Part of the Pane's lazy chunk.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, called from React.
import type { ChangeStatus } from "@cloudpid/protocol";
import { processFile, type ChangeTypes, type FileDiffMetadata } from "@pierre/diffs";

const CHANGE_TYPE: Readonly<Record<ChangeStatus, ChangeTypes>> = {
  added: "new",
  modified: "change",
  deleted: "deleted",
  renamed: "rename-changed",
};

/** What the Pane calls a file: its path, and a rename's old one, as shown (with the repo when grouped). */
export interface FileNames {
  readonly name: string;
  readonly prevName?: string | undefined;
  readonly status: ChangeStatus;
}

/** A file with no lines: what a header-only item draws. */
export const placeholderDiff = ({ name, prevName, status }: FileNames): FileDiffMetadata => {
  const diff: FileDiffMetadata = {
    name,
    type: CHANGE_TYPE[status],
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
    deletionCharacterCount: 0,
    additionCharacterCount: 0,
  };

  if (prevName !== undefined) diff.prevName = prevName;

  return diff;
};

/**
 * The file drawn from its `patch` (`line-up.ts`) over its whole sides (`null` for a side that does not exist), keyed by
 * `cacheKey` for the Worker Pool's cache; undefined when the patch holds no change to draw.
 */
export const fileDiffOf = ({
  names,
  oldText,
  newText,
  patch,
  cacheKey,
}: {
  readonly names: FileNames;
  readonly oldText: string | null;
  readonly newText: string | null;
  readonly patch: string;
  readonly cacheKey: string;
}): FileDiffMetadata | undefined => {
  const { name, prevName, status } = names;

  const diff = processFile(patch, {
    cacheKey,
    oldFile: { name: prevName ?? name, contents: oldText ?? "", cacheKey: `${cacheKey}:old` },
    newFile: { name, contents: newText ?? "", cacheKey: `${cacheKey}:new` },
  });

  if (diff === undefined || diff.hunks.length === 0) return undefined;

  // Named as the Pane shows the file, whatever the patch's headers say; a rename keeps its old name.
  diff.name = name;
  diff.type = CHANGE_TYPE[status];

  if (prevName === undefined) delete diff.prevName;
  else diff.prevName = prevName;

  return diff;
};
