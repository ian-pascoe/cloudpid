import { describe, expect, it } from "vitest";
import { fileDiffOf, placeholderDiff } from "./file-diff.ts";
import { lineUp } from "./line-up.ts";

describe("fileDiffOf", () => {
  it("draws a lined-up change over both whole sides, under the name the Pane shows", () => {
    const oldText = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n";
    const newText = oldText.replace("two", "2");
    const { patch } = lineUp({ oldName: "src/a.ts", newName: "src/a.ts", oldText, newText });

    const diff = fileDiffOf({
      names: { name: "web/src/a.ts", status: "modified" },
      oldText,
      newText,
      patch,
      cacheKey: "web/src/a.ts@1",
    });

    expect(diff).toMatchObject({ name: "web/src/a.ts", type: "change", isPartial: false });
    expect(diff?.prevName).toBeUndefined();
    expect(diff?.hunks).toHaveLength(1);
    expect(diff?.hunks[0]).toMatchObject({ additionLines: 1, deletionLines: 1 });
    // The whole file, so the lines around the hunk can be expanded.
    expect(diff?.additionLines).toHaveLength(10);
  });

  it("draws a new file, a deletion and a rename with their kinds", () => {
    const added = fileDiffOf({
      names: { name: "n.ts", status: "added" },
      oldText: null,
      newText: "a\n",
      patch: lineUp({ oldName: null, newName: "n.ts", oldText: null, newText: "a\n" }).patch,
      cacheKey: "n",
    });

    const deleted = fileDiffOf({
      names: { name: "d.ts", status: "deleted" },
      oldText: "a\n",
      newText: null,
      patch: lineUp({ oldName: "d.ts", newName: null, oldText: "a\n", newText: null }).patch,
      cacheKey: "d",
    });

    const renamed = fileDiffOf({
      names: { name: "new.ts", prevName: "old.ts", status: "renamed" },
      oldText: "a\n",
      newText: "b\n",
      patch: lineUp({ oldName: "old.ts", newName: "new.ts", oldText: "a\n", newText: "b\n" }).patch,
      cacheKey: "r",
    });

    expect(added).toMatchObject({ type: "new", name: "n.ts" });
    expect(deleted).toMatchObject({ type: "deleted", name: "d.ts" });
    expect(renamed).toMatchObject({ type: "rename-changed", name: "new.ts", prevName: "old.ts" });
  });

  it("has nothing to draw when the sides' text is the same", () => {
    expect(
      fileDiffOf({
        names: { name: "same.ts", status: "modified" },
        oldText: "a\n",
        newText: "a\n",
        patch: lineUp({ oldName: "same.ts", newName: "same.ts", oldText: "a\n", newText: "a\n" })
          .patch,
        cacheKey: "s",
      }),
    ).toBeUndefined();
  });
});

describe("placeholderDiff", () => {
  it("has no lines, and the file's name and kind", () => {
    expect(placeholderDiff({ name: "a.ts", prevName: "b.ts", status: "renamed" })).toMatchObject({
      name: "a.ts",
      prevName: "b.ts",
      type: "rename-changed",
      hunks: [],
      unifiedLineCount: 0,
    });
  });
});
