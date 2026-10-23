import { describe, expect, it } from "vitest";
import { menuItems, placeMenu, type MenuProbe } from "./edit-menu.ts";

const probe = (overrides: Partial<MenuProbe>): MenuProbe => ({
  target: false,
  focused: false,
  editableSelection: false,
  text: "",
  rect: null,
  ...overrides,
});

describe("the edit menu's items", () => {
  it("offers Copy for a selection in the page", () => {
    expect(menuItems(probe({ text: "word" }))).toEqual(["Copy"]);
  });

  it("offers everything for a selection in a field", () => {
    expect(menuItems(probe({ text: "word", target: true, editableSelection: true }))).toEqual([
      "Copy",
      "Cut",
      "Paste",
      "Select All",
    ]);
  });

  it("offers Paste and Select All in a field with nothing selected, after a long press or double tap", () => {
    expect(menuItems(probe({ target: true }))).toEqual(["Paste", "Select All"]);
    expect(menuItems(probe({ target: true }))).toEqual(["Paste", "Select All"]);
  });

  it("shows nothing outside a field with nothing selected", () => {
    expect(menuItems(probe({}))).toEqual([]);
    expect(menuItems(probe({}))).toEqual([]);
  });
});

describe("where the edit menu goes", () => {
  const frame = { left: 0, top: 100, width: 400, height: 600 };
  const menu = { width: 200, height: 40 };

  it("goes above the selection, centred on it", () => {
    expect(placeMenu({ x: 150, y: 400, w: 100, h: 20 }, frame, menu)).toEqual({
      x: 100,
      y: 350,
      side: "above",
    });
  });

  it("goes below when there is no room above", () => {
    expect(placeMenu({ x: 150, y: 120, w: 100, h: 20 }, frame, menu)).toEqual({
      x: 100,
      y: 150,
      side: "below",
    });
  });

  it("stays inside the frame", () => {
    expect(placeMenu({ x: 380, y: 400, w: 10, h: 20 }, frame, menu).x).toBe(196);
    expect(placeMenu({ x: 0, y: 400, w: 10, h: 20 }, frame, menu).x).toBe(4);
  });
});
