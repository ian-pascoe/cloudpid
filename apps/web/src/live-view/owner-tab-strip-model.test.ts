import { describe, expect, it } from "vitest";
import { stripOf } from "./owner-tab-strip-model.ts";

describe("the Browser Pane's tab strip", () => {
  it("lists the Owner tabs by title, marks the one shown, and calls a page without a title a new tab", () => {
    expect(
      stripOf(
        {
          tabs: [
            { id: "a", title: "Docs" },
            { id: "b", title: "  " },
          ],
          shown: "b",
        },
        false,
      ),
    ).toEqual({
      tabs: [
        { id: "a", title: "Docs", shown: false },
        { id: "b", title: "New tab", shown: true },
      ],
      canOpen: true,
    });
  });

  it("is + alone once the last Owner tab is closed (or before any is heard of), and offers none in an archived Session", () => {
    expect(stripOf({ tabs: [] }, false)).toEqual({ tabs: [], canOpen: true });
    expect(stripOf(null, false)).toEqual({ tabs: [], canOpen: true });
    expect(stripOf({ tabs: [{ id: "a", title: "Docs" }], shown: "a" }, true).canOpen).toBe(false);
  });
});
