import { describe, expect, it } from "vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { menuItems, MenuProbe, menuProbeScript, placeMenu, wordAtScript } from "./edit-menu.ts";

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

/** What the scripts read of a document: a fake one here. */
interface FakeDocument {
  readonly activeElement: object;
  readonly elementFromPoint: () => object;
  readonly getSelection: () => { readonly isCollapsed: boolean; readonly rangeCount: number };
}

/** Run one of the tab's scripts against a fake `document`, its answer read by `schema`, as the Live View reads it. */
const runInTab = <A>(
  script: string,
  document: FakeDocument,
  schema: Schema.Decoder<A>,
): Option.Option<A> =>
  Schema.decodeUnknownOption(schema)(
    // oxlint-disable-next-line typescript/no-implied-eval -- SAFETY: the module's own scripts, run as the tab runs them.
    new Function("document", "window", `return ${script}`)(document, {}),
  );

/** A page whose only content is a same-origin iframe holding a focused, selected field. */
const pageWithFieldInIframe = () => {
  const field = {
    nodeType: 1,
    tagName: "INPUT",
    type: "text",
    value: "secret",
    selectionStart: 0,
    selectionEnd: 6,
    closest: () => null,
  };

  const inner = {
    activeElement: field,
    elementFromPoint: () => field,
    getSelection: () => ({ isCollapsed: true, rangeCount: 0 }),
  };

  const iframe = {
    nodeType: 1,
    tagName: "IFRAME",
    shadowRoot: null,
    contentDocument: inner,
    closest: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 300 }),
  };

  return {
    activeElement: iframe,
    elementFromPoint: () => iframe,
    getSelection: () => ({ isCollapsed: true, rangeCount: 0 }),
  };
};

describe("the edit menu's scripts", () => {
  it("do not reach into an iframe", () => {
    expect(runInTab(menuProbeScript(10, 10), pageWithFieldInIframe(), MenuProbe)).toEqual(
      Option.some({
        target: false,
        focused: false,
        editableSelection: false,
        text: "",
        rect: null,
      }),
    );
    expect(runInTab(wordAtScript(10, 10), pageWithFieldInIframe(), Schema.Boolean)).toEqual(
      Option.some(false),
    );
  });
});
