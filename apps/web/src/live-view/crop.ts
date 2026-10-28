// @effect-diagnostics missingPipeableSignature:off -- plain functions of sizes, and a canvas.

// The crop a page Annotation carries (#243; `docs/architecture/browser.md` → Annotate mode): the spot picked, cut from the
// Pane's last frame of the page (never a new screenshot of the tab, which the agent's browser would take), with a margin,
// as a JPEG of at most `MAX_ANNOTATION_CROP` base64 characters. That bound is what lets 100 drafts' crops fit one
// message: coarser first, then smaller, until it fits; a spot that fits at no size has no crop.

import { MAX_ANNOTATION_CROP, type PageCrop, type PageRect } from "@cloudpid/protocol";
import { fitLongEdge } from "../chat/image-budget.ts";
import type { FrameMeta } from "./viewport.ts";

/** The margin kept around the spot, in the page's CSS px. */
const MARGIN = 8;

/** The longest edge a crop starts at, in px: a model sees no more detail in a spot than this. */
const MAX_EDGE = 640;

/** The shortest edge a crop is made down to before it is given up. */
const MIN_EDGE = 24;

/** The qualities tried at each size, best first. */
const QUALITIES = [0.8, 0.6, 0.45];

/** How much smaller each next size is. */
const SHRINK = 0.7;

/** Where in the frame's image a spot is, in its pixels, and the size it is drawn at. */
export interface CropRegion {
  readonly sx: number;
  readonly sy: number;
  readonly sw: number;
  readonly sh: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The part of a frame's image (of `image`'s pixels, showing the tab as `meta` says) that shows `rect` of the viewport,
 * with a margin and within the image, and the size it is drawn at: its own, or less so the longer edge is `MAX_EDGE`.
 * Undefined when none of it is in the frame.
 */
export const cropRegion = (
  rect: PageRect,
  meta: FrameMeta,
  image: { readonly width: number; readonly height: number },
): CropRegion | undefined => {
  const scale = image.width / Math.max(1, meta.deviceWidth);
  const left = Math.max(0, Math.floor((rect.x - MARGIN) * scale));
  const top = Math.max(0, Math.floor((rect.y + meta.offsetTop - MARGIN) * scale));
  const right = Math.min(image.width, Math.ceil((rect.x + rect.width + MARGIN) * scale));

  const bottom = Math.min(
    image.height,
    Math.ceil((rect.y + meta.offsetTop + rect.height + MARGIN) * scale),
  );

  if (right - left < 1 || bottom - top < 1) return undefined;

  const sw = right - left;
  const sh = bottom - top;

  return { sx: left, sy: top, sw, sh, ...fitLongEdge(sw, sh, MAX_EDGE) };
};

/**
 * The first encoding (`encode`: a data URL of the crop at a size and a JPEG quality) whose base64 fits
 * `MAX_ANNOTATION_CROP`: each quality at the region's size, then at sizes `SHRINK` times smaller, down to `MIN_EDGE`.
 */
export const fittedCrop = (
  size: { readonly width: number; readonly height: number },
  encode: (width: number, height: number, quality: number) => string,
): PageCrop | undefined => {
  let width = size.width;
  let height = size.height;

  for (;;) {
    for (const quality of QUALITIES) {
      const url = encode(width, height, quality);
      const data = url.slice(url.indexOf(",") + 1);

      if (
        url.startsWith("data:image/jpeg;base64,") &&
        data.length > 0 &&
        data.length <= MAX_ANNOTATION_CROP
      ) {
        return { mimeType: "image/jpeg", data };
      }
    }

    if (Math.min(width, height) * SHRINK < MIN_EDGE) return undefined;

    width = Math.round(width * SHRINK);
    height = Math.round(height * SHRINK);
  }
};

/** The crop of `rect` from `image`, the frame last drawn of the tab `meta` describes; undefined when none fits. */
export const cropFrame = (
  image: HTMLImageElement,
  meta: FrameMeta,
  rect: PageRect,
): PageCrop | undefined => {
  if (image.naturalWidth === 0 || image.naturalHeight === 0) return undefined;

  const region = cropRegion(rect, meta, { width: image.naturalWidth, height: image.naturalHeight });

  if (region === undefined) return undefined;

  const canvas = document.createElement("canvas");

  return fittedCrop(region, (width, height, quality) => {
    canvas.width = width;
    canvas.height = height;
    canvas
      .getContext("2d")
      ?.drawImage(image, region.sx, region.sy, region.sw, region.sh, 0, 0, width, height);

    return canvas.toDataURL("image/jpeg", quality);
  });
};
