// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- four menu items over native arrays, and plain functions rather than combinators.

// The Live View's edit menu (#154). The frame is a picture and the typing textarea is invisible, so iOS has nothing to
// show its own edit menu for. This one, iOS-style, shows after a double tap on text or in a field (the tab gets a mouse
// double-click, which selects the word), after a long-press selection, and after a long press in a field: Copy when the
// tab has a selection, Cut with a selection in a field, Paste and Select All in a field. It goes above the selection
// (below when there is no room) and hides at the next touch, scroll or typing. Not from iframes (of any origin) or
// images: the menu's scripts stop at an iframe, though the keyboard's field map reaches into same-origin ones.
//
// The tab's side is a few `Runtime.evaluate` scripts: the probe finds the field or contenteditable under a point (kept
// in the tab as the target of Paste and Select All) and the selection with its rect, through open shadow roots.

import * as Schema from "effect/Schema";

/** A rect in the tab's viewport, or on the screen. */
export const Rect = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  w: Schema.Finite,
  h: Schema.Finite,
});

export type Rect = typeof Rect.Type;

/** What the probe found at a point. */
export const MenuProbe = Schema.Struct({
  /** Whether there is a field (or contenteditable) to paste into or select in. */
  target: Schema.Boolean,
  /** Whether that field has the tab's focus. */
  focused: Schema.Boolean,
  /** Whether the selection is in that field, so it can be cut. */
  editableSelection: Schema.Boolean,
  /** The selected text: empty for none. */
  text: Schema.String,
  /** The selection's rect, or null for none. */
  rect: Schema.NullOr(Rect),
});

export type MenuProbe = typeof MenuProbe.Type;

export type MenuItem = "Copy" | "Cut" | "Paste" | "Select All";

/**
 * The items for what the probe found after a double tap, a long press or Select All: none when there is nothing to act
 * on (no selection, and no field).
 */
export const menuItems = (found: MenuProbe): readonly MenuItem[] => {
  const items: MenuItem[] = [];

  if (found.text !== "") items.push("Copy");

  if (found.editableSelection) items.push("Cut");

  if (found.target) items.push("Paste", "Select All");

  return items;
};

/** Where the menu goes, in the same coordinates as the anchor and the frame, and on which side of the anchor. */
export interface MenuPlace {
  readonly x: number;
  readonly y: number;
  readonly side: "above" | "below";
}

/** The gap between the menu and what it is for, and its margin from the frame's sides, in CSS px. */
const GAP = 10;
const MARGIN = 4;

/**
 * Where a menu of `menu`'s size goes for a selection at `anchor`: above it if it fits in `frame`, else below it;
 * centred on it, and inside the frame.
 */
export const placeMenu = (
  anchor: Rect,
  frame: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  },
  menu: { readonly width: number; readonly height: number },
): MenuPlace => {
  const above = anchor.y - menu.height - GAP;
  const side = above < frame.top ? "below" : "above";
  const y = side === "above" ? above : anchor.y + anchor.h + GAP;

  const x = Math.max(
    frame.left + MARGIN,
    Math.min(
      anchor.x + anchor.w / 2 - menu.width / 2,
      frame.left + frame.width - menu.width - MARGIN,
    ),
  );

  return {
    x: Math.round(x),
    y: Math.round(Math.max(frame.top, Math.min(y, frame.top + frame.height - menu.height))),
    side,
  };
};

/** Where the probe keeps the field Paste and Select All act on. */
const EDIT_TARGET = `window[Symbol.for("cloudpid.liveView.editTarget")]`;

/** The deepest focused element through open shadow roots, stopping at an iframe (the edit menu's). */
const ACTIVE = `
  let active = document.activeElement;
  for (let depth = 0; active && depth < 10; depth++) {
    const inner = active.shadowRoot && active.shadowRoot.activeElement;
    if (!inner || inner === active) break;
    active = inner;
  }`;

/** The deepest focused element through open shadow roots and same-origin iframes, and its document (desktop copy). */
const ACTIVE_IN_FRAMES = `
  let active = document.activeElement, adoc = document;
  for (let depth = 0; active && depth < 10; depth++) {
    let inner = null;
    try {
      if (active.shadowRoot && active.shadowRoot.activeElement) inner = active.shadowRoot.activeElement;
      else if (active.tagName === "IFRAME" && active.contentDocument) { adoc = active.contentDocument; inner = adoc.activeElement; }
    } catch {}
    if (!inner || inner === active) break;
    active = inner;
  }`;

/** The element under a point through open shadow roots; null on an iframe, which the edit menu does not reach into. */
const ELEMENT_AT = `
  let el = document.elementFromPoint(x, y);
  for (let depth = 0; el && depth < 10; depth++) {
    const inner = el.shadowRoot && el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  if (el && el.tagName === "IFRAME") el = null;`;

/** The probe, as a function of a point in the tab's viewport: call it with `(x, y)`. */
export const menuProbeScript = (x: number, y: number): string => `((x, y) => {
  const TEXT = new Set(["text", "email", "number", "tel", "url", "search", "password"]);
  const isField = (el) => !!el && ((el.tagName === "INPUT" && TEXT.has(el.type)) || el.tagName === "TEXTAREA") && !el.disabled && !el.readOnly;
  const editRoot = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (isField(el)) return el;
    const label = el.closest("label");
    if (label && isField(label.control)) return label.control;
    if (el.isContentEditable) { let root = el; while (root.parentElement && root.parentElement.isContentEditable) root = root.parentElement; return root; }
    return null;
  };
  ${ELEMENT_AT}
  ${ACTIVE}
  const box = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  let target = editRoot(el), text = "", rect = null;
  if (isField(active) && typeof active.selectionStart === "number" && active.selectionStart !== active.selectionEnd) {
    text = active.value.slice(active.selectionStart, active.selectionEnd);
    rect = box(active.getBoundingClientRect());
    target = active;
  } else {
    const s = document.getSelection();
    if (s && !s.isCollapsed && s.rangeCount > 0 && String(s).trim()) {
      text = String(s);
      rect = box(s.getRangeAt(0).getBoundingClientRect());
      const anchor = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
      const root = editRoot(anchor);
      if (root) target = root;
      else if (target && !target.contains(anchor)) target = null;
    }
  }
  ${EDIT_TARGET} = target;
  return { target: !!target, focused: !!target && target === active, editableSelection: !!target && !!text, text, rect };
})(${JSON.stringify(x)}, ${JSON.stringify(y)})`;

/** Focuses the probe's target unless it has the focus, with the caret at its end, before a paste. */
export const EDIT_FOCUS_SCRIPT = `(() => {
  const t = ${EDIT_TARGET};
  if (!t || !t.isConnected) return false;
  ${ACTIVE}
  if (active === t) return true;
  t.focus({ preventScroll: true });
  if (typeof t.setSelectionRange === "function") { const n = t.value.length; try { t.setSelectionRange(n, n); } catch {} }
  else { const r = t.ownerDocument.createRange(); r.selectNodeContents(t); r.collapse(false); const s = t.ownerDocument.getSelection(); s.removeAllRanges(); s.addRange(r); }
  return true;
})()`;

/** Selects all of the probe's target. */
export const EDIT_SELECT_ALL_SCRIPT = `(() => {
  const t = ${EDIT_TARGET};
  if (!t || !t.isConnected) return false;
  t.focus({ preventScroll: true });
  if (typeof t.select === "function") t.select();
  else { const r = t.ownerDocument.createRange(); r.selectNodeContents(t); const s = t.ownerDocument.getSelection(); s.removeAllRanges(); s.addRange(r); }
  return true;
})()`;

/** Whether a double tap at a point should select a word: text or a field under it, not a control. Call with `(x, y)`. */
export const wordAtScript = (x: number, y: number): string => `((x, y) => {
  ${ELEMENT_AT}
  if (!el) return false;
  const TEXT = new Set(["text", "email", "number", "tel", "url", "search", "password"]);
  if ((el.tagName === "INPUT" && TEXT.has(el.type)) || el.tagName === "TEXTAREA" || el.isContentEditable) return true;
  if (el.closest("a, button, select, input, label, summary, [role=button], [onclick]")) return false;
  const range = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
  const node = range && range.startContainer;
  return !!node && node.nodeType === 3 && !!node.textContent.trim();
})(${JSON.stringify(x)}, ${JSON.stringify(y)})`;

/**
 * The tab's selected text (a focused field's, or the document's), for Cmd/Ctrl+C on a desktop: the keys of the page,
 * not the edit menu, so it reads into a same-origin iframe that has the focus.
 */
export const SELECTION_SCRIPT = `(() => {
  ${ACTIVE_IN_FRAMES}
  if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA") && typeof active.selectionStart === "number") return active.value.slice(active.selectionStart, active.selectionEnd);
  return String(adoc.getSelection ? adoc.getSelection() : "") || String(getSelection());
})()`;
