// @effect-diagnostics preferEffectArray:off -- tests over native arrays of drafts and crops.
import {
  type Annotation,
  INLINE_IMAGE_BUDGET,
  MAX_ANNOTATION_CROP,
  MAX_ANNOTATION_SELECTOR,
  MAX_ANNOTATION_TAG,
  MAX_ANNOTATION_TEXT,
  MAX_ANNOTATIONS,
  MAX_PAGE_URL,
  MAX_REVIEW_CROPS,
  MAX_STORED_INPUT_BYTES,
  type PageAnnotation,
  renderReview,
  reviewMessage,
} from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { cropParts, fitCrops } from "./crops.ts";
import { inputProblem, storedBytes } from "./input-guard.ts";

/** A page draft at every limit: its URL, selector, tag, quote, text and crop. */
const pageAtLimits = (index: number, text = MAX_ANNOTATION_TEXT): PageAnnotation => ({
  id: `p${index}`,
  source: {
    kind: "page",
    url: `https://app.test/${"u".repeat(MAX_PAGE_URL - 17)}`,
    ownerTabId: "0".repeat(36),
    element: { selector: "s".repeat(MAX_ANNOTATION_SELECTOR), tag: "t".repeat(MAX_ANNOTATION_TAG) },
    box: { x: 12_345.5, y: 67_890.25, width: 1_280, height: 720 },
    scroll: { x: 0, y: 99_999 },
    viewport: { width: 1_280, height: 720 },
  },
  quote: Array.from({ length: 50 }, () => "x".repeat(159)),
  more: 10,
  crop: { mimeType: "image/jpeg", data: "A".repeat(MAX_ANNOTATION_CROP) },
  text: "y".repeat(text),
  createdAt: index,
  updatedAt: index,
});

/** A Review of `drafts` as the Session stores it, with the crops it has room for. */
const storedReview = (drafts: readonly Annotation[]) => {
  const { markdown, data, crops } = renderReview(drafts);
  const summary = "z".repeat(1_000);
  const content = [{ type: "text" as const, text: reviewMessage(summary, markdown) }];
  const entry = { kind: "cloudpid.user", data: { display: summary, skills: [], review: data } };
  const fitted = fitCrops(crops, { bytes: storedBytes({ content, entry }), images: 0 });

  return {
    fitted,
    stored: {
      content: [...content, ...fitted.flatMap(cropParts)],
      entry: {
        ...entry,
        data: { ...entry.data, review: { ...data, crops: fitted.map(({ number }) => number) } },
      },
    },
  };
};

const image = (mimeType: string, characters = 8) => ({
  type: "image" as const,
  mimeType,
  data: "A".repeat(characters),
});

describe("inputProblem", () => {
  it("lets through a Review at the limits: its entry keeps each quote and text once", () => {
    // Each draft at its limits: a 50-line quote of 8 KB, and 4,000 characters of text.
    const drafts = Array.from({ length: MAX_ANNOTATIONS }, (_, index): Annotation => ({
      id: `a${index}`,
      source: { kind: "changes", repo: "app", head: "a".repeat(40) },
      path: `src/file-${index}.ts`,
      side: "new",
      start: 1,
      end: 60,
      quote: Array.from({ length: 50 }, () => "x".repeat(159)),
      more: 10,
      text: "y".repeat(MAX_ANNOTATION_TEXT),
      createdAt: index,
      updatedAt: index,
    }));

    const { markdown, data } = renderReview(drafts);
    const summary = "z".repeat(1_000);

    const stored = {
      content: [{ type: "text" as const, text: reviewMessage(summary, markdown) }],
      entry: { kind: "cloudpid.user", data: { display: summary, skills: [], review: data } },
    };

    expect(storedBytes(stored)).toBeLessThan(MAX_STORED_INPUT_BYTES);
    expect(inputProblem(stored, 0)).toBeUndefined();
  });

  it("lets through a Review of 100 page drafts at every limit, its crops in what the message leaves", () => {
    const { stored, fitted } = storedReview(
      Array.from({ length: MAX_ANNOTATIONS }, (_, index) => pageAtLimits(index)),
    );

    expect(storedBytes(stored)).toBeLessThan(MAX_STORED_INPUT_BYTES);
    expect(inputProblem(stored, 0)).toBeUndefined();
    expect(fitted.length).toBeLessThan(MAX_REVIEW_CROPS);
  });

  it("carries 20 crops at most, within the image budget, when the text leaves room", () => {
    const { stored, fitted } = storedReview(
      Array.from({ length: MAX_ANNOTATIONS }, (_, index) => pageAtLimits(index, 10)),
    );

    expect(fitted.map(({ number }) => number)).toEqual(
      Array.from({ length: MAX_REVIEW_CROPS }, (_, index) => index + 1),
    );
    expect(fitted.reduce((sum, { crop }) => sum + crop.data.length, 0)).toBeLessThanOrEqual(
      INLINE_IMAGE_BUDGET,
    );
    expect(inputProblem(stored, 0)).toBeUndefined();
  });

  it("leaves a crop out when the message's own images used the budget", () => {
    const crop = { mimeType: "image/jpeg" as const, data: "A".repeat(MAX_ANNOTATION_CROP) };

    expect(
      fitCrops([{ number: 1, crop }], { bytes: 1_000, images: INLINE_IMAGE_BUDGET - 10 }),
    ).toEqual([]);
    expect(
      fitCrops([{ number: 1, crop }], { bytes: MAX_STORED_INPUT_BYTES - 100, images: 0 }),
    ).toEqual([]);
    expect(fitCrops([{ number: 1, crop }], { bytes: 1_000, images: 0 })).toHaveLength(1);
  });

  it("lets through text, and images of the types every provider takes", () => {
    expect(inputProblem({ content: "hello" }, 0)).toBeUndefined();
    expect(
      inputProblem(
        {
          content: [
            { type: "text", text: "look" },
            image("image/png"),
            image("image/jpeg"),
            image("image/webp"),
            image("image/gif"),
          ],
        },
        0,
      ),
    ).toBeUndefined();
  });

  it("refuses an image of any other type", () => {
    expect(inputProblem({ content: [image("image/svg+xml")] }, 0)).toBe(
      "An image must be PNG, JPEG, WebP or GIF to go to the model, not image/svg+xml.",
    );
  });

  it("refuses a message that would not fit one stored row, counting its entry's data", () => {
    const big = { content: [{ type: "text" as const, text: "x" }, image("image/png", 2_000_000)] };

    expect(inputProblem(big, 0)).toBe(
      "This message is 2.01 MB, and one holds at most 1.9 MB: send fewer or smaller images, or less text.",
    );

    const text = "y".repeat(MAX_STORED_INPUT_BYTES / 2);

    expect(inputProblem({ content: text }, 0)).toBeUndefined();
    expect(
      inputProblem({ content: text, entry: { kind: "cloudpid.user", data: { display: text } } }, 0),
    ).toMatch(/^This message is 1.91 MB/u);
  });

  it("counts characters as the UTF-8 bytes they are stored as", () => {
    expect(storedBytes("é")).toBe(4);
    expect(inputProblem({ content: "é".repeat(1_000_000) }, 0)).toMatch(
      /^This message is 2.01 MB/u,
    );
  });

  it("refuses a message that would not fit beside the ones already waiting", () => {
    const half = "z".repeat(1_000_000);

    expect(inputProblem({ content: half }, 1_000_000)).toBe(
      "The messages waiting for the run and this one are 2.01 MB together, over the 1.9 MB the queue holds: send it once the run has taken them.",
    );
    expect(inputProblem({ content: half }, 800_000)).toBeUndefined();
  });
});
