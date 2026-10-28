// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a few dozen rects hit-tested at each tap, over native arrays, and plain functions rather than combinators.

// The field map (`docs/architecture/browser.md`, #154): where the tab's editable elements are, so the Pane can decide at the
// end of a tap, inside the gesture iOS needs to open its keyboard, whether the tap landed in a field and which keyboard
// it wants. One `Runtime.evaluate` of `FIELD_MAP_SCRIPT` reads it; the Pane reads it again when the frame scrolls (at
// most every 250 ms), after a tap and input, and every second. Native pickers (`<select>`, date, time, colour inputs)
// are in it too, since headless Chrome draws their pop-ups outside the screencast: the Pane opens a local one instead.

import * as Schema from "effect/Schema";
import type { Point } from "./cdp.ts";

/** A `<select>` of the tab, by its index in the tab's picker registry, with what it offers. */
const SelectPicker = Schema.Struct({
  index: Schema.Finite,
  kind: Schema.Literal("select"),
  multiple: Schema.Boolean,
  options: Schema.Array(
    Schema.Struct({
      text: Schema.String,
      disabled: Schema.Boolean,
      selected: Schema.Boolean,
      group: Schema.String,
    }),
  ),
});

/** A date, time, datetime-local, month, week or colour input of the tab, by its index in the picker registry. */
const InputPicker = Schema.Struct({
  index: Schema.Finite,
  kind: Schema.Literal("input"),
  value: Schema.String,
  min: Schema.String,
  max: Schema.String,
  step: Schema.String,
});

export const Picker = Schema.Union([SelectPicker, InputPicker]);

export type Picker = typeof Picker.Type;

/** One rect of an editable element of the tab (or of a label of one), in the tab's viewport px when it was read. */
export const Field = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  w: Schema.Finite,
  h: Schema.Finite,
  /** The input's type, `textarea`, `contenteditable`, or `select`. */
  type: Schema.String,
  inputMode: Schema.String,
  enterKeyHint: Schema.String,
  autocapitalize: Schema.String,
  /** Set for a native picker, which a tap opens locally instead of in the tab. */
  picker: Schema.optional(Picker),
});

export type Field = typeof Field.Type;

/** What `FIELD_MAP_SCRIPT` answers: the rects, and the tab's scroll offset when they were read. */
export const FieldMapReading = Schema.Struct({
  scrollX: Schema.Finite,
  scrollY: Schema.Finite,
  items: Schema.Array(Field),
});

/** The field map as the Pane holds it: a reading, and when it was made. */
export interface FieldMap extends Readonly<typeof FieldMapReading.Type> {
  readonly at: number;
}

export const EMPTY_FIELD_MAP: FieldMap = { scrollX: 0, scrollY: 0, items: [], at: 0 };

/** Where the tab keeps the picker elements the map listed, so a choice is written to the same element. */
export const PICKER_REGISTRY = `window[Symbol.for("cloudpid.liveView.pickers")]`;

/**
 * Lists the tab's editable elements, in its viewport's CSS px: inputs that take text, textareas, contenteditable roots
 * and labels of those (tapping a label focuses its field), in open shadow roots and same-origin iframes, and native
 * pickers with what they hold. Disabled and readonly fields are left out, and rects far outside the viewport.
 */
export const FIELD_MAP_SCRIPT = `(() => {
  const TEXT = new Set(["text", "email", "number", "tel", "url", "search", "password"]);
  const PICK = new Set(["date", "time", "datetime-local", "month", "week", "color"]);
  const editable = (el) => {
    if (el.tagName === "INPUT") return TEXT.has(el.type) && !el.disabled && !el.readOnly;
    if (el.tagName === "TEXTAREA") return !el.disabled && !el.readOnly;
    return el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable);
  };
  const registry = (${PICKER_REGISTRY} ??= []);
  const pickerOf = (el) => {
    let index = registry.indexOf(el);
    if (index === -1) index = registry.push(el) - 1;
    if (el.tagName === "SELECT") {
      return {
        index, kind: "select", multiple: el.multiple,
        options: [...el.options].slice(0, 500).map((o) => ({
          text: o.text, disabled: o.disabled, selected: o.selected,
          group: o.parentElement && o.parentElement.tagName === "OPTGROUP" ? o.parentElement.label : "",
        })),
      };
    }
    return { index, kind: "input", value: el.value, min: el.min, max: el.max, step: el.step };
  };
  const out = [];
  const H = innerHeight;
  const add = (el, of, dx, dy, picker) => {
    if (getComputedStyle(el).visibility === "hidden") return;
    for (const r of el.getClientRects()) {
      if (r.width === 0 || r.height === 0 || r.bottom + dy < -H || r.top + dy > 2 * H) continue;
      out.push({
        x: Math.round(r.left + dx), y: Math.round(r.top + dy), w: Math.round(r.width), h: Math.round(r.height),
        type: of.tagName === "INPUT" ? of.type : of.tagName === "TEXTAREA" ? "textarea" : of.tagName === "SELECT" ? "select" : "contenteditable",
        inputMode: of.getAttribute("inputmode") || "",
        enterKeyHint: of.getAttribute("enterkeyhint") || "",
        autocapitalize: of.getAttribute("autocapitalize") || "",
        picker,
      });
    }
  };
  let seen = 0;
  const walk = (root, dx, dy) => {
    for (const el of root.querySelectorAll("input, textarea, select, [contenteditable], label")) {
      if ((el.tagName === "SELECT" || (el.tagName === "INPUT" && PICK.has(el.type))) && !el.disabled && !el.readOnly) {
        add(el, el, dx, dy, pickerOf(el));
      } else if (el.tagName === "LABEL") {
        const control = el.control;
        if (control && editable(control)) add(el, control, dx, dy, undefined);
      } else if (editable(el)) add(el, el, dx, dy, undefined);
    }
    for (const el of root.querySelectorAll("*")) {
      if (++seen > 20000) return;
      if (el.shadowRoot) walk(el.shadowRoot, dx, dy);
      if (el.tagName === "IFRAME") {
        try {
          const doc = el.contentDocument;
          if (!doc) continue;
          const r = el.getBoundingClientRect();
          walk(doc, dx + r.left + el.clientLeft, dy + r.top + el.clientTop);
        } catch {}
      }
    }
  };
  walk(document, 0, 0);
  return { scrollX, scrollY, items: out };
})()`;

/** How far around a field's rect a tap still counts as in it, in CSS px. */
const SLACK = 4;

/**
 * The field under `point` (in the tab's viewport now) in `map`, whose rects were read at another scroll offset:
 * `scroll` is the tab's offset now, from the last frame. The smallest rect wins, so a field beats the label around it.
 */
export const hitTest = (map: FieldMap, point: Point, scroll: Point): Field | undefined => {
  const dx = scroll.x - map.scrollX;
  const dy = scroll.y - map.scrollY;
  let best: Field | undefined;

  for (const item of map.items) {
    const x = item.x - dx;
    const y = item.y - dy;

    if (
      point.x >= x - SLACK &&
      point.x <= x + item.w + SLACK &&
      point.y >= y - SLACK &&
      point.y <= y + item.h + SLACK &&
      (best === undefined || item.w * item.h < best.w * best.h)
    ) {
      best = item;
    }
  }

  return best;
};

/** What the typing textarea is told about the keyboard a field wants. */
export interface KeyboardHints {
  readonly inputMode: string;
  readonly autocapitalize: string;
  readonly enterKeyHint: string;
  /** `on` where the keyboard may correct typed text, which the textarea then keeps after its sentinel. */
  readonly autocorrect: "on" | "off";
}

const BY_TYPE: ReadonlyMap<string, readonly [string, string, string]> = new Map([
  ["email", ["email", "off", "go"]],
  ["number", ["decimal", "off", "go"]],
  ["tel", ["tel", "off", "go"]],
  ["url", ["url", "off", "go"]],
  ["search", ["search", "off", "search"]],
  ["password", ["text", "off", "go"]],
  ["text", ["text", "sentences", "go"]],
  ["textarea", ["text", "sentences", "enter"]],
  ["contenteditable", ["text", "sentences", "enter"]],
]);

const NO_AUTOCORRECT = new Set(["email", "url", "password", "number", "tel"]);

/**
 * A field's keyboard: its own `inputmode`, `autocapitalize` and `enterkeyhint` where it sets them, else its type's (an
 * email field gets the email keyboard, a number field the decimal pad, a textarea a return key).
 */
export const hintsFor = (
  field: Pick<Field, "type" | "inputMode" | "autocapitalize" | "enterKeyHint">,
): KeyboardHints => {
  const [inputMode, autocapitalize, enterKeyHint] = BY_TYPE.get(field.type) ?? [
    "text",
    "sentences",
    "go",
  ];

  return {
    inputMode: field.inputMode || inputMode,
    autocapitalize: field.autocapitalize || autocapitalize,
    enterKeyHint: field.enterKeyHint || enterKeyHint,
    autocorrect: NO_AUTOCORRECT.has(field.type) ? "off" : "on",
  };
};

/** What the tab has focused, after a tap: whether it takes typing, and its keyboard hints. */
export const FocusedElement = Schema.Struct({
  editable: Schema.Boolean,
  type: Schema.String,
  inputMode: Schema.String,
  enterKeyHint: Schema.String,
  autocapitalize: Schema.String,
});

export type FocusedElement = typeof FocusedElement.Type;

/** Reads what the tab has focused, through open shadow roots and same-origin iframes. */
export const FOCUSED_SCRIPT = `(() => {
  let el = document.activeElement;
  for (;;) {
    let inner = null;
    try { inner = el && (el.shadowRoot ? el.shadowRoot.activeElement : el.contentDocument ? el.contentDocument.activeElement : null); } catch {}
    if (!inner || inner === el) break;
    el = inner;
  }
  const none = { editable: false, type: "", inputMode: "", enterKeyHint: "", autocapitalize: "" };
  if (!el) return none;
  const TEXT = new Set(["text", "email", "number", "tel", "url", "search", "password"]);
  const editable = (el.tagName === "INPUT" && TEXT.has(el.type) && !el.disabled && !el.readOnly) || (el.tagName === "TEXTAREA" && !el.disabled && !el.readOnly) || el.isContentEditable;
  if (!editable) return none;
  return {
    editable,
    type: el.tagName === "INPUT" ? el.type : el.tagName === "TEXTAREA" ? "textarea" : "contenteditable",
    inputMode: el.getAttribute("inputmode") || "",
    enterKeyHint: el.getAttribute("enterkeyhint") || "",
    autocapitalize: el.getAttribute("autocapitalize") || "",
  };
})()`;
