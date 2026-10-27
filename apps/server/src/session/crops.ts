// A Review's crops (`docs/spec.md` → Diffs and review → Annotations and Reviews): each page Annotation's crop of the
// Pane's screen goes to the model as an image after the message's other parts, named by a line of text before it. They
// are fitted into what the message leaves: at most `MAX_REVIEW_CROPS` of them, within the base64 characters of
// `INLINE_IMAGE_BUDGET` the message's other images (the attached pages' screens, the Attachments' pictures) leave, and
// within the bytes of `MAX_STORED_INPUT_BYTES` its text and entry leave, in the Review's order; one that has no room is
// left out (its Annotation still goes, its block marked `crop` all the same), so no number of drafts makes a Review that
// the Session refuses for its crops.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over a draft's parts.
import {
  cropLabel,
  INLINE_IMAGE_BUDGET,
  MAX_REVIEW_CROPS,
  MAX_STORED_INPUT_BYTES,
  type PageCrop,
} from "@cloudpid/protocol";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/** A page Annotation's crop, by the number the Review gives the Annotation. */
export type ReviewCrop = { readonly number: number; readonly crop: PageCrop };

/** The parts that carry `crop`: the line that names its Annotation, then the image. */
export const cropParts = ({ number, crop }: ReviewCrop): [TextContent, ImageContent] => [
  { type: "text", text: cropLabel(number) },
  { type: "image", mimeType: crop.mimeType, data: crop.data },
];

/** What the entry's `crops` grows by for one more: a number and a comma, and its key once. */
const ENTRY_BYTES = 16;

/**
 * The crops of `crops` a message has room for, in order: one whose content and entry are `bytes` UTF-8 bytes of JSON,
 * with `images` base64 characters of images already.
 */
export const fitCrops = (
  crops: ReadonlyArray<ReviewCrop>,
  { bytes, images }: { readonly bytes: number; readonly images: number },
): ReviewCrop[] => {
  const kept: ReviewCrop[] = [];
  let bytesLeft = MAX_STORED_INPUT_BYTES - bytes;
  let imagesLeft = INLINE_IMAGE_BUDGET - images;

  for (const each of crops) {
    if (kept.length === MAX_REVIEW_CROPS) break;

    // Two more parts of the content array (ASCII: the label and base64), and the entry's number.
    const cost = JSON.stringify(cropParts(each)).length + ENTRY_BYTES;

    if (each.crop.data.length > imagesLeft || cost > bytesLeft) continue;

    kept.push(each);
    bytesLeft -= cost;
    imagesLeft -= each.crop.data.length;
  }

  return kept;
};
