// How the Diff pane loads its files' contents (`docs/spec.md` → Diffs and review → Diff pane): `change_file` is asked
// only for unfolded files near the visible window, the ones in view first, at most 4 at a time (the loader, `loader.ts`,
// runs them); a file is asked for again when a new list says its change is not the same, or, while it is in view, when it
// was loaded from an older list; and how many workers the highlighting Worker Pool has.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over values, called from React, over native arrays.

/** The most `change_file` requests out at once. */
export const MAX_FILE_REQUESTS = 4;

/** The Worker Pool's size: half the cores (`navigator.hardwareConcurrency`), kept between 2 and 4. */
export const poolSize = (cores: number | undefined): number =>
  Math.min(4, Math.max(2, Math.floor((cores ?? 0) / 2)));

/** Where a file sits in the scroll, in px from the top of its content. */
export interface PlacedFile {
  readonly id: string;
  readonly top: number;
  readonly bottom: number;
}

/** The part of the scroll that shows, in px from the top of its content. */
export interface View {
  readonly top: number;
  readonly bottom: number;
}

/** A file near the view, and whether any of it shows. */
export interface NearFile {
  readonly id: string;
  readonly inView: boolean;
}

/** Whether any of `file` is in `view`. */
const isInView = (file: PlacedFile, view: View): boolean =>
  file.top < view.bottom && file.bottom > view.top;

/** How far `file` is from `view`, in px: 0 when they touch or overlap. */
const distance = (file: PlacedFile, view: View): number =>
  Math.max(0, file.top - view.bottom, view.top - file.bottom);

/** The files within `margin` px of `view`: those in view first, top to bottom, then the rest, nearest first. */
export const filesNear = ({
  placed,
  view,
  margin,
}: {
  readonly placed: readonly PlacedFile[];
  readonly view: View;
  readonly margin: number;
}): readonly NearFile[] =>
  placed
    .map((file, index) => ({ file, index, away: isInView(file, view) ? -1 : distance(file, view) }))
    .filter(({ away }) => away <= margin)
    .sort((one, other) => one.away - other.away || one.index - other.index)
    .map(({ file, away }) => ({ id: file.id, inView: away < 0 }));

/** Which change a file's contents were loaded for (`entrySignature`), and from which list. */
export interface LoadedFrom {
  readonly signature: string;
  readonly listing: number;
}

/** A file the Pane wants loaded: its change in the current list, and whether it is in view. */
export interface WantedFrom extends LoadedFrom {
  readonly inView: boolean;
}

/**
 * Whether a file must be asked for: never loaded, or loaded for another change; or, in view, loaded from an older list
 * (a change can keep its counts while its text changes, and only the file in view is worth the request).
 */
export const needsLoad = (loaded: LoadedFrom | undefined, wanted: WantedFrom): boolean =>
  loaded === undefined ||
  loaded.signature !== wanted.signature ||
  (wanted.inView && loaded.listing < wanted.listing);
