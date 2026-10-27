// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain functions over the Session's drafts and the page's rects.

// Annotations on pages in the Browser Pane (#243; `docs/spec.md` → Browser → Annotate mode): what the Pane asks the page
// shown (the element under the pointer, what it is and says, where the drafts' elements are now), which drafts are on
// the page shown, where their pins go, and the draft a pick makes. Pure, but for the scripts it sends the page.

import {
  type Annotation,
  clampPageSource,
  isPageAnnotation,
  MAX_ANNOTATION_SELECTOR,
  type PageAnnotation,
  type PageAnnotationDraft,
  type PageCrop,
  type PageElement,
  pageQuote,
  type PageRect,
  type PageSource,
  withoutFragment,
} from "@cloudpid/protocol";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import type { Point } from "./cdp.ts";

/** How far a pointer moves, in CSS px of the screen, before a press is a drag (an area) and not a click (an element). */
export const DRAG_SLOP = 8;

/** The most lines of an element's text the page sends: the quote keeps 50 of them, and counts the rest. */
const MAX_TEXT_LINES = 200;

/** The longest line of an element's text the page sends, in UTF-16 code units: the quote cuts it further. */
const MAX_TEXT_LINE = 2_000;

/**
 * What `DESCRIBE_FUNCTION` answers of the element picked: its tag, a selector that finds it again (null when none fits
 * `MAX_ANNOTATION_SELECTOR` or it sits in a frame), and its visible text in lines, with how many lines it left out.
 */
export const Described = Schema.Struct({
  tag: Schema.String,
  selector: Schema.NullOr(Schema.String),
  text: Schema.Array(Schema.String),
  more: Schema.Finite,
});

export type Described = typeof Described.Type;

/**
 * The function `Runtime.callFunctionOn` runs on the node `DOM.getNodeForLocation` found (`this`): the element it is (or
 * holds it, for text), out of any shadow root to its host, as `Described`. The selector is the shortest path of
 * `>`-joined steps that finds only it, anchored at the nearest unique ID or test attribute, measured as the Review writes
 * it, escaped. The text is what the page shows (`innerText`), else the element's accessible label; never a field's
 * value, which may be a password.
 */
export const DESCRIBE_FUNCTION = `function () {
  let el = this.nodeType === 1 ? this : this.parentElement;
  if (el === null) return null;
  while (el.getRootNode() instanceof ShadowRoot) el = el.getRootNode().host;
  const unique = (selector) => {
    try { return document.querySelectorAll(selector).length === 1; } catch { return false; }
  };
  const cost = (text) => text.length + 4 * (text.split("&").length - 1) + 3 * (text.split("<").length - 1) +
    3 * (text.split(">").length - 1) + 5 * (text.split('"').length - 1);
  const anchor = (node) => {
    if (node.id !== "" && unique("#" + CSS.escape(node.id))) return "#" + CSS.escape(node.id);
    for (const name of ["data-testid", "data-test", "data-qa", "name", "aria-label"]) {
      const value = node.getAttribute(name);
      const selector = node.localName + "[" + name + '="' + CSS.escape(value ?? "") + '"]';
      if (value !== null && value !== "" && unique(selector)) return selector;
    }
    return null;
  };
  const step = (node) => {
    let index = 1;
    let others = false;
    for (let sibling = node.previousElementSibling; sibling !== null; sibling = sibling.previousElementSibling)
      if (sibling.localName === node.localName) index++;
    for (let sibling = node.nextElementSibling; sibling !== null; sibling = sibling.nextElementSibling)
      if (sibling.localName === node.localName) { others = true; break; }
    return index > 1 || others ? CSS.escape(node.localName) + ":nth-of-type(" + index + ")" : CSS.escape(node.localName);
  };
  let selector = null;
  if (window.top === window) {
    const steps = [];
    for (let node = el; node !== null && node.nodeType === 1; node = node.parentElement) {
      const found = anchor(node);
      steps.unshift(found ?? step(node));
      const joined = steps.join(" > ");
      if (cost(joined) > ${MAX_ANNOTATION_SELECTOR}) break;
      if (found !== null || unique(joined)) { selector = unique(joined) ? joined : null; break; }
    }
  }
  const shown = typeof el.innerText === "string" ? el.innerText : el.textContent ?? "";
  const label = shown.trim() !== "" ? shown :
    el.getAttribute("aria-label") ?? el.getAttribute("alt") ?? el.getAttribute("title") ?? el.getAttribute("placeholder") ?? "";
  const lines = label.split("\\n").map((line) => line.trim()).filter((line) => line !== "");
  return {
    tag: el.localName,
    selector,
    text: lines.slice(0, ${MAX_TEXT_LINES}).map((line) => line.slice(0, ${MAX_TEXT_LINE})),
    more: Math.max(0, lines.length - ${MAX_TEXT_LINES}),
  };
}`;

/** A rect as the page measures it, or null for an element not found (or not shown). */
const LocatedRect = Schema.NullOr(
  Schema.Struct({
    x: Schema.Finite,
    y: Schema.Finite,
    width: Schema.Finite,
    height: Schema.Finite,
  }),
);

/** What `locateScript` answers: the page's URL, and each selector's element's rect in the viewport, in order. */
export const Located = Schema.Struct({
  url: Schema.String,
  rects: Schema.Array(LocatedRect),
});

export type Located = typeof Located.Type;

/**
 * The expression that finds each of `selectors` on the page shown: its first element's rect in the viewport, or null when
 * none matches, it is not shown (no size), or the selector does not parse.
 */
export const locateScript = (selectors: readonly string[]): string => `(() => {
  const selectors = ${JSON.stringify(selectors)};
  return {
    url: location.href,
    rects: selectors.map((selector) => {
      try {
        const element = document.querySelector(selector);
        if (element === null) return null;
        const rect = element.getBoundingClientRect();
        return rect.width === 0 && rect.height === 0 ? null : { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      } catch { return null; }
    }),
  };
})()`;

/** `DOM.getNodeForLocation`'s answer: the node under the point. */
export const NodeForLocation = Schema.Struct({ backendNodeId: Schema.Finite });

/** `DOM.getBoxModel`'s answer: the node's border quad, in the viewport's CSS px. */
export const BoxModel = Schema.Struct({
  model: Schema.Struct({ border: Schema.Array(Schema.Finite) }),
});

/** `DOM.resolveNode`'s answer: a handle on the node, in the page's scripts. */
export const ResolvedNode = Schema.Struct({
  object: Schema.Struct({ objectId: Schema.optional(Schema.String) }),
});

/** `Runtime.callFunctionOn`'s answer, read by value. */
export const CalledFunction = Schema.Struct({
  result: Schema.Struct({ value: Schema.optional(Schema.Unknown) }),
  exceptionDetails: Schema.optional(Schema.Unknown),
});

/** The rect around a quad (four corners, x then y), as `DOM.getBoxModel` gives them. */
export const quadRect = (quad: readonly number[]): PageRect | undefined => {
  if (quad.length < 8) return undefined;

  const xs = [quad[0] ?? 0, quad[2] ?? 0, quad[4] ?? 0, quad[6] ?? 0];
  const ys = [quad[1] ?? 0, quad[3] ?? 0, quad[5] ?? 0, quad[7] ?? 0];
  const x = Math.min(...xs);
  const y = Math.min(...ys);

  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};

/** Whether a press from `from` to `to` (on the screen) moved far enough to be a drag: an area, not an element. */
export const isDrag = (from: Point, to: Point): boolean =>
  Math.hypot(to.x - from.x, to.y - from.y) >= DRAG_SLOP;

/** The area dragged out between two points of the page's viewport. */
export const areaBetween = (a: Point, b: Point): PageRect => ({
  x: Math.min(a.x, b.x),
  y: Math.min(a.y, b.y),
  width: Math.abs(b.x - a.x),
  height: Math.abs(b.y - a.y),
});

/** The page drafts on the page at `url`, whichever Owner tab they were drawn in: the same address, fragment aside. */
export const draftsOnPage = (
  annotations: readonly Annotation[],
  url: string | undefined,
): readonly PageAnnotation[] => {
  if (url === undefined) return [];

  const page = withoutFragment(url);

  return annotations.filter(
    (annotation): annotation is PageAnnotation =>
      isPageAnnotation(annotation) && annotation.source.url === page,
  );
};

/** The distinct selectors of `drafts`' elements, in order: what the Pane asks the page to find. */
export const selectorsOf = (drafts: readonly PageAnnotation[]): readonly string[] =>
  Array.from(
    new Set(
      drafts.flatMap((draft) =>
        draft.source.element === undefined ? [] : [draft.source.element.selector],
      ),
    ),
  );

/** A pin: a draft, its number on the page, and where it is in the viewport now. */
export interface Pin {
  readonly draft: PageAnnotation;
  readonly number: number;
  readonly rect: PageRect;
}

/** Where the drafts on the page shown are: pinned, or not found on the page (an element the page no longer has). */
export interface Pins {
  readonly pinned: readonly Pin[];
  readonly missing: readonly { readonly draft: PageAnnotation; readonly number: number }[];
}

/**
 * Where each of `drafts` is in the viewport now: an element's where the page found it (`located`, for the page at its
 * URL; not yet read, it is neither pinned nor missing), an area's where it was drawn, moved by how far the page scrolled
 * since (`scroll`, the frame's). Numbered in order, from 1.
 */
export const placePins = (
  drafts: readonly PageAnnotation[],
  located: ReadonlyMap<string, PageRect | null> | undefined,
  scroll: Point,
): Pins => {
  const pinned: Pin[] = [];
  const missing: { draft: PageAnnotation; number: number }[] = [];

  for (const [index, draft] of drafts.entries()) {
    const number = index + 1;
    const { element, box } = draft.source;

    if (element === undefined) {
      const moved = {
        x: box.x + draft.source.scroll.x - scroll.x,
        y: box.y + draft.source.scroll.y - scroll.y,
        width: box.width,
        height: box.height,
      };

      pinned.push({ draft, number, rect: moved });
      continue;
    }

    if (located === undefined || !located.has(element.selector)) continue;

    const rect = located.get(element.selector);

    if (rect === null || rect === undefined) missing.push({ draft, number });
    else pinned.push({ draft, number, rect });
  }

  return { pinned, missing };
};

/** `located`'s answer by selector, when it is of the page at `url`; undefined for another page (one navigated away). */
export const locatedBySelector = (
  selectors: readonly string[],
  located: Located,
  url: string,
): ReadonlyMap<string, PageRect | null> | undefined => {
  if (withoutFragment(located.url) !== withoutFragment(url)) return undefined;

  return new Map(selectors.map((selector, index) => [selector, located.rects[index] ?? null]));
};

/** What a pick in Annotate mode found: an element (with its text), or an area; where, and the page's state then. */
export interface Picked {
  readonly box: PageRect;
  readonly element?: PageElement | undefined;
  readonly text: readonly string[];
  readonly more: number;
  readonly scroll: Point;
  readonly viewport: { readonly width: number; readonly height: number };
}

/** The pick of an element `described` at `box`: an area at its box when no selector finds it again. */
export const pickedElement = (
  described: Described,
  box: PageRect,
  frame: Pick<Picked, "scroll" | "viewport">,
): Picked => {
  const picked = { box, text: described.text, more: described.more, ...frame };

  if (described.selector === null || described.selector === "") return picked;

  return { ...picked, element: { selector: described.selector, tag: described.tag } };
};

/**
 * The draft of `picked` on the page at `url` in Owner tab `ownerTabId`, with its crop and the owner's `text`: what the
 * page supplied cut and cleaned as the Session keeps it (`clampPageSource`, `pageQuote`). An element whose selector would
 * be cut is kept as an area, since a cut selector finds nothing.
 */
export const pageDraft = (
  id: string,
  picked: Picked,
  page: { readonly url: string; readonly ownerTabId: string },
  crop: PageCrop | undefined,
  text: string,
): PageAnnotationDraft => {
  const round = (value: number) => Math.round(value * 100) / 100;

  const unclamped: Types.Mutable<PageSource> = {
    kind: "page",
    url: page.url,
    ownerTabId: page.ownerTabId,
    box: {
      x: round(picked.box.x),
      y: round(picked.box.y),
      width: round(Math.max(0, picked.box.width)),
      height: round(Math.max(0, picked.box.height)),
    },
    scroll: { x: round(picked.scroll.x), y: round(picked.scroll.y) },
    viewport: {
      width: round(Math.max(0, picked.viewport.width)),
      height: round(Math.max(0, picked.viewport.height)),
    },
  };

  if (picked.element !== undefined) unclamped.element = picked.element;

  let source = clampPageSource(unclamped);

  if (source.element !== undefined && source.element.selector !== picked.element?.selector) {
    const { element: _cut, ...area } = source;

    source = area;
  }

  const { quote, more, clipped } = pageQuote(picked.text, picked.more);
  const draft: Types.Mutable<PageAnnotationDraft> = { id, source, quote, more, text };

  if (clipped === true) draft.clipped = true;

  if (crop !== undefined) draft.crop = crop;

  return draft;
};

/** What a page draft is on, as the Pane names it: its element's tag, as `<button>`, or an area. */
export const pinLabel = (source: PageSource): string =>
  source.element === undefined ? "An area" : `<${source.element.tag}>`;
