// The line diff of an Agent change's long values (docs/spec.md → Agent changes).
import * as Arr from "effect/Array";
import { describe, expect, it } from "vitest";
import { changeDiff, diffLines, foldDiff } from "./line-diff.ts";

/** A text of `count` lines, each made by `line`. */
const numbered = (count: number, line: (index: number) => string): string =>
  Arr.join(Arr.makeBy(count, line), "\n");

const MARKS = { added: "+", removed: "-", same: " " } as const;

const shown = (rows: ReturnType<typeof foldDiff>) =>
  Arr.map(rows, (row) =>
    row.kind === "skipped" ? `… ${row.count}` : `${MARKS[row.kind]}${row.text}`,
  );

describe("diffLines", () => {
  it("marks what was put in and taken out, keeping the lines both have", () => {
    expect(shown(diffLines("a\nb\nc\n", "a\nx\nc\nd\n"))).toEqual([" a", "-b", "+x", " c", "+d"]);
  });

  it("finds a moved block as an insert and a delete around the common lines", () => {
    expect(shown(diffLines("one\ntwo\nthree\nfour", "one\nthree\nfour\ntwo"))).toEqual([
      " one",
      "-two",
      " three",
      " four",
      "+two",
    ]);
  });

  it("shows a new text as all added and a removed one as all removed", () => {
    expect(shown(diffLines("", "a\nb"))).toEqual(["+a", "+b"]);
    expect(shown(diffLines("a\nb\n", ""))).toEqual(["-a", "-b"]);
    expect(diffLines("", "")).toEqual([]);
  });

  it("has no change for the same text", () => {
    expect(Arr.every(diffLines("a\nb", "a\nb\n"), (line) => line.kind === "same")).toBe(true);
  });

  it("replaces a huge changed middle wholesale rather than tabulating it", () => {
    const before = numbered(3_000, (index) => `a${index}`);
    const after = numbered(3_000, (index) => `b${index}`);
    const lines = diffLines(before, after);

    expect(lines).toHaveLength(6_000);
    expect(lines[0]?.kind).toBe("removed");
    expect(lines.at(-1)?.kind).toBe("added");
  });
});

describe("foldDiff", () => {
  const lines = diffLines(
    numbered(20, (index) => `line ${index}`),
    numbered(20, (index) => (index === 10 ? "changed" : `line ${index}`)),
  );

  it("folds the unchanged lines far from a change into a count", () => {
    expect(shown(foldDiff(lines, 2))).toEqual([
      "… 8",
      " line 8",
      " line 9",
      "-line 10",
      "+changed",
      " line 11",
      " line 12",
      "… 7",
    ]);
  });

  it("shows a text that is all changes as it is", () => {
    expect(shown(foldDiff(diffLines("", "a\nb")))).toEqual(["+a", "+b"]);
  });
});

describe("changeDiff", () => {
  it("is for a script or the Toolchains, none being the empty text", () => {
    expect(shown(changeDiff("setupScript", "", "echo hi")!)).toEqual(["+echo hi"]);
    expect(shown(changeDiff("toolchains", "[tools]\n", null)!)).toEqual(["-[tools]"]);
    expect(shown(changeDiff("startScript", "a", "b")!)).toEqual(["-a", "+b"]);
  });

  it("is not for the other settings or values that are not text", () => {
    expect(changeDiff("idleMinutes", 2, 3)).toBeUndefined();
    expect(changeDiff("ignore", [], ["/a"])).toBeUndefined();
    expect(changeDiff("variables.A", "1", "2")).toBeUndefined();
    expect(changeDiff("setupScript", 1, "x")).toBeUndefined();
  });
});
