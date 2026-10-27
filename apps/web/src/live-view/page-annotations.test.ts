// @effect-diagnostics preferEffectArray:off -- tests of plain functions over native arrays.
import {
  type Annotation,
  MAX_ANNOTATION_SELECTOR,
  MAX_QUOTE_LINES,
  type PageAnnotation,
} from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  areaBetween,
  draftsOnPage,
  isDrag,
  locatedBySelector,
  locateScript,
  pageDraft,
  pickedElement,
  placePins,
  quadRect,
  selectorsOf,
} from "./page-annotations.ts";

const onPage = (overrides: Partial<PageAnnotation> = {}): PageAnnotation => ({
  id: "p1",
  source: {
    kind: "page",
    url: "https://app.test/login",
    ownerTabId: "tab-1",
    element: { selector: "#login > button", tag: "button" },
    box: { x: 10, y: 20, width: 100, height: 30 },
    scroll: { x: 0, y: 100 },
    viewport: { width: 800, height: 600 },
  },
  quote: ["Sign in"],
  more: 0,
  text: "Bigger.",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const area = (overrides: Partial<PageAnnotation> = {}): PageAnnotation => {
  const { element: _element, ...source } = onPage().source;

  return onPage({ id: "a1", source, quote: [], ...overrides });
};

const FRAME = { scroll: { x: 0, y: 100 }, viewport: { width: 800, height: 600 } };

describe("drafts on a page", () => {
  it("are those at the page's address, fragment aside, from any Owner tab, and none on a diff", () => {
    const other = onPage({ id: "p2", source: { ...onPage().source, ownerTabId: "tab-2" } });

    const elsewhere = onPage({
      id: "p3",
      source: { ...onPage().source, url: "https://app.test/" },
    });

    const onDiff: Annotation = {
      id: "d1",
      source: { kind: "changes", repo: "app", head: null },
      path: "a.ts",
      side: "new",
      start: 1,
      end: 1,
      quote: [],
      more: 0,
      text: "x",
      createdAt: 1,
      updatedAt: 1,
    };

    expect(
      draftsOnPage([onPage(), other, elsewhere, onDiff], "https://app.test/login#top"),
    ).toEqual([onPage(), other]);
    expect(draftsOnPage([onPage()], undefined)).toEqual([]);
  });

  it("ask the page for each element's selector once", () => {
    expect(selectorsOf([onPage(), onPage({ id: "p2" }), area()])).toEqual(["#login > button"]);
    expect(locateScript(['a[href="x"]'])).toContain(JSON.stringify(['a[href="x"]']));
  });
});

describe("pins", () => {
  const located = (rect: { x: number; y: number; width: number; height: number } | null) =>
    new Map([["#login > button", rect]]);

  it("sit at the element where the page found it, numbered in order", () => {
    const rect = { x: 5, y: 6, width: 7, height: 8 };

    expect(placePins([area(), onPage()], located(rect), { x: 0, y: 100 })).toEqual({
      pinned: [
        { draft: area(), number: 1, rect: { x: 10, y: 20, width: 100, height: 30 } },
        { draft: onPage(), number: 2, rect },
      ],
      missing: [],
    });
  });

  it("of an area move with the page's scroll since it was drawn", () => {
    expect(placePins([area()], undefined, { x: 4, y: 150 }).pinned[0]?.rect).toEqual({
      x: 6,
      y: -30,
      width: 100,
      height: 30,
    });
  });

  it("are not found on the page when its element is gone, and wait while the page has not said", () => {
    expect(placePins([onPage()], located(null), { x: 0, y: 0 })).toEqual({
      pinned: [],
      missing: [{ draft: onPage(), number: 1 }],
    });
    expect(placePins([onPage()], undefined, { x: 0, y: 0 })).toEqual({ pinned: [], missing: [] });
  });

  it("are found again only for the page the answer was of", () => {
    const answer = {
      url: "https://app.test/login#x",
      rects: [{ x: 1, y: 2, width: 3, height: 4 }],
    };

    expect(locatedBySelector(["#a"], answer, "https://app.test/login")).toEqual(
      new Map([["#a", { x: 1, y: 2, width: 3, height: 4 }]]),
    );
    expect(locatedBySelector(["#a"], answer, "https://app.test/other")).toBeUndefined();
  });
});

describe("picking", () => {
  it("is a drag past the slop, and an area spans the two corners either way", () => {
    expect(isDrag({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(false);
    expect(isDrag({ x: 0, y: 0 }, { x: 6, y: 8 })).toBe(true);
    expect(areaBetween({ x: 50, y: 10 }, { x: 20, y: 40 })).toEqual({
      x: 20,
      y: 10,
      width: 30,
      height: 30,
    });
  });

  it("reads the box of an element's border quad", () => {
    expect(quadRect([10, 20, 110, 20, 110, 50, 10, 50])).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 30,
    });
    expect(quadRect([1, 2])).toBeUndefined();
  });

  it("keeps an element no selector finds again as an area at its box", () => {
    const box = { x: 1, y: 2, width: 3, height: 4 };

    expect(
      pickedElement({ tag: "iframe", selector: null, text: ["Hi"], more: 0 }, box, FRAME),
    ).toEqual({ box, text: ["Hi"], more: 0, ...FRAME });
    expect(
      pickedElement({ tag: "button", selector: "#go", text: [], more: 0 }, box, FRAME).element,
    ).toEqual({ selector: "#go", tag: "button" });
  });
});

describe("a page draft", () => {
  const picked = pickedElement(
    { tag: "button", selector: "#login > button", text: ["Sign in"], more: 0 },
    { x: 10.123, y: 20, width: 100, height: 30 },
    FRAME,
  );

  it("carries the page without its fragment, the element, its text as the quote, the crop and the owner's text", () => {
    const crop = { mimeType: "image/jpeg" as const, data: "QUJD" };

    expect(
      pageDraft(
        "n1",
        picked,
        { url: "https://app.test/login#top", ownerTabId: "tab-1" },
        crop,
        "Bigger.",
      ),
    ).toEqual({
      id: "n1",
      source: {
        kind: "page",
        url: "https://app.test/login",
        ownerTabId: "tab-1",
        element: { selector: "#login > button", tag: "button" },
        box: { x: 10.12, y: 20, width: 100, height: 30 },
        scroll: { x: 0, y: 100 },
        viewport: { width: 800, height: 600 },
      },
      quote: ["Sign in"],
      more: 0,
      crop,
      text: "Bigger.",
    });
  });

  it("cuts the page's text as the Session keeps it, and keeps an element whose selector would be cut as an area", () => {
    const long = pickedElement(
      {
        tag: "div",
        // Each `>` is four bytes as the Review writes it: past the limit, though short in characters.
        selector: Array.from({ length: MAX_ANNOTATION_SELECTOR / 4 }, () => "a").join(" > "),
        text: Array.from({ length: MAX_QUOTE_LINES + 5 }, (_, index) => `line ${index}`),
        more: 10,
      },
      { x: 0, y: 0, width: 1, height: 1 },
      FRAME,
    );

    const draft = pageDraft(
      "n2",
      long,
      { url: "https://app.test/", ownerTabId: "t" },
      undefined,
      "x",
    );

    expect(draft.source.element).toBeUndefined();
    expect(draft.quote).toHaveLength(MAX_QUOTE_LINES);
    expect(draft.more).toBe(15);
    expect(draft).not.toHaveProperty("crop");
  });
});
