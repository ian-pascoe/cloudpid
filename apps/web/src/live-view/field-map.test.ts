import { describe, expect, it } from "vitest";
import { hintsFor, hitTest, type Field, type FieldMap } from "./field-map.ts";

const field = (overrides: Partial<Field>): Field => ({
  x: 0,
  y: 0,
  w: 100,
  h: 30,
  type: "text",
  inputMode: "",
  enterKeyHint: "",
  autocapitalize: "",
  picker: undefined,
  ...overrides,
});

const map = (items: readonly Field[], scrollY = 0): FieldMap => ({
  scrollX: 0,
  scrollY,
  items,
  at: 0,
});

describe("hit testing a tap against the field map", () => {
  const email = field({ x: 20, y: 100, w: 200, h: 30, type: "email" });

  it("finds the field under the point, with a few px of slack around it", () => {
    expect(hitTest(map([email]), { x: 30, y: 110 }, { x: 0, y: 0 })).toBe(email);
    expect(hitTest(map([email]), { x: 18, y: 97 }, { x: 0, y: 0 })).toBe(email);
    expect(hitTest(map([email]), { x: 30, y: 140 }, { x: 0, y: 0 })).toBeUndefined();
  });

  it("moves the map's rects by how far the tab scrolled since it was read", () => {
    // Read at scroll 0; the tab has since scrolled 80 px down, so the field is 80 px higher on the screen.
    expect(hitTest(map([email]), { x: 30, y: 110 }, { x: 0, y: 80 })).toBeUndefined();
    expect(hitTest(map([email]), { x: 30, y: 30 }, { x: 0, y: 80 })).toBe(email);
  });

  it("prefers the smallest rect, so a field inside a larger label wins", () => {
    const label = field({ x: 0, y: 90, w: 400, h: 60, type: "text" });
    const inner = field({ x: 20, y: 100, w: 100, h: 30, type: "tel" });

    expect(hitTest(map([label, inner]), { x: 30, y: 110 }, { x: 0, y: 0 })).toBe(inner);
    expect(hitTest(map([label, inner]), { x: 300, y: 110 }, { x: 0, y: 0 })).toBe(label);
  });
});

describe("the keyboard hints for a field", () => {
  it("follows the field's type", () => {
    expect(hintsFor(field({ type: "email" }))).toEqual({
      inputMode: "email",
      autocapitalize: "off",
      enterKeyHint: "go",
      autocorrect: "off",
    });
    expect(hintsFor(field({ type: "number" })).inputMode).toBe("decimal");
    expect(hintsFor(field({ type: "textarea" }))).toEqual({
      inputMode: "text",
      autocapitalize: "sentences",
      enterKeyHint: "enter",
      autocorrect: "on",
    });
    expect(hintsFor(field({ type: "password" })).autocorrect).toBe("off");
  });

  it("takes the field's own attributes over its type's", () => {
    expect(
      hintsFor(field({ type: "text", inputMode: "numeric", enterKeyHint: "done" })),
    ).toMatchObject({ inputMode: "numeric", enterKeyHint: "done" });
  });

  it("treats an unknown type as text", () => {
    expect(hintsFor(field({ type: "weird" })).inputMode).toBe("text");
  });
});
