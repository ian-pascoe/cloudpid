// @effect-diagnostics asyncFunction:off preferEffectArray:off -- the DOM side: the clipboard's promises and a script's answer, awaited inside the tap that asked; four menu buttons over a native array.

// The Live View's edit menu on the screen (#154; what it offers and where it goes are `edit-menu.ts`'s): shown after a
// double tap, a long press or a long-press selection, it copies and cuts through the owner's clipboard and pastes
// from it, as one `Input.insertText` (several lines never press Enter). When iOS refuses to read the clipboard, the
// paste box takes a paste instead.

import * as Schema from "effect/Schema";
import { BACKSPACE, type Point } from "./cdp.ts";
import {
  EDIT_FOCUS_SCRIPT,
  EDIT_SELECT_ALL_SCRIPT,
  menuItems,
  MenuProbe,
  menuProbeScript,
  placeMenu,
  wordAtScript,
  type MenuItem,
} from "./edit-menu.ts";
import type { FrameView } from "./frame-view.ts";
import type { Keyboard } from "./keyboard.ts";
import { readClipboard, writeClipboard, type Listeners, type Tab } from "./screen-dom.ts";
import type { TimerGroup } from "./timers.ts";

/** How long after a double tap's word selection the menu is asked for, in ms: the tab selects first. */
const AFTER_WORD_MS = 120;

/** The edit menu as shown: where it was asked for. */
interface ShownMenu {
  readonly point: Point;
  readonly probe: MenuProbe;
}

export class EditMenuController {
  private shown: ShownMenu | undefined;
  /** Bumped by every touch on the frame, so a probe that answers after the next gesture began is dropped. */
  private gestures = 0;

  constructor(
    private readonly menu: HTMLDivElement,
    private readonly pasteBox: HTMLDivElement,
    private readonly pasteField: HTMLTextAreaElement,
    private readonly frame: FrameView,
    private readonly keyboard: Keyboard,
    private readonly tab: Tab,
    private readonly timers: TimerGroup,
    /** The tab changed: the field map is read again. */
    private readonly changed: () => void,
    listeners: Listeners,
  ) {
    // Touching the menu neither moves focus (the keyboard stays as it was) nor reaches the frame.
    listeners.on(menu, "touchstart", (event) => event.preventDefault(), { passive: false });
    listeners.on(menu, "mousedown", (event) => {
      event.preventDefault();
    });
    listeners.on(menu, "contextmenu", (event) => {
      event.preventDefault();
    });

    let pressed: HTMLButtonElement | null = null;

    listeners.on(menu, "pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      pressed = event.target instanceof Element ? event.target.closest("button") : null;
    });
    listeners.on(menu, "pointerup", (event) => {
      event.preventDefault();

      const button = pressed;

      pressed = null;

      // A touch's pointerup targets where it began: it acts only when it ended on the same item.
      const under = document.elementFromPoint(event.clientX, event.clientY)?.closest("button");

      if (button !== null && under === button) this.act(button.dataset.action ?? "");
    });

    // What is pasted into the paste box goes into the tab.
    listeners.on(pasteField, "input", () => {
      const text = pasteField.value;

      if (text === "") return;

      pasteField.value = "";
      pasteBox.hidden = true;
      void this.paste(text);
    });
  }

  /** A new gesture on the frame: the menu hides, and a probe still out for the last one is dropped. */
  touched(): void {
    this.gestures += 1;
    this.hide();
  }

  hide(): void {
    this.shown = undefined;
    this.menu.hidden = true;
  }

  /** Ask the tab what is at `point` and show the items that apply, above the selection (below without room). */
  async show(point: Point): Promise<void> {
    const gesture = this.gestures;
    const probe = await this.tab.evaluate(menuProbeScript(point.x, point.y), MenuProbe);

    if (probe === undefined || gesture !== this.gestures) return;

    const items = menuItems(probe);

    if (items.length === 0) {
      this.hide();

      return;
    }

    const { menu } = this;

    for (const button of Array.from(menu.querySelectorAll<HTMLButtonElement>("button"))) {
      // SAFETY: the menu renders one button per item, named by `data-action`.
      button.hidden = !items.includes(button.dataset.action as MenuItem);
    }

    menu.hidden = false;

    const anchor = this.frame.overlayRect(probe.rect ?? { x: point.x, y: point.y, w: 0, h: 0 });
    const wrapper = this.frame.wrapperRect();
    const canvas = this.frame.canvasRect();
    const top = Math.max(0, canvas.top - wrapper.top);
    const left = Math.max(0, canvas.left - wrapper.left);

    const place = placeMenu(
      anchor,
      {
        left,
        top,
        width: Math.min(wrapper.width, canvas.right - wrapper.left) - left,
        height: Math.min(wrapper.height, canvas.bottom - wrapper.top) - top,
      },
      { width: menu.offsetWidth, height: menu.offsetHeight },
    );

    menu.style.left = `${place.x}px`;
    menu.style.top = `${place.y}px`;
    this.shown = { point, probe };
  }

  /** Show the menu a moment after `ms`, unless another gesture began. */
  showAfter(point: Point, ms: number): void {
    const gesture = this.gestures;

    this.timers.after(ms, () => {
      if (gesture === this.gestures) void this.show(point);
    });
  }

  /** A double tap on text or in a field: the tab gets a mouse double-click, which selects the word, then the menu. */
  async doubleTap(point: Point): Promise<void> {
    const gesture = this.gestures;
    const word = await this.tab.evaluate(wordAtScript(point.x, point.y), Schema.Boolean);

    if (word !== true || gesture !== this.gestures) return;

    this.tab.send([
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", ...point, button: "left", buttons: 1, clickCount: 2 },
      },
      {
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 2 },
      },
    ]);
    this.showAfter(point, AFTER_WORD_MS);
  }

  /** Paste `text` into the field the menu was for (focused, caret at its end, if it was not), as one insert. */
  private async paste(text: string): Promise<void> {
    const focused = await this.tab.evaluate(EDIT_FOCUS_SCRIPT, Schema.Boolean);

    if (focused !== true) return;

    this.tab.send(this.keyboard.paste(text));
    this.changed();
  }

  private act(action: string): void {
    const shown = this.shown;

    if (shown === undefined) return;

    const { point, probe } = shown;

    // The selection's text, read again when the item is tapped; the probe's when that fails.
    const selection = () =>
      this.tab
        .evaluate(menuProbeScript(point.x, point.y), MenuProbe)
        .then((fresh) => fresh?.text || probe.text);

    if (action === "Copy") {
      void writeClipboard(selection());
      this.hide();
    } else if (action === "Cut") {
      const text = selection();

      void writeClipboard(text);
      void text.then(() => {
        this.tab.send(BACKSPACE);
        this.keyboard.reset();
        this.changed();
      });
      this.hide();
    } else if (action === "Paste") {
      this.hide();

      // Read inside the tap; iOS may show its own Paste bubble first, or refuse.
      const read = readClipboard();

      if (read === undefined) {
        this.showPasteBox();

        return;
      }

      read.then(
        (text) => {
          if (text !== "") void this.paste(text);
        },
        () => {
          this.showPasteBox();
        },
      );
    } else if (action === "Select All") {
      void this.tab.evaluate(EDIT_SELECT_ALL_SCRIPT, Schema.Boolean).then(() => {
        this.keyboard.reset();
        void this.show(point);
      });
    }
  }

  private showPasteBox(): void {
    this.pasteBox.hidden = false;
    this.pasteField.value = "";
    this.pasteField.focus({ preventScroll: true });
  }
}
