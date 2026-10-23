// Native pickers in the Live View (#154). Headless Chrome draws a `<select>`'s list and the date, time and colour
// pickers outside the screencast, where the owner cannot see them. So a tap on one is withheld from the tab, and a local
// control of the same kind opens over the spot instead, inside the gesture (iOS opened its picker on the first tap for
// selects). Its value is written to the tab's element as Puppeteer's `ElementHandle.select` does: `option.selected` or
// `value`, then bubbling `input` and `change`, without focusing the element (that scrolled the tab and closed the
// control). iOS fires `input`, `change` and `blur` in different orders per control, and a date wheel may change the
// value only as it closes, so each of them, and closing, asks to write: a value is written once.

import { PICKER_REGISTRY } from "./field-map.ts";

/** What a local control holds: a select's chosen option indexes, or an input's value. */
export type PickerChoice = { readonly indexes: readonly number[] } | { readonly value: string };

/** Writes `choice` to the tab's picker element `index` (in the registry the field map keeps), with its events. */
export const pickerWriteScript = (index: number, choice: PickerChoice): string =>
  `((index, choice) => {
  const el = (${PICKER_REGISTRY} || [])[index];
  if (!el || !el.isConnected) return false;
  if (el.tagName === "SELECT") {
    const want = new Set(choice.indexes);
    [...el.options].forEach((option, i) => { if (want.has(i) || el.multiple) option.selected = want.has(i); });
  } else {
    el.value = choice.value;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})(${JSON.stringify(index)}, ${JSON.stringify(choice)})`;

/** The writes of one opened picker: a script for each value it has not written yet. */
export class PickerWrites {
  private written: string;

  constructor(
    private readonly index: number,
    initial: PickerChoice,
  ) {
    this.written = JSON.stringify(initial);
  }

  /** The script that writes `choice`, or undefined when it is the value last written (or the one it opened with). */
  next(choice: PickerChoice): string | undefined {
    const key = JSON.stringify(choice);

    if (key === this.written) return undefined;

    this.written = key;

    return pickerWriteScript(this.index, choice);
  }
}
