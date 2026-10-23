// @effect-diagnostics preferEffectArray:off -- a picker's options, built into the DOM over native arrays.

// The Live View's native pickers, opened locally (#154): a tap on a `<select>`, a date, time or colour input in the
// tab opens a control of the same kind here, over the element, inside the tap (the screencast shows no browser
// pop-ups), and what the owner picks is written to the tab (`pickers.ts`).

import * as Schema from "effect/Schema";
import type { Field, Picker } from "./field-map.ts";
import type { FrameView } from "./frame-view.ts";
import type { Keyboard } from "./keyboard.ts";
import { PickerWrites, type PickerChoice } from "./pickers.ts";
import type { Listeners, Tab } from "./screen-dom.ts";
import type { TimerGroup } from "./timers.ts";

/** How long after a picker's blur its value is read once more: some set it just after. */
const LATE_VALUE_MS = 400;

/** A picker opened locally, and what it has written to the tab. */
interface OpenPicker {
  readonly local: HTMLSelectElement | HTMLInputElement;
  readonly picker: Picker;
  readonly writes: PickerWrites;
}

const selectedOf = (select: HTMLSelectElement): number[] =>
  Array.from(select.selectedOptions, (option) => Number(option.value));

const choiceOf = (open: OpenPicker): PickerChoice =>
  open.local instanceof HTMLSelectElement
    ? { indexes: selectedOf(open.local) }
    : { value: open.local.value };

export class PickerController {
  private open: OpenPicker | undefined;

  constructor(
    private readonly select: HTMLSelectElement,
    private readonly input: HTMLInputElement,
    private readonly frame: FrameView,
    private readonly keyboard: Keyboard,
    private readonly tab: Tab,
    private readonly timers: TimerGroup,
    /** The tab changed: the field map is read again. */
    private readonly changed: () => void,
    listeners: Listeners,
  ) {
    // Each of these may be the one that carries the value, depending on the control and the OS.
    for (const local of [select, input]) {
      for (const type of ["input", "change"] as const) {
        listeners.on(local, type, () => {
          const open = this.open;

          if (open?.local !== local) return;

          this.commit(open);

          // A single choice is done; a multiple select, a date or a colour can still change until it closes.
          if (type === "change" && local instanceof HTMLSelectElement && !local.multiple) {
            this.close();
          }
        });
      }

      listeners.on(local, "blur", () => {
        const open = this.open;

        if (open?.local !== local) return;

        this.commit(open);
        this.timers.after(LATE_VALUE_MS, () => {
          this.commit(open);

          if (this.open === open && document.activeElement !== local) this.close();
        });
      });
    }
  }

  /** A local control of the picker's kind over the tapped element, opened inside the tap. */
  show(field: Field): void {
    const picker = field.picker;

    if (picker === undefined) return;

    const { select, input } = this;

    this.keyboard.close();
    this.close();

    let local: HTMLSelectElement | HTMLInputElement;
    let initial: PickerChoice;

    if (picker.kind === "select") {
      local = select;
      select.multiple = picker.multiple;
      select.size = picker.multiple ? Math.min(picker.options.length, 4) : 0;
      select.replaceChildren();

      let group: HTMLOptGroupElement | null = null;

      picker.options.forEach((option, index) => {
        const element = new Option(option.text, String(index), false, option.selected);

        element.disabled = option.disabled;

        if (option.group === "") {
          group = null;
          select.append(element);

          return;
        }

        if (group?.label !== option.group) {
          group = document.createElement("optgroup");
          group.label = option.group;
          select.append(group);
        }

        group.append(element);
      });
      initial = { indexes: selectedOf(select) };
    } else {
      local = input;
      input.type = field.type;
      input.min = picker.min;
      input.max = picker.max;
      input.step = picker.step;
      input.value = picker.value;
      initial = { value: input.value };
    }

    // Exactly over the element, so a tap beside it still reaches the frame.
    const rect = this.frame.overlayRect(field);

    local.style.left = `${rect.x}px`;
    local.style.top = `${rect.y}px`;
    local.style.width = `${Math.max(60, rect.w)}px`;
    local.style.height = `${Math.max(32, rect.h)}px`;
    local.hidden = false;
    this.open = { local, picker, writes: new PickerWrites(picker.index, initial) };
    local.focus({ preventScroll: true });

    try {
      local.showPicker();
    } catch {
      // A browser without `showPicker` for it, or one that refuses: the focused control still opens on a tap.
    }
  }

  /** Close the local picker, its last value written: the frame was touched or scrolled, or the screen goes. */
  close(): void {
    const open = this.open;

    if (open === undefined) return;

    this.open = undefined;
    this.commit(open);
    open.local.hidden = true;

    if (document.activeElement === open.local) open.local.blur();
  }

  /** Write the control's value to the tab, unless it is the one last written. */
  private commit(open: OpenPicker): void {
    const script = open.writes.next(choiceOf(open));

    if (script === undefined) return;

    void this.tab.evaluate(script, Schema.Boolean).then(() => {
      this.changed();
    });
  }
}
