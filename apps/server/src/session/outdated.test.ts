// @effect-diagnostics preferEffectArray:off -- tests of plain functions over lines.
import type { Annotation, RepoChanges } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { checked, checkQuote, linesOf, listedFile, sideLines } from "./outdated.ts";

const draft = (overrides: Partial<Annotation> = {}): Annotation => ({
  id: "a1",
  source: { kind: "changes", repo: "app", head: "old-head" },
  path: "src/a.ts",
  side: "new",
  start: 3,
  end: 4,
  quote: ["const b = 2;", "const c = 3;"],
  more: 0,
  text: "Why?",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const file = ["const a = 1;", "", "const b = 2;", "const c = 3;", "export {};"];

describe("checkQuote", () => {
  it("finds a quote still in place", () => {
    expect(checkQuote(draft(), file)).toEqual({ kind: "same" });
  });

  it("moves a draft whose quote is found exactly once elsewhere, keeping its length", () => {
    expect(checkQuote(draft(), ["// added", "// added", ...file])).toEqual({
      kind: "moved",
      start: 5,
      end: 6,
    });
  });

  it("marks outdated a draft whose quote is found twice elsewhere", () => {
    const twice = ["const b = 2;", "const c = 3;", "x", "y", "const b = 2;", "const c = 3;"];

    expect(checkQuote(draft(), twice)).toEqual({ kind: "outdated" });
  });

  it("marks outdated a draft whose quote is gone", () => {
    expect(checkQuote(draft(), ["const a = 1;", "", "const b = 20;", "const c = 3;"])).toEqual({
      kind: "outdated",
    });
  });

  it("compares only the lines a cut quote kept, the range staying as it was", () => {
    const cut = draft({ start: 1, end: 60, quote: ["const a = 1;", ""], more: 58 });

    expect(checkQuote(cut, file)).toEqual({ kind: "same" });
    expect(checkQuote(cut, ["new", ...file])).toEqual({ kind: "moved", start: 2, end: 61 });
  });

  it("needs a clipped last line only to start the same", () => {
    const clipped = draft({ start: 1, end: 1, quote: ["const a"], clipped: true });

    expect(checkQuote(clipped, file)).toEqual({ kind: "same" });
  });
});

describe("linesOf", () => {
  it("splits on newlines, without their endings, the last newline ending a line", () => {
    expect(linesOf("a\r\nb\n\nc\n")).toEqual(["a", "b", "", "c"]);
    expect(linesOf("")).toEqual([]);
  });
});

const repo = (overrides: Partial<RepoChanges> = {}): RepoChanges => ({
  repo: "app",
  head: { commit: "new-head", branch: "main" },
  files: [{ path: "src/a.ts", status: "modified", additions: 1, deletions: 0 }],
  more: 0,
  stale: false,
  ...overrides,
});

describe("listedFile", () => {
  it("finds the draft's file in its repo", () => {
    expect(listedFile(draft(), [repo()])).toMatchObject({
      kind: "file",
      entry: { path: "src/a.ts" },
    });
  });

  it("says the file is gone when its repo lists every file and not it", () => {
    expect(listedFile(draft({ path: "src/gone.ts" }), [repo()])).toEqual({ kind: "gone" });
  });

  it("cannot tell when the repo failed to list, is not listed, or has more files than the list holds", () => {
    const elsewhere = draft({ path: "src/gone.ts" });

    expect(listedFile(elsewhere, [repo({ error: "failed" })])).toEqual({ kind: "unknown" });
    expect(listedFile(elsewhere, [])).toEqual({ kind: "unknown" });
    expect(listedFile(elsewhere, [repo({ more: 3 })])).toEqual({ kind: "unknown" });
  });
});

describe("sideLines", () => {
  it("reads the draft's side, a side that is not there having no lines, and one that is not text none to compare", () => {
    const changed = { old: { kind: "text" as const, text: "old\n" }, new: null };

    expect(sideLines(draft({ side: "old" }), changed)).toEqual(["old"]);
    expect(sideLines(draft(), changed)).toEqual([]);
    expect(sideLines(draft(), { old: null, new: { kind: "binary" } })).toBeUndefined();
  });
});

describe("checked", () => {
  it("moves a draft and takes the HEAD now, or marks it and keeps its place", () => {
    expect(
      checked(draft({ status: "outdated" }), { kind: "moved", start: 9, end: 10 }, "new-head"),
    ).toEqual(
      draft({ source: { kind: "changes", repo: "app", head: "new-head" }, start: 9, end: 10 }),
    );
    expect(checked(draft(), { kind: "outdated" }, "new-head")).toEqual(
      draft({ status: "outdated" }),
    );
    expect(checked(draft(), { kind: "gone" }, "new-head")).toEqual(draft({ status: "gone" }));
  });
});
