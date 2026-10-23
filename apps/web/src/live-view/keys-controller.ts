// The Live View's keys (#154): what the phone's keyboard types into the typing textarea (`keyboard.ts`), and a
// desktop's keys while the frame's container has the focus (`input.ts`'s `keyAction`), with copy, cut and paste
// through the owner's clipboard.
//
// A desktop's Cmd/Ctrl+V cannot rely on a `paste` event on the container: Safari fires none on an element that is not
// editable. So the keydown moves the focus to the typing textarea, where every browser pastes, and the textarea's
// `paste` sends the text and gives the focus back.

import * as Schema from "effect/Schema";
import { BACKSPACE, insertText } from "./cdp.ts";
import { SELECTION_SCRIPT } from "./edit-menu.ts";
import { keyAction } from "./input.ts";
import type { Keyboard } from "./keyboard.ts";
import { isMac, writeClipboard, type Listeners, type Tab } from "./screen-dom.ts";
import type { TimerGroup } from "./timers.ts";

/** How long a desktop paste may take to reach the typing textarea before the focus goes back, in ms. */
const PASTE_WAIT_MS = 300;

export class KeysController {
  private readonly mac = isMac();
  /** A desktop's Cmd/Ctrl+V moved the focus to the typing textarea: its paste gives it back to the container. */
  private desktopPaste: (() => void) | undefined;

  constructor(
    private readonly container: HTMLDivElement,
    private readonly textarea: HTMLTextAreaElement,
    private readonly keyboard: Keyboard,
    private readonly tab: Tab,
    private readonly timers: TimerGroup,
    /** A key typed: the edit menu hides. */
    private readonly typing: () => void,
    /** The tab changed: the field map is read again. */
    private readonly changed: () => void,
    listeners: Listeners,
  ) {
    // The phone's keyboard.
    listeners.on(textarea, "input", () => {
      this.typing();
      this.tab.send(this.keyboard.input());
      this.changed();
    });
    listeners.on(textarea, "compositionstart", () => {
      this.keyboard.compositionStart();
    });
    listeners.on(textarea, "compositionend", () => {
      this.tab.send(this.keyboard.compositionEnd());
    });
    listeners.on(textarea, "paste", (event) => {
      event.preventDefault();
      this.tab.send(this.keyboard.paste(event.clipboardData?.getData("text/plain") ?? ""));
      this.changed();
      this.desktopPaste?.();
    });
    listeners.on(textarea, "keydown", (event) => {
      const commands = this.keyboard.key(event.key);

      if (commands === undefined) return;

      event.preventDefault();
      this.tab.send(commands);
    });

    // A desktop's keys, while the frame has the focus.
    listeners.on(container, "keydown", (event) => {
      this.key(event, "down");
    });
    listeners.on(container, "keyup", (event) => {
      this.key(event, "up");
    });
    // The browser's own Edit → Paste, where it sends one to the focused container.
    listeners.on(container, "paste", (event) => {
      if (event.target !== container) return;

      event.preventDefault();
      this.tab.send(insertText(event.clipboardData?.getData("text/plain") ?? ""));
    });
  }

  private key(event: KeyboardEvent, type: "down" | "up"): void {
    if (event.target !== this.container || event.isComposing) return;

    const action = keyAction(
      {
        type,
        key: event.key,
        code: event.code,
        repeat: event.repeat,
        alt: event.altKey,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
      },
      this.mac,
    );

    switch (action.type) {
      case "send":
        event.preventDefault();
        this.tab.send(action.commands);
        break;
      case "copy":
        event.preventDefault();
        void writeClipboard(this.selection());
        break;
      case "cut":
        event.preventDefault();
        void writeClipboard(this.selection()).then(() => {
          this.tab.send(BACKSPACE);
        });
        break;
      case "paste":
        // Not prevented: the paste lands in the textarea, focused for it in this keydown.
        this.pasteIntoTextarea();
        break;
      case "ignore":
        break;
    }
  }

  /** The tab's selected text, or nothing. */
  private selection(): Promise<string> {
    return this.tab.evaluate(SELECTION_SCRIPT, Schema.String).then((text) => text ?? "");
  }

  private pasteIntoTextarea(): void {
    this.desktopPaste?.();
    this.textarea.focus({ preventScroll: true });

    let cancel: () => void = () => undefined;

    const done = () => {
      cancel();
      this.desktopPaste = undefined;

      if (document.activeElement === this.textarea) this.container.focus({ preventScroll: true });
    };

    this.desktopPaste = done;
    // No paste came (nothing on the clipboard, or not text): the container takes the keys again.
    cancel = this.timers.after(PASTE_WAIT_MS, done);
  }
}
