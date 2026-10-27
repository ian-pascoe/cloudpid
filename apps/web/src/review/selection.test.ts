import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { pickLines } from "./selection.ts";

/** A patch of `a.ts`: lines 10–11 kept, 12 changed, 13 added, 14 kept; then a second hunk at line 40. */
const PATCH = `--- a/a.ts
+++ b/a.ts
@@ -10,4 +10,5 @@
 ten
 eleven
-twelve
+TWELVE
+thirteen
 fourteen
@@ -39,2 +40,2 @@
 forty
-gone
+here
`;

const diff = () => {
  const file = parsePatchFiles(PATCH)[0]?.files[0];

  if (file === undefined) throw new Error("No file in the patch");

  return file;
};

describe("pickLines", () => {
  it("picks added lines on the new side, with their text", () => {
    expect(pickLines(diff(), { start: 12, side: "additions", end: 13 })).toEqual({
      side: "new",
      start: 12,
      end: 13,
      quote: ["TWELVE", "thirteen"],
      more: 0,
    });
  });

  it("picks removed lines alone on the old side", () => {
    expect(pickLines(diff(), { start: 12, side: "deletions", end: 12 })).toMatchObject({
      side: "old",
      start: 12,
      end: 12,
      quote: ["twelve"],
    });
  });

  it("cuts a selection across sides at the side where it started, context included", () => {
    expect(
      pickLines(diff(), { start: 11, side: "deletions", end: 13, endSide: "additions" }),
    ).toMatchObject({ side: "old", start: 11, end: 12, quote: ["eleven", "twelve"] });
    expect(
      pickLines(diff(), { start: 13, side: "additions", end: 11, endSide: "deletions" }),
    ).toMatchObject({ side: "new", start: 11, end: 13, quote: ["eleven", "TWELVE", "thirteen"] });
  });

  it("keeps context alone on the side the selection started on", () => {
    expect(pickLines(diff(), { start: 10, side: "deletions", end: 11 })).toMatchObject({
      side: "old",
      start: 10,
      end: 11,
      quote: ["ten", "eleven"],
    });
    expect(pickLines(diff(), { start: 10, side: "additions", end: 11 })).toMatchObject({
      side: "new",
    });
  });

  it("stops at the gap between two hunks, so the quote is whole", () => {
    expect(pickLines(diff(), { start: 14, side: "additions", end: 41 })).toMatchObject({
      side: "new",
      start: 14,
      end: 14,
      quote: ["fourteen"],
    });
  });

  it("picks nothing for a line the diff does not draw", () => {
    expect(pickLines(diff(), { start: 3, side: "additions", end: 3 })).toBeUndefined();
  });
});
