// Preparing an image the agent reads for the conversation, over a fake Images binding: it passes through when it fits,
// and is otherwise scaled and re-encoded until its base64 fits `MAX_IMAGE_CHARACTERS`, or left out with the reason.
// @effect-diagnostics asyncFunction:off
import { DEFAULT_IMAGE_LIMITS } from "@earendil-works/pi-durable/tools";
import { describe, expect, it } from "vitest";
import { fakeImage, fakeImages } from "./images.fixture.ts";
import {
  cloudflareImages,
  MAX_IMAGE_ATTEMPTS,
  MAX_IMAGE_CHARACTERS,
  prepareImage,
} from "./images.ts";

/** The base64 of `bytes`. */
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

describe("prepareImage", () => {
  it("passes an inline image that fits through as it is, with no transformation", async () => {
    const { images, outputs } = fakeImages();
    const bytes = fakeImage(800, 600, 1000);

    expect(await prepareImage(images, bytes, "image/png", DEFAULT_IMAGE_LIMITS)).toEqual({
      image: { data: base64(bytes), mimeType: "image/png" },
    });
    expect(outputs).toEqual([]);
  });

  it("scales an image larger than the model's dimensions down to them, as WebP", async () => {
    const { images, outputs } = fakeImages({ bytesPerPixel: () => 0.05 });

    const prepared = await prepareImage(
      images,
      fakeImage(4000, 3000, 2000),
      "image/png",
      DEFAULT_IMAGE_LIMITS,
    );

    expect(prepared).toMatchObject({
      image: {
        mimeType: "image/webp",
        convertedFrom: "image/png",
        resized: { from: { width: 4000, height: 3000 }, to: { width: 2000, height: 1500 } },
      },
    });
    expect(outputs).toEqual([{ width: 2000, height: 1500, format: "image/webp", quality: 80 }]);
  });

  it("keeps a JPEG a JPEG", async () => {
    const { images, outputs } = fakeImages({ bytesPerPixel: () => 0.05 });

    const prepared = await prepareImage(
      images,
      fakeImage(3000, 3000, 2000),
      "image/jpeg",
      DEFAULT_IMAGE_LIMITS,
    );

    expect(prepared).toEqual({
      image: {
        data: expect.any(String),
        mimeType: "image/jpeg",
        resized: { from: { width: 3000, height: 3000 }, to: { width: 2000, height: 2000 } },
      },
    });
    expect(outputs).toEqual([{ width: 2000, height: 2000, format: "image/jpeg", quality: 80 }]);
  });

  it("re-encodes at a lower quality an image a little over the bound, though the model would take it", async () => {
    // 1.5 megapixels: 600 KB (800,000 base64 characters) at quality 80, 450 KB at 60.
    const { images, outputs } = fakeImages({ bytesPerPixel: (quality) => quality / 200 });

    const prepared = await prepareImage(
      images,
      fakeImage(1500, 1000, 1_000_000),
      "image/png",
      DEFAULT_IMAGE_LIMITS,
    );

    expect(prepared).toEqual({
      image: { data: expect.any(String), mimeType: "image/webp", convertedFrom: "image/png" },
    });
    expect(outputs).toEqual([
      { width: 1500, height: 1000, format: "image/webp", quality: 80 },
      { width: 1500, height: 1000, format: "image/webp", quality: 60 },
    ]);
  });

  it("scales an image far over the bound down until it fits, in a few transformations", async () => {
    const { images, outputs } = fakeImages();

    const prepared = await prepareImage(
      images,
      fakeImage(2000, 2000, 3_000_000),
      "image/png",
      DEFAULT_IMAGE_LIMITS,
    );

    if (!("image" in prepared)) throw new Error(prepared.leftOut);

    expect(prepared.image.data.length).toBeLessThanOrEqual(MAX_IMAGE_CHARACTERS);
    expect(prepared.image.resized?.from).toEqual({ width: 2000, height: 2000 });
    expect(prepared.image.resized?.to.width).toBeLessThan(2000);
    expect(outputs.length).toBeLessThanOrEqual(MAX_IMAGE_ATTEMPTS);
    expect(outputs.at(-1)).toMatchObject(prepared.image.resized?.to ?? {});
  });

  it("holds an image to a model's smaller byte limit", async () => {
    const { images } = fakeImages();

    const prepared = await prepareImage(images, fakeImage(800, 600, 200_000), "image/png", {
      ...DEFAULT_IMAGE_LIMITS,
      maxBytes: 100_000,
    });

    if (!("image" in prepared)) throw new Error(prepared.leftOut);

    expect(prepared.image.data.length).toBeLessThanOrEqual(100_000);
  });

  it("leaves out an image it cannot make fit, after a few transformations", async () => {
    const { images, outputs } = fakeImages({ leastBytes: 600_000 });

    expect(
      await prepareImage(
        images,
        fakeImage(2000, 2000, 3_000_000),
        "image/png",
        DEFAULT_IMAGE_LIMITS,
      ),
    ).toEqual({
      leftOut: `it could not be reduced to ${MAX_IMAGE_CHARACTERS.toLocaleString("en-US")} base64 characters, the most an image in the conversation may be`,
    });
    expect(outputs).toHaveLength(MAX_IMAGE_ATTEMPTS);
  });

  it("leaves out an image when the Images binding fails, saying why", async () => {
    const { images } = fakeImages({ failing: "ERROR 9422: monthly transformations exceeded" });

    expect(
      await prepareImage(
        images,
        fakeImage(2000, 2000, 3_000_000),
        "image/png",
        DEFAULT_IMAGE_LIMITS,
      ),
    ).toEqual({
      leftOut: "the image service failed (ERROR 9422: monthly transformations exceeded)",
    });
  });
});

describe("cloudflareImages", () => {
  it("is an image processor that gives `undefined` for an image it leaves out", async () => {
    const { images } = fakeImages({ leastBytes: 600_000 });
    const processor = cloudflareImages(images);

    expect(
      await processor.prepare(fakeImage(2000, 2000, 3_000_000), "image/png", DEFAULT_IMAGE_LIMITS),
    ).toBeUndefined();
    expect(
      await processor.prepare(fakeImage(10, 10), "image/png", DEFAULT_IMAGE_LIMITS),
    ).toMatchObject({ mimeType: "image/png" });
  });
});
