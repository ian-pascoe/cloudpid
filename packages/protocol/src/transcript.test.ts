import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { Annotation, PageAnnotation } from "./annotations.ts";
import { cropLabel, renderReview, reviewMessage } from "./review.ts";
import { projectEntry } from "./transcript.ts";
import { USER_ENTRY_KIND } from "./user-entry.ts";

const annotation: Annotation = {
  id: "a1",
  source: { kind: "changes", repo: "app", head: null },
  path: "src/a.ts",
  side: "new",
  start: 2,
  end: 3,
  quote: ["b", "c"],
  more: 0,
  text: "Why two?",
  createdAt: 1,
  updatedAt: 1,
};

/** A Review's entry, as the Session places it. */
const reviewEntry = (summary: string): EntryRecord => {
  const { markdown, data } = renderReview([annotation]);

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the fields of an entry the projection reads.
  return {
    id: 7,
    kind: USER_ENTRY_KIND,
    data: { display: summary, skills: [], review: data },
    model: [
      {
        role: "user",
        content: [{ type: "text", text: reviewMessage(summary, markdown) }],
        timestamp: 9,
      },
    ],
  } as unknown as EntryRecord;
};

describe("a Review in the transcript", () => {
  it("shows its summary, with its Annotations' quotes and texts", () => {
    const message = projectEntry(reviewEntry("Have a look."));

    expect(message?.parts).toEqual([{ type: "text", text: "Have a look." }]);
    expect(message?.review).toMatchObject([
      { file: "/workspace/app/src/a.ts", start: 2, end: 3, quote: ["b", "c"], text: "Why two?" },
    ]);
  });

  it("keeps the crops the message carried out of its parts, and gives each to its page Annotation", () => {
    const crop = { mimeType: "image/jpeg" as const, data: "QUJD" };

    const page: PageAnnotation = {
      id: "p1",
      source: {
        kind: "page",
        url: "https://app.test/",
        ownerTabId: "tab-1",
        box: { x: 0, y: 0, width: 10, height: 10 },
        scroll: { x: 0, y: 0 },
        viewport: { width: 100, height: 100 },
      },
      quote: [],
      more: 0,
      crop,
      text: "This.",
      createdAt: 2,
      updatedAt: 2,
    };

    const { markdown, data } = renderReview([annotation, page]);

    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the fields of an entry the projection reads.
    const entry = {
      id: 8,
      kind: USER_ENTRY_KIND,
      data: { display: "", skills: [], review: { ...data, crops: [2] } },
      model: [
        {
          role: "user",
          content: [
            { type: "text", text: markdown },
            { type: "image", mimeType: "image/png", data: "QQ==" },
            { type: "text", text: cropLabel(2) },
            { type: "image", ...crop },
          ],
          timestamp: 9,
        },
      ],
    } as unknown as EntryRecord;

    const message = projectEntry(entry);

    expect(message?.parts).toEqual([
      { type: "text", text: "Review: 2 Annotations" },
      { type: "image", mimeType: "image/png", data: "QQ==" },
    ]);
    expect(message?.review?.[1]).toMatchObject({ text: "This.", crop });
  });

  it('shows "Review: n Annotations" when it has no summary', () => {
    expect(projectEntry(reviewEntry(""))?.parts).toEqual([
      { type: "text", text: "Review: 1 Annotation" },
    ]);
  });
});
