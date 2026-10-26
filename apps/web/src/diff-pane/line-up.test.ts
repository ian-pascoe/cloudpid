// @effect-diagnostics preferEffectArray:off -- fixtures built over native arrays.
import { describe, expect, it } from "vitest";
import { LINE_UP_TIMEOUT_MS, lineUp, wholeFilePatch } from "./line-up.ts";

const lines = (count: number, prefix: string): string =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`).join("");

describe("lineUp", () => {
  it("lines up a small change as hunks of context, with the budget of 2 s", () => {
    expect(LINE_UP_TIMEOUT_MS).toBe(2000);

    const result = lineUp({
      oldName: "src/a.ts",
      newName: "src/a.ts",
      oldText: "one\ntwo\nthree\n",
      newText: "one\n2\nthree\n",
    });

    expect(result.replaced).toBe(false);
    expect(result.patch).toContain("--- src/a.ts\n+++ src/a.ts\n");
    expect(result.patch).toContain("@@ -1,3 +1,3 @@\n one\n-two\n+2\n three\n");
  });

  it("gives up past its budget and shows the file replaced whole", () => {
    const oldText = lines(20_000, "old line");
    const newText = lines(20_000, "new line");
    const started = performance.now();
    const result = lineUp({ oldName: "big.txt", newName: "big.txt", oldText, newText }, 50);

    expect(performance.now() - started).toBeLessThan(1500);
    expect(result.replaced).toBe(true);
    expect(result.patch).toBe(wholeFilePatch("big.txt", "big.txt", oldText, newText));
  });

  it("writes a new file and a deleted one whole, without lining anything up", () => {
    expect(lineUp({ oldName: null, newName: "n.txt", oldText: null, newText: "a\nb\n" })).toEqual({
      patch: "--- /dev/null\n+++ n.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n",
      replaced: false,
    });
    expect(lineUp({ oldName: "d.txt", newName: null, oldText: "a\n", newText: null })).toEqual({
      patch: "--- d.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n",
      replaced: false,
    });
  });

  it("keeps a rename's two names", () => {
    const result = lineUp({ oldName: "old.ts", newName: "new.ts", oldText: "a\n", newText: "b\n" });

    expect(result.patch).toContain("--- old.ts\n+++ new.ts\n");
  });
});

describe("wholeFilePatch", () => {
  it("removes every old line and adds every new one in one hunk", () => {
    expect(wholeFilePatch("a", "a", "x\ny\n", "z\n")).toBe(
      "--- a\n+++ a\n@@ -1,2 +1,1 @@\n-x\n-y\n+z\n",
    );
  });

  it("marks a side that has no newline at its end", () => {
    expect(wholeFilePatch("a", "a", "x\ny", "z")).toBe(
      "--- a\n+++ a\n@@ -1,2 +1,1 @@\n-x\n-y\n\\ No newline at end of file\n+z\n\\ No newline at end of file\n",
    );
  });

  it("has nothing to write when both sides are empty", () => {
    expect(wholeFilePatch("a", "a", "", "")).toBe("--- a\n+++ a\n");
  });
});
