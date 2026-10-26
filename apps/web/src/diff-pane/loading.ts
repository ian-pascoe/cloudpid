// How the Diff pane loads its files' contents (`docs/spec.md` → Diffs and review → Diff pane): `change_file` is asked
// only for unfolded files near the visible window, the ones in view first, at most 4 at a time; and how many workers
// the highlighting Worker Pool has.
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

type View = { readonly top: number; readonly bottom: number };

/** Whether any of `file` is in `view`. */
const inView = (file: PlacedFile, view: View): boolean =>
  file.top < view.bottom && file.bottom > view.top;

/** How far `file` is from `view`, in px: 0 when they touch or overlap. */
const distance = (file: PlacedFile, view: View): number =>
  Math.max(0, file.top - view.bottom, view.top - file.bottom);

/**
 * The files to ask for now: those `wanted` (unfolded, with contents still to load) within `margin` px of `view`,
 * nearest first, as many as `MAX_FILE_REQUESTS` leaves room for beside the `inFlight` ones.
 */
export const filesToLoad = ({
  placed,
  view,
  margin,
  wanted,
  inFlight,
}: {
  readonly placed: readonly PlacedFile[];
  readonly view: View;
  readonly margin: number;
  readonly wanted: (id: string) => boolean;
  readonly inFlight: number;
}): readonly string[] => {
  const room = MAX_FILE_REQUESTS - inFlight;

  if (room <= 0) return [];

  return placed
    .map((file, index) => ({ file, index, away: inView(file, view) ? -1 : distance(file, view) }))
    .filter(({ file, away }) => away <= margin && wanted(file.id))
    .sort((one, other) => one.away - other.away || one.index - other.index)
    .slice(0, room)
    .map(({ file }) => file.id);
};
