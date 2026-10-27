import { MAX_ANNOTATION_CROP } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { cropRegion, fittedCrop } from "./crop.ts";

describe("cropRegion", () => {
  it("maps a rect of the viewport to the frame's pixels, with a margin, within the image", () => {
    // A 400-wide tab in an 800-pixel frame: two pixels a CSS px.
    expect(
      cropRegion(
        { x: 100, y: 50, width: 40, height: 20 },
        { deviceWidth: 400, offsetTop: 0 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ sx: 184, sy: 84, sw: 112, sh: 72, width: 112, height: 72 });

    // At the corner, the margin stops at the image's edge.
    expect(
      cropRegion(
        { x: 0, y: 0, width: 10, height: 10 },
        { deviceWidth: 400, offsetTop: 0 },
        { width: 400, height: 300 },
      ),
    ).toMatchObject({ sx: 0, sy: 0, sw: 18, sh: 18 });
  });

  it("draws a large spot at 640 px on its longer edge, and finds nothing outside the frame", () => {
    expect(
      cropRegion(
        { x: 0, y: 0, width: 1_280, height: 640 },
        { deviceWidth: 1_280, offsetTop: 0 },
        { width: 1_280, height: 720 },
      ),
    ).toMatchObject({ width: 640, height: 324 });
    expect(
      cropRegion(
        { x: 0, y: 2_000, width: 10, height: 10 },
        { deviceWidth: 400, offsetTop: 0 },
        { width: 400, height: 300 },
      ),
    ).toBeUndefined();
  });
});

describe("fittedCrop", () => {
  /** An encoder whose base64 is as long as the pixels times the quality. */
  const encoder = (tried: string[]) => (width: number, height: number, quality: number) => {
    tried.push(`${width}x${height}@${quality}`);

    return `data:image/jpeg;base64,${"A".repeat(Math.round(width * height * quality))}`;
  };

  it("takes the best quality that fits at the full size", () => {
    const tried: string[] = [];

    expect(fittedCrop({ width: 100, height: 100 }, encoder(tried))).toEqual({
      mimeType: "image/jpeg",
      data: "A".repeat(8_000),
    });
    expect(tried).toEqual(["100x100@0.8"]);
  });

  it("goes coarser, then smaller, until the crop fits its bound", () => {
    const tried: string[] = [];
    const crop = fittedCrop({ width: 400, height: 300 }, encoder(tried));

    expect(crop?.data.length).toBeLessThanOrEqual(MAX_ANNOTATION_CROP);
    expect(tried.slice(0, 4)).toEqual([
      "400x300@0.8",
      "400x300@0.6",
      "400x300@0.45",
      "280x210@0.8",
    ]);
  });

  it("gives up rather than send a crop too small to see, or one the canvas could not encode", () => {
    expect(
      fittedCrop({ width: 400, height: 300 }, () => `data:image/jpeg;base64,${"A".repeat(20_000)}`),
    ).toBeUndefined();
    expect(fittedCrop({ width: 40, height: 30 }, () => "data:,")).toBeUndefined();
  });
});
