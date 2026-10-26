import * as Arr from "effect/Array";
import { describe, expect, it } from "vitest";
import {
  CALL_DIFF_LINE_CAP,
  callDiffPatch,
  capPatch,
  diffStyleFor,
  patchCounts,
  SPLIT_MIN_WIDTH,
} from "./call-diff.ts";

const HEAD = "--- src/a.ts\n+++ src/a.ts\n";

/** A hunk of `context` unchanged lines, then `removed` removed ones, then `added` added ones. */
const hunk = (start: number, context: number, removed: number, added: number): string => {
  const lines = [
    ...Array.from({ length: context }, (_, i) => ` keep ${i}`),
    ...Array.from({ length: removed }, (_, i) => `-old ${i}`),
    ...Array.from({ length: added }, (_, i) => `+new ${i}`),
  ];

  return `@@ -${start},${context + removed} +${start},${context + added} @@\n${Arr.join(lines, "\n")}\n`;
};

describe("patchCounts", () => {
  it("counts the added and removed lines of every hunk", () => {
    expect(patchCounts(HEAD + hunk(1, 4, 2, 3) + hunk(40, 4, 1, 0))).toEqual({
      additions: 3,
      deletions: 3,
    });
  });

  it("does not take the file headers for lines", () => {
    expect(patchCounts(HEAD + hunk(1, 1, 1, 1))).toEqual({ additions: 1, deletions: 1 });
  });

  it("counts a line that looks like a file header when it is inside a hunk", () => {
    const patch = `${HEAD}@@ -1,2 +1,2 @@\n--- a rule\n+++ a rule\n ctx\n`;

    expect(patchCounts(patch)).toEqual({ additions: 1, deletions: 1 });
  });

  it("ignores the no-newline marker", () => {
    const patch = `${HEAD}@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n`;

    expect(patchCounts(patch)).toEqual({ additions: 1, deletions: 1 });
  });

  it("reads a hunk header without counts as one line", () => {
    expect(patchCounts(`${HEAD}@@ -3 +3 @@\n-a\n+b\n`)).toEqual({ additions: 1, deletions: 1 });
  });

  it("is undefined for a text with no hunk", () => {
    expect(patchCounts("")).toBeUndefined();
    expect(patchCounts(HEAD)).toBeUndefined();
    expect(patchCounts("not a patch")).toBeUndefined();
  });
});

describe("capPatch", () => {
  it("leaves a patch within the cap as it is", () => {
    const patch = HEAD + hunk(1, 4, 2, 3);

    expect(capPatch(patch, 100)).toEqual({ patch, lines: 9, capped: false });
  });

  it("keeps a patch of exactly the cap whole", () => {
    const patch = HEAD + hunk(1, 4, 2, 2);

    expect(capPatch(patch, 8).capped).toBe(false);
  });

  it("cuts inside a hunk and fixes its counts", () => {
    const result = capPatch(HEAD + hunk(10, 4, 3, 3), 6);

    expect(result.capped).toBe(true);
    expect(result.lines).toBe(10);
    expect(result.patch).toBe(
      `${HEAD}@@ -10,6 +10,4 @@\n keep 0\n keep 1\n keep 2\n keep 3\n-old 0\n-old 1\n`,
    );
  });

  it("drops the hunks after the cap, without an empty one", () => {
    const first = hunk(1, 2, 1, 1);
    const result = capPatch(HEAD + first + hunk(50, 2, 1, 1), 4);

    expect(result.patch).toBe(HEAD + first);
    expect(result.lines).toBe(8);
  });

  it("counts again what the cut left in the last hunk", () => {
    const result = capPatch(HEAD + hunk(1, 2, 1, 1) + hunk(50, 2, 1, 1), 3);

    expect(result.patch).toBe(`${HEAD}@@ -1,3 +1,2 @@\n keep 0\n keep 1\n-old 0\n`);
    expect(patchCounts(result.patch)).toEqual({ additions: 0, deletions: 1 });
  });

  it("keeps the no-newline marker of a line it kept", () => {
    const patch = `${HEAD}@@ -1,2 +1,2 @@\n-a\n\\ No newline at end of file\n+b\n \n`;
    const result = capPatch(patch, 1);

    expect(result.patch).toBe(`${HEAD}@@ -1,1 +1,0 @@\n-a\n\\ No newline at end of file\n`);
  });

  it("caps at 2,000 lines by default", () => {
    expect(CALL_DIFF_LINE_CAP).toBe(2000);

    const result = capPatch(HEAD + hunk(1, 0, 0, 2500));

    expect(result.lines).toBe(2500);
    expect(result.capped).toBe(true);
    expect(patchCounts(result.patch)).toEqual({ additions: 2000, deletions: 0 });
  });
});

describe("diffStyleFor", () => {
  it("is split from the width where two columns fit, stacked below it", () => {
    expect(diffStyleFor(SPLIT_MIN_WIDTH)).toBe("split");
    expect(diffStyleFor(SPLIT_MIN_WIDTH - 1)).toBe("unified");
    expect(diffStyleFor(0)).toBe("unified");
  });
});

describe("callDiffPatch", () => {
  it("is the patch of a finished edit's details", () => {
    expect(callDiffPatch("edit", { patch: "p", diff: "d" }, false)).toBe("p");
  });

  it("is undefined for a call that failed", () => {
    expect(callDiffPatch("edit", { patch: "p" }, true)).toBeUndefined();
  });

  it("is undefined for other tools, for details without a patch, and for none", () => {
    expect(callDiffPatch("write", { patch: "p" }, false)).toBeUndefined();
    expect(callDiffPatch("edit", { diff: "d" }, false)).toBeUndefined();
    expect(callDiffPatch("edit", { patch: "" }, false)).toBeUndefined();
    expect(callDiffPatch("edit", undefined, false)).toBeUndefined();
    expect(callDiffPatch("edit", "text", false)).toBeUndefined();
  });
});
