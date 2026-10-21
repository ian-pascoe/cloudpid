// Fitting a message's inline images into what one message may hold (`docs/spec.md` → Client and protocol →
// Attachments): every attached image goes to the model downscaled to a 1568 px long edge and re-encoded, at one quality
// for all of them, the best at which they share `INLINE_IMAGE_BUDGET` base64 characters. When even the lowest quality
// does not fit, the largest image goes as a file only, and the rest are fitted again. The encoder is injected, so the
// fitting runs under Node with a fake one; `image-encode.ts` is the browser's.

// @effect-diagnostics asyncFunction:off missingPipeableSignature:off preferEffectArray:off -- browser code with no Effect runtime: native arrays and promises.

import { INLINE_IMAGE_BUDGET } from "@cloudpid/protocol";

/** The longest edge an image is sent to the model at: larger ones are scaled down (providers would scale them anyway). */
export const MAX_IMAGE_EDGE = 1568;

/** The qualities tried, best first. A lossless encoding (PNG) ignores them and is the same size at each. */
export const QUALITIES: readonly number[] = [0.85, 0.72, 0.6, 0.48, 0.36];

/** An image encoded for the model: its type, and its bytes in base64. */
export type Encoded = { readonly mimeType: string; readonly data: string };

/** Encode `image` at `quality` (0–1). */
export type Encoder<Image> = (image: Image, quality: number) => Promise<Encoded>;

/** What becomes of one image: it goes inline as `encoded`, or as a file only, for `reason`. */
export type Fit =
  | { readonly kind: "inline"; readonly encoded: Encoded }
  | { readonly kind: "file"; readonly reason: string };

const TOO_BIG = "Too big to show the model; it goes as a file only.";

const TOO_BIG_TOGETHER = "No room beside the other images; it goes as a file only.";

/** An image's size in pixels. */
export type Size = { readonly width: number; readonly height: number };

/** `width` × `height` scaled so the long edge is at most `edge`, never enlarged, each side at least 1 px. */
export const fitLongEdge = (width: number, height: number, edge: number = MAX_IMAGE_EDGE): Size => {
  const scale = Math.min(1, edge / Math.max(width, height));

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

/**
 * Fit `images` into `budget` base64 characters with `encode`, in order: each one's `Fit`. Each image is encoded at most
 * once per quality.
 */
export const fitImages = async <Image>(
  images: readonly Image[],
  encode: Encoder<Image>,
  budget: number = INLINE_IMAGE_BUDGET,
): Promise<Fit[]> => {
  const encodings = images.map(() => new Map<number, Encoded>());

  const at = async (index: number, quality: number): Promise<Encoded> => {
    const known = encodings[index]?.get(quality);

    if (known !== undefined) return known;

    const image = images[index];

    if (image === undefined) throw new Error(`No image ${index}`);

    const encoded = await encode(image, quality);

    encodings[index]?.set(quality, encoded);

    return encoded;
  };

  /** The total size of `indexes` at `quality`; one at a time, as each encoding holds a canvas in the browser. */
  const total = async (indexes: readonly number[], quality: number): Promise<number> => {
    let sum = 0;

    for (const index of indexes) sum += (await at(index, quality)).data.length;

    return sum;
  };

  const lowest = QUALITIES.at(-1) ?? 0;
  const fits: Array<Fit | undefined> = images.map(() => undefined);
  let kept = images.map((_, index) => index);

  while (kept.length > 0) {
    for (const quality of QUALITIES) {
      if ((await total(kept, quality)) <= budget) {
        for (const index of kept)
          fits[index] = { kind: "inline", encoded: await at(index, quality) };

        return fits.map((fit) => fit ?? { kind: "file", reason: TOO_BIG });
      }
    }

    // Even the lowest quality is over: the largest image there goes as a file, and the rest are fitted again.
    let largest = kept[0] ?? 0;
    let largestSize = -1;

    for (const index of kept) {
      const size = (await at(index, lowest)).data.length;

      if (size >= largestSize) {
        largest = index;
        largestSize = size;
      }
    }

    fits[largest] = { kind: "file", reason: largestSize > budget ? TOO_BIG : TOO_BIG_TOGETHER };
    kept = kept.filter((index) => index !== largest);
  }

  return fits.map((fit) => fit ?? { kind: "file", reason: TOO_BIG });
};
