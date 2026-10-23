import { describe, expect, it } from "vitest";
import { containedSize } from "./frame-view.ts";

describe("the frame's size in the Pane", () => {
  it("fits the Pane's width when the frame is the taller", () => {
    expect(containedSize({ width: 200, height: 350 }, { width: 400, height: 900 })).toEqual({
      width: 400,
      height: 700,
    });
  });

  it("fits the Pane's height when another device's taller viewport won", () => {
    expect(containedSize({ width: 390, height: 844 }, { width: 800, height: 422 })).toEqual({
      width: 195,
      height: 422,
    });
  });
});
