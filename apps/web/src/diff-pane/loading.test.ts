// @effect-diagnostics preferEffectArray:off -- fixtures built over native arrays.
import { describe, expect, it } from "vitest";
import { filesNear, needsLoad, poolSize } from "./loading.ts";

describe("poolSize", () => {
  it("is half the cores, kept between 2 and 4", () => {
    expect(poolSize(1)).toBe(2);
    expect(poolSize(4)).toBe(2);
    expect(poolSize(6)).toBe(3);
    expect(poolSize(8)).toBe(4);
    expect(poolSize(32)).toBe(4);
  });

  it("takes 2 when the browser does not say", () => {
    expect(poolSize(undefined)).toBe(2);
    expect(poolSize(0)).toBe(2);
  });
});

/** Files of `height` px each, one after another from the top. */
const stacked = (ids: readonly string[], height: number) =>
  ids.map((id, index) => ({ id, top: index * height, bottom: (index + 1) * height }));

describe("filesNear", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];

  it("lists the files in view first, then the nearest", () => {
    expect(
      filesNear({ placed: stacked(ids, 100), view: { top: 300, bottom: 500 }, margin: 150 }),
    ).toEqual([
      { id: "d", inView: true },
      { id: "e", inView: true },
      { id: "c", inView: false },
      { id: "f", inView: false },
      { id: "b", inView: false },
      { id: "g", inView: false },
    ]);
  });

  it("leaves the files farther than the margin", () => {
    expect(
      filesNear({ placed: stacked(ids, 100), view: { top: 0, bottom: 100 }, margin: 50 }),
    ).toEqual([
      { id: "a", inView: true },
      { id: "b", inView: false },
    ]);
  });
});

describe("needsLoad", () => {
  const loaded = { signature: "s", listing: 1 };

  it("asks for a file never loaded, or loaded for another change", () => {
    expect(needsLoad(undefined, { signature: "s", listing: 1, inView: false })).toBe(true);
    expect(needsLoad(loaded, { signature: "t", listing: 2, inView: false })).toBe(true);
  });

  it("asks again for the same change from a newer list only while the file is in view", () => {
    expect(needsLoad(loaded, { signature: "s", listing: 2, inView: false })).toBe(false);
    expect(needsLoad(loaded, { signature: "s", listing: 2, inView: true })).toBe(true);
    expect(needsLoad(loaded, { signature: "s", listing: 1, inView: true })).toBe(false);
  });
});
