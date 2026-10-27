import type { EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { Annotation } from "./annotations.ts";
import { renderReview, reviewMessage } from "./review.ts";
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
      { role: "user", content: [{ type: "text", text: reviewMessage(summary, markdown) }], timestamp: 9 },
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

  it("shows \"Review: n Annotations\" when it has no summary", () => {
    expect(projectEntry(reviewEntry(""))?.parts).toEqual([
      { type: "text", text: "Review: 1 Annotation" },
    ]);
  });
});
