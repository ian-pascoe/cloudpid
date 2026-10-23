// The keyboard of a touch screen in the Live View (#154): an invisible textarea the Pane focuses so the phone opens its
// keyboard, and what the owner types in it, sent to the tab.
//
// When the keyboard opens is decided at the end of a tap, from the field map: focusing on every tap and blurring when
// the tab answers flashed the keyboard at every tap and scroll on the iPhone. Only a tap may change it (the Pane calls
// `tap` for taps alone): a tap in a field sets the field's hints and focuses, synchronously, inside the gesture iOS needs
// to open the keyboard; a tap elsewhere blurs. Going from field to field keeps the focus, and blurs and focuses again
// only when the keyboard must change (iOS may apply `inputmode` only on focus). After the tap, `check` compares the
// prediction with what the tab focused.
//
// Typing goes through Kernel's input sentinel (`typed-text.ts`): the textarea holds a character before the caret, so
// iOS sends Backspace even in an empty field, and each change is diffed against what was sent.
//
// `reset`, `input`, `compositionStart`, `compositionEnd` and `paste` are ported from Kernel's live view, kernel/kernel-images
// at commit 2c3fabc9a04a9f445870f183e21e3475104cb8cc, `images/chromium-headful/client/src/components/video.vue`
// (`resetInputSentinel`, `onOverlayInput`, `onCompositionEnd`) and `utils/text-input.ts` (`TextInput.paste`), licensed
// under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0; the text is in
// `apps/web/LICENSES/kernel-images.LICENSE`), distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND. Changed here: CDP commands instead of X keysyms, and one diff path whether or not text is kept. See
// `apps/web/NOTICE.md`.

import { BACKSPACE, insertText, keyPress, typeText, type CdpCommand } from "./cdp.ts";
import { hintsFor, type Field, type FocusedElement, type KeyboardHints } from "./field-map.ts";
import { INPUT_SENTINEL, TypedText } from "./typed-text.ts";

/** The typing textarea, as the keyboard uses it: an `HTMLTextAreaElement` in the page, a fake in tests. */
export interface TypingTextarea {
  /** Whether it has the page's focus. */
  readonly focused: boolean;
  focus(): void;
  blur(): void;
  value: string;
  spellcheck: boolean;
  setSelectionRange(start: number, end: number): void;
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

/** What the check after a tap found: the tab focused a field we did not predict, we predicted one it did not, or neither. */
export type TapCheck = "attention" | "blurred" | "ok";

/** The keys the textarea forwards as they are, since they move the tab's caret or focus rather than type. */
const FORWARDED_KEYS = new Set([
  "ArrowLeft",
  "ArrowUp",
  "ArrowRight",
  "ArrowDown",
  "Tab",
  "Escape",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export class Keyboard {
  private readonly typed = new TypedText();
  /** Whether typed text is kept after the sentinel for the keyboard to correct (Kernel's `keepText`). */
  private keep = false;
  private composing = false;
  /** Whether the last tap was predicted to land in a field. */
  private predicted = false;

  constructor(private readonly textarea: TypingTextarea) {
    this.reset();
  }

  /** The end of a tap, in its gesture: focus with `field`'s keyboard when it landed in one, else blur. */
  tap(field: Field | undefined): void {
    // The tap may move the tab's caret, which a correction must not reach back past.
    this.reset();
    this.predicted = field !== undefined;

    if (field === undefined) {
      this.textarea.blur();

      return;
    }

    const wasFocused = this.textarea.focused;
    const changed = this.applyHints(hintsFor(field));

    if (wasFocused && changed) this.textarea.blur();

    this.textarea.focus();
  }

  /** After a tap: what the tab focused, against what the tap predicted. */
  check(focused: FocusedElement): TapCheck {
    if (focused.editable && !this.textarea.focused) return "attention";

    if (!focused.editable && this.textarea.focused && this.predicted) {
      this.textarea.blur();

      return "blurred";
    }

    // Right: the field's own hints, which the map may not have had (a script may have changed them).
    if (focused.editable) this.applyHints(hintsFor(focused));

    return "ok";
  }

  /** Open the keyboard for the field the tab has focused (the ⌨︎ button), in the button's gesture. */
  force(focused: FocusedElement | undefined): void {
    if (focused?.editable === true) this.applyHints(hintsFor(focused));

    this.reset();
    this.textarea.focus();
  }

  /** Close the keyboard: a local picker opens, or the Pane closes. */
  close(): void {
    this.textarea.blur();
  }

  /** The textarea changed: what to send the tab. */
  input(): readonly CdpCommand[] {
    return this.edit();
  }

  compositionStart(): void {
    this.composing = true;
  }

  /** A composition ended; its input events already sent its text, unless the last came after it. */
  compositionEnd(): readonly CdpCommand[] {
    this.composing = false;

    return this.edit();
  }

  /** Text pasted into the textarea, as one insert (`insertText`), without the line break copied text often ends with. */
  paste(text: string): readonly CdpCommand[] {
    this.reset();

    return insertText(text.replace(/[\r\n]+$/, ""));
  }

  /** A key pressed in the textarea that does not type: forwarded, or undefined to let the textarea have it. */
  key(key: string): readonly CdpCommand[] | undefined {
    if (!FORWARDED_KEYS.has(key)) return undefined;

    // The tab's caret moved: a correction must not reach back past it.
    this.reset();

    return keyPress(key);
  }

  /** Start over: the textarea holds only the sentinel, and nothing typed is kept. */
  reset(): void {
    this.typed.reset();
    this.textarea.value = INPUT_SENTINEL;
    this.textarea.setSelectionRange(INPUT_SENTINEL.length, INPUT_SENTINEL.length);
  }

  /** The textarea's value as an edit for the tab; it starts over unless the text is kept for correction. */
  private edit(): readonly CdpCommand[] {
    const { backspaces, insert, kept } = this.typed.edit(this.textarea.value);

    const commands = [
      ...Array.from({ length: backspaces }, () => BACKSPACE).flat(),
      ...typeText(insert),
    ];

    if ((!this.keep || !kept) && !this.composing) this.reset();

    return commands;
  }

  /** Set the textarea's hints; whether any changed. */
  private applyHints(hints: KeyboardHints): boolean {
    let changed = false;

    for (const [name, value] of [
      ["inputmode", hints.inputMode],
      ["autocapitalize", hints.autocapitalize],
      ["enterkeyhint", hints.enterKeyHint],
      ["autocorrect", hints.autocorrect],
    ] as const) {
      if (this.textarea.getAttribute(name) !== value) {
        this.textarea.setAttribute(name, value);
        changed = true;
      }
    }

    const keep = hints.autocorrect === "on";

    this.textarea.spellcheck = keep;

    if (this.keep !== keep) {
      this.keep = keep;
      this.reset();
    }

    return changed;
  }
}
