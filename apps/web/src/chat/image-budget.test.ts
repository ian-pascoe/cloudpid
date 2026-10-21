// @effect-diagnostics preferEffectArray:off -- a fake encoder recording its calls in a native array.

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  type Encoder,
  fitImages,
  fitLongEdge,
  MAX_IMAGE_EDGE,
  QUALITIES,
  UNPREPARED,
} from "./image-budget.ts";
import { ImageError } from "./image-encode.ts";

/** A fake image: its name, and how many base64 characters it encodes to at full quality. */
type Fake = { readonly name: string; readonly size: number };

/** Encodes `image` to `size × quality` characters, recording each call. */
const fakeEncoder = () => {
  const calls: string[] = [];

  const encode: Encoder<Fake, never> = (image, quality) =>
    Effect.sync(() => {
      calls.push(`${image.name}@${quality}`);

      return { mimeType: "image/jpeg", data: "A".repeat(Math.round(image.size * quality)) };
    });

  return { encode, calls };
};

const [top = 1, , , , lowest = 0] = QUALITIES;

const summary = (fits: Effect.Success<ReturnType<typeof fitImages>>) =>
  fits.map((fit) =>
    fit.kind === "inline" ? `inline ${fit.encoded.data.length}` : `file: ${fit.reason}`,
  );

describe("fitImages", () => {
  it.effect("sends images that fit at the best quality as they are", () =>
    Effect.gen(function* () {
      const { encode, calls } = fakeEncoder();

      const fits = yield* fitImages(
        [
          { name: "a", size: 100 },
          { name: "b", size: 200 },
        ],
        encode,
        1_000,
      );

      expect(summary(fits)).toEqual([`inline ${100 * top}`, `inline ${200 * top}`]);
      expect(calls).toEqual([`a@${top}`, `b@${top}`]);
    }),
  );

  it.effect("lowers every image's quality together until they share the budget", () =>
    Effect.gen(function* () {
      const { encode } = fakeEncoder();

      const images = [
        { name: "a", size: 1_000 },
        { name: "b", size: 1_000 },
      ];

      const fits = yield* fitImages(images, encode, 1_300);

      const level = QUALITIES.find((quality) => 2 * Math.round(1_000 * quality) <= 1_300);

      expect(level).toBeDefined();
      expect(summary(fits)).toEqual([
        `inline ${Math.round(1_000 * (level ?? 0))}`,
        `inline ${Math.round(1_000 * (level ?? 0))}`,
      ]);
    }),
  );

  it.effect("degrades several large images to files, largest first, rather than failing", () =>
    Effect.gen(function* () {
      const { encode } = fakeEncoder();

      const fits = yield* fitImages(
        [
          { name: "small", size: 400 },
          { name: "huge", size: 10_000 },
          { name: "large", size: 2_500 },
        ],
        encode,
        1_000,
      );

      // `huge` alone is over the budget at the lowest quality, `large` is over it beside `small`, and `small` then fits
      // at the best quality again.
      expect(summary(fits)).toEqual([
        `inline ${400 * top}`,
        "file: Too big to show the model; it goes as a file only.",
        "file: No room beside the other images; it goes as a file only.",
      ]);
    }),
  );

  it.effect("encodes each image at most once per quality", () =>
    Effect.gen(function* () {
      const { encode, calls } = fakeEncoder();

      yield* fitImages(
        [
          { name: "a", size: 5_000 },
          { name: "b", size: 5_000 },
          { name: "c", size: 5_000 },
        ],
        encode,
        2_500,
      );

      expect(new Set(calls).size).toBe(calls.length);
    }),
  );

  it.effect(
    "sends an image that fails to encode as a file only, and fits the others without it",
    () =>
      Effect.gen(function* () {
        const { encode: fake } = fakeEncoder();

        // `broken` encodes at the best quality, then fails at the next, once the three are over the budget together.
        const encode: Encoder<Fake, ImageError> = (image, quality) =>
          image.name === "broken" && quality < top
            ? Effect.fail(ImageError.make({ message: "No canvas" }))
            : fake(image, quality);

        const fits = yield* fitImages(
          [
            { name: "a", size: 400 },
            { name: "broken", size: 400 },
            { name: "b", size: 400 },
          ],
          encode,
          1_000,
        );

        expect(summary(fits)).toEqual([
          `inline ${400 * top}`,
          `file: ${UNPREPARED}`,
          `inline ${400 * top}`,
        ]);
      }),
  );

  it.effect("fits nothing to an empty list, and drops everything for no budget", () =>
    Effect.gen(function* () {
      const { encode } = fakeEncoder();

      expect(yield* fitImages([], encode, 1_000)).toEqual([]);
      expect(summary(yield* fitImages([{ name: "a", size: 10 }], encode, 0))).toEqual([
        "file: Too big to show the model; it goes as a file only.",
      ]);
      expect(lowest).toBeGreaterThan(0);
    }),
  );
});

describe("fitLongEdge", () => {
  it("shrinks the long edge to the limit, keeping the aspect ratio", () => {
    expect(fitLongEdge(4032, 3024)).toEqual({ width: MAX_IMAGE_EDGE, height: 1176 });
    expect(fitLongEdge(1000, 6000)).toEqual({ width: 261, height: MAX_IMAGE_EDGE });
  });

  it("never enlarges a small image, and keeps at least one pixel", () => {
    expect(fitLongEdge(640, 480)).toEqual({ width: 640, height: 480 });
    expect(fitLongEdge(10_000, 1)).toEqual({ width: MAX_IMAGE_EDGE, height: 1 });
  });
});
