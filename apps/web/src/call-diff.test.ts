import * as Arr from "effect/Array";
import { describe, expect, it } from "vitest";
import {
  CALL_DIFF_LINE_CAP,
  callDiffCounts,
  callDiffOf,
  capPatch,
  diffStyleFor,
  diffTotals,
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

    expect(result.patch).toBe(`${HEAD}@@ -1,1 +0,0 @@\n-a\n\\ No newline at end of file\n`);
  });

  it("writes a side the cut left with no lines as the format has it: its start the line before", () => {
    const patch = `${HEAD}@@ -5,2 +5,3 @@\n+a\n+b\n+c\n-x\n-y\n`;

    expect(capPatch(patch, 2).patch).toBe(`${HEAD}@@ -4,0 +5,2 @@\n+a\n+b\n`);
    // A side that had no lines to begin with keeps the start it was written with.
    expect(capPatch(`${HEAD}@@ -4,0 +5,3 @@\n+a\n+b\n+c\n`, 2).patch).toBe(
      `${HEAD}@@ -4,0 +5,2 @@\n+a\n+b\n`,
    );
    expect(capPatch(`${HEAD}@@ -5,2 +4,0 @@\n-x\n-y\n`, 1).patch).toBe(
      `${HEAD}@@ -5,1 +4,0 @@\n-x\n`,
    );
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

describe("callDiffOf", () => {
  it("is the patch of a finished edit's details", () => {
    expect(callDiffOf("edit", { patch: "p", diff: "d" }, false)).toEqual({ patch: "p" });
  });

  it("is a finished write's patch, with whether it made the file", () => {
    expect(callDiffOf("write", { patch: "p" }, false)).toEqual({ patch: "p" });
    expect(callDiffOf("write", { patch: "p", created: true }, false)).toEqual({
      patch: "p",
      created: true,
    });
  });

  it("keeps the path a write recorded", () => {
    expect(callDiffOf("write", { path: "src/a.ts", patch: "p", created: true }, false)).toEqual({
      path: "src/a.ts",
      patch: "p",
      created: true,
    });
    expect(callDiffOf("write", { path: "big.bin", binary: true }, false)).toEqual({
      path: "big.bin",
      unavailable: true,
    });
  });

  it("is that a write's change is too large to show, for `tooLarge` and for `binary`", () => {
    expect(callDiffOf("write", { tooLarge: true }, false)).toEqual({ unavailable: true });
    expect(callDiffOf("write", { binary: true }, false)).toEqual({ unavailable: true });
    expect(callDiffOf("write", { tooLarge: true, created: true }, false)).toEqual({
      unavailable: true,
      created: true,
    });
  });

  it("is undefined for a call that failed", () => {
    expect(callDiffOf("edit", { patch: "p" }, true)).toBeUndefined();
    expect(callDiffOf("write", { patch: "p" }, true)).toBeUndefined();
  });

  it("is undefined for other tools, for details that record nothing, and for none", () => {
    expect(callDiffOf("read", { patch: "p" }, false)).toBeUndefined();
    expect(callDiffOf("edit", { diff: "d" }, false)).toBeUndefined();
    expect(callDiffOf("edit", { patch: "" }, false)).toBeUndefined();
    expect(callDiffOf("edit", undefined, false)).toBeUndefined();
    expect(callDiffOf("edit", "text", false)).toBeUndefined();
    // A `write` from before the wrapper recorded anything.
    expect(callDiffOf("write", undefined, false)).toBeUndefined();
    expect(callDiffOf("write", { created: true }, false)).toBeUndefined();
  });
});

describe("callDiffCounts and diffTotals", () => {
  const change = { patch: `${HEAD}${hunk(1, 4, 2, 3)}` };

  it("counts a patch's lines, and none for a diff without one or whose patch changes nothing", () => {
    expect(callDiffCounts(change)).toEqual({ additions: 3, deletions: 2 });
    expect(callDiffCounts({ unavailable: true })).toBeUndefined();
    expect(callDiffCounts({ patch: HEAD })).toBeUndefined();
  });

  it("adds the lines of the diffs that have a patch, and none where no diff changes a line", () => {
    expect(
      diffTotals([
        change,
        undefined,
        { unavailable: true },
        { patch: `${HEAD}${hunk(1, 2, 1, 0)}` },
      ]),
    ).toEqual({ additions: 3, deletions: 3 });
    expect(diffTotals([])).toBeUndefined();
    expect(diffTotals([undefined, { unavailable: true }, { patch: HEAD }])).toBeUndefined();
  });
});
