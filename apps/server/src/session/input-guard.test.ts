import {
  type Annotation,
  MAX_ANNOTATION_TEXT,
  MAX_ANNOTATIONS,
  MAX_STORED_INPUT_BYTES,
  renderReview,
  reviewMessage,
} from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { inputProblem, storedBytes } from "./input-guard.ts";

const image = (mimeType: string, characters = 8) => ({
  type: "image" as const,
  mimeType,
  data: "A".repeat(characters),
});

describe("inputProblem", () => {
  it("lets through a Review at the limits: its entry keeps each quote and text once", () => {
    // Each draft at its limits: a 50-line quote of 8 KB, and 4,000 characters of text.
    const drafts = Array.from(
      { length: MAX_ANNOTATIONS },
      (_, index): Annotation => ({
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
      }),
    );

    const { markdown, data } = renderReview(drafts);
    const summary = "z".repeat(1_000);

    const stored = {
      content: [{ type: "text" as const, text: reviewMessage(summary, markdown) }],
      entry: { kind: "cloudpid.user", data: { display: summary, skills: [], review: data } },
    };

    expect(storedBytes(stored)).toBeLessThan(MAX_STORED_INPUT_BYTES);
    expect(inputProblem(stored, 0)).toBeUndefined();
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
