// Fitting a message's inline images into what one message may hold (`docs/architecture/client-and-protocol.md` →
// Attachments): every attached image goes to the model downscaled to a 1568 px long edge and re-encoded, at one quality
// for all of them, the best at which they share `INLINE_IMAGE_BUDGET` base64 characters. When even the lowest quality
// does not fit, the largest image goes as a file only, and the rest are fitted again; so does one that fails to encode.
// The encoder is injected as an Effect, so the fitting runs under Node with a fake one; `image-encode.ts` is the
// browser's.

// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- bookkeeping over native arrays and maps, mutated in place one encoding at a time.

import { INLINE_IMAGE_BUDGET } from "@cloudpid/protocol";
import * as Effect from "effect/Effect";

/** The longest edge an image is sent to the model at: larger ones are scaled down (providers would scale them anyway). */
export const MAX_IMAGE_EDGE = 1568;

/** The qualities tried, best first. A lossless encoding (PNG) ignores them and is the same size at each. */
export const QUALITIES: readonly number[] = [0.85, 0.72, 0.6, 0.48, 0.36];

/** An image encoded for the model: its type, and its bytes in base64. */
export type Encoded = { readonly mimeType: string; readonly data: string };

/** Encode `image` at `quality` (0–1); a failure sends it as a file only. */
export type Encoder<Image, E> = (image: Image, quality: number) => Effect.Effect<Encoded, E>;

/** What becomes of one image: it goes inline as `encoded`, or as a file only, for `reason`. */
export type Fit =
  | { readonly kind: "inline"; readonly encoded: Encoded }
  | { readonly kind: "file"; readonly reason: string };

const TOO_BIG = "Too big to show the model; it goes as a file only.";

const TOO_BIG_TOGETHER = "No room beside the other images; it goes as a file only.";

/** Why an image that could not be encoded goes as a file only. */
export const UNPREPARED = "The image could not be prepared for the model; it goes as a file only.";

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
 * once per quality, one at a time, as each encoding holds a canvas in the browser; one whose encoding fails goes as a
 * file only, and the others are fitted without it.
 */
export const fitImages = <Image, E>(
  images: readonly Image[],
  encode: Encoder<Image, E>,
  budget: number = INLINE_IMAGE_BUDGET,
): Effect.Effect<Fit[]> =>
  Effect.gen(function* () {
    const encodings = images.map(() => new Map<number, Encoded>());
    const fits: Array<Fit | undefined> = images.map(() => undefined);
    let kept = images.map((_, index) => index);

    /** Image `index` at `quality`; undefined when it cannot be encoded, which sends it as a file only. */
    const at = (index: number, quality: number): Effect.Effect<Encoded | undefined> =>
      Effect.suspend(() => {
        const known = encodings[index]?.get(quality);

        if (known !== undefined) return Effect.succeed(known);

        const image = images[index];

        if (image === undefined || fits[index] !== undefined) return Effect.undefined;

        return encode(image, quality).pipe(
          Effect.tap((encoded) =>
            Effect.sync(() => {
              encodings[index]?.set(quality, encoded);
            }),
          ),
          Effect.catchCause(() =>
            Effect.sync(() => {
              fits[index] = { kind: "file", reason: UNPREPARED };

              return undefined;
            }),
          ),
        );
      });

    /** The total size of `kept` at `quality`, or undefined when one of them failed to encode. */
    const total = (quality: number): Effect.Effect<number | undefined> =>
      Effect.gen(function* () {
        let sum = 0;

        for (const index of kept) {
          const encoded = yield* at(index, quality);

          if (encoded === undefined) return undefined;

          sum += encoded.data.length;
        }

        return sum;
      });

    const lowest = QUALITIES.at(-1) ?? 0;

    /**
     * Settle one more of `kept`: all of them, at the best quality at which they fit together; else the largest, as a
     * file. An image that fails to encode on the way is settled instead.
     */
    const round = Effect.gen(function* () {
      for (const quality of QUALITIES) {
        const sum = yield* total(quality);

        if (sum === undefined) return;

        if (sum <= budget) {
          for (const index of kept) {
            const encoded = encodings[index]?.get(quality);

            if (encoded !== undefined) fits[index] = { kind: "inline", encoded };
          }

          return;
        }
      }

      // Even the lowest quality is over: the largest image there goes as a file, and the rest are fitted again.
      let largest = kept[0] ?? 0;
      let largestSize = -1;

      for (const index of kept) {
        const size = encodings[index]?.get(lowest)?.data.length ?? 0;

        if (size >= largestSize) {
          largest = index;
          largestSize = size;
        }
      }

      fits[largest] = { kind: "file", reason: largestSize > budget ? TOO_BIG : TOO_BIG_TOGETHER };
    });

    while (kept.length > 0) {
      yield* round;
      kept = kept.filter((index) => fits[index] === undefined);
    }

    return fits.map((fit): Fit => fit ?? { kind: "file", reason: TOO_BIG });
  });
