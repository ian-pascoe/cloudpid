// @effect-diagnostics preferEffectArray:off -- fixtures built over native arrays.
import { describe, expect, it } from "vitest";
import { filesToLoad, MAX_FILE_REQUESTS, poolSize } from "./loading.ts";

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

describe("filesToLoad", () => {
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];

  it("asks for the files in view first, then the nearest, at most 4 at a time", () => {
    expect(MAX_FILE_REQUESTS).toBe(4);
    expect(
      filesToLoad({
        placed: stacked(ids, 100),
        view: { top: 300, bottom: 500 },
        margin: 1000,
        wanted: () => true,
        inFlight: 0,
      }),
    ).toEqual(["d", "e", "c", "f"]);
  });

  it("asks only for as many as the requests out leave room for", () => {
    expect(
      filesToLoad({
        placed: stacked(ids, 100),
        view: { top: 0, bottom: 200 },
        margin: 1000,
        wanted: () => true,
        inFlight: 3,
      }),
    ).toEqual(["a"]);
    expect(
      filesToLoad({
        placed: stacked(ids, 100),
        view: { top: 0, bottom: 200 },
        margin: 1000,
        wanted: () => true,
        inFlight: 4,
      }),
    ).toEqual([]);
  });

  it("leaves files far from the view, and those that need no request (folded, loaded, loading)", () => {
    expect(
      filesToLoad({
        placed: stacked(ids, 100),
        view: { top: 0, bottom: 100 },
        margin: 150,
        wanted: (id) => id !== "b",
        inFlight: 0,
      }),
    ).toEqual(["a", "c"]);
  });
});
