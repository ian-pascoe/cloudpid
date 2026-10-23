// @effect-diagnostics preferEffectArray:off -- a fake textarea's log over native arrays.

import { describe, expect, it } from "vitest";
import { BACKSPACE, ENTER, keyPress, type CdpCommand } from "./cdp.ts";
import type { Field, FocusedElement } from "./field-map.ts";
import { Keyboard, type TypingTextarea } from "./keyboard.ts";
import { INPUT_SENTINEL } from "./typed-text.ts";

/** A textarea as the keyboard sees it, which records what was done to it (the page's focus is its own `focused`). */
class FakeTextarea implements TypingTextarea {
  focused = false;
  value = "";
  spellcheck = false;
  caret = 0;
  readonly log: string[] = [];
  private readonly attributes = new Map<string, string>();

  focus() {
    if (!this.focused) this.log.push("focus");

    this.focused = true;
  }

  blur() {
    if (this.focused) this.log.push("blur");

    this.focused = false;
  }

  setSelectionRange(start: number) {
    this.caret = start;
  }

  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }

  /** The owner types: the textarea's value becomes `value`, as the keyboard leaves it. */
  types(keyboard: Keyboard, value: string): readonly CdpCommand[] {
    this.value = value;

    return keyboard.input();
  }
}

const field = (type: string, overrides: Partial<Field> = {}): Field => ({
  x: 0,
  y: 0,
  w: 100,
  h: 30,
  type,
  inputMode: "",
  enterKeyHint: "",
  autocapitalize: "",
  ...overrides,
});

const focusedIn = (type: string): FocusedElement => ({
  editable: true,
  type,
  inputMode: "",
  enterKeyHint: "",
  autocapitalize: "",
});

const NOTHING_FOCUSED: FocusedElement = {
  editable: false,
  type: "",
  inputMode: "",
  enterKeyHint: "",
  autocapitalize: "",
};

const insert = (text: string): CdpCommand => ({ method: "Input.insertText", params: { text } });

const setup = () => {
  const textarea = new FakeTextarea();

  return { textarea, keyboard: new Keyboard(textarea) };
};

describe("the keyboard textarea at the end of a tap", () => {
  it("focuses with the field's keyboard when the tap lands in a field", () => {
    const { textarea, keyboard } = setup();

    keyboard.tap(field("email"));

    expect(textarea.focused).toBe(true);
    expect(textarea.getAttribute("inputmode")).toBe("email");
    expect(textarea.getAttribute("enterkeyhint")).toBe("go");
    expect(textarea.getAttribute("autocapitalize")).toBe("off");
  });

  it("blurs when a tap misses every field, and stays blurred when it was", () => {
    const { textarea, keyboard } = setup();

    keyboard.tap(undefined);
    expect(textarea.log).toEqual([]);

    keyboard.tap(field("text"));
    keyboard.tap(undefined);

    expect(textarea.focused).toBe(false);
    expect(textarea.log).toEqual(["focus", "blur"]);
  });

  it("stays focused from field to field, refocusing only when the keyboard must change", () => {
    const { textarea, keyboard } = setup();

    keyboard.tap(field("text"));
    keyboard.tap(field("text"));

    expect(textarea.log).toEqual(["focus"]);

    keyboard.tap(field("number"));

    expect(textarea.log).toEqual(["focus", "blur", "focus"]);
    expect(textarea.getAttribute("inputmode")).toBe("decimal");
  });

  it("does not change on gestures that are not taps: the Pane only calls it for taps", () => {
    const { textarea, keyboard } = setup();

    keyboard.tap(field("text"));
    keyboard.close();

    expect(textarea.focused).toBe(false);
  });
});

describe("the check after a tap", () => {
  it("asks for attention when the tab focused a field the tap was not predicted to", () => {
    const { textarea, keyboard } = setup();

    keyboard.tap(undefined);

    expect(keyboard.check(focusedIn("text"))).toBe("attention");
    expect(textarea.focused).toBe(false);
  });

  it("blurs when a field was predicted but the tab focused nothing that takes typing", () => {
    const { textarea, keyboard } = setup();

    keyboard.tap(field("text"));

    expect(keyboard.check(NOTHING_FOCUSED)).toBe("blurred");
    expect(textarea.focused).toBe(false);
  });

  it("takes the focused field's own hints when the prediction was right", () => {
    const { textarea, keyboard } = setup();

    keyboard.tap(field("text"));

    expect(keyboard.check({ ...focusedIn("text"), inputMode: "numeric" })).toBe("ok");
    expect(textarea.getAttribute("inputmode")).toBe("numeric");
    expect(textarea.log).toEqual(["focus"]);
  });

  it("opens the keyboard when forced, with the focused field's hints", () => {
    const { textarea, keyboard } = setup();

    keyboard.force(focusedIn("url"));

    expect(textarea.focused).toBe(true);
    expect(textarea.getAttribute("inputmode")).toBe("url");
  });
});

describe("typing through the textarea", () => {
  it("keeps the sentinel before the caret from the start", () => {
    const { textarea } = setup();

    expect(textarea.value).toBe(INPUT_SENTINEL);
    expect(textarea.caret).toBe(INPUT_SENTINEL.length);
  });

  it("types each character into the tab", () => {
    const { textarea, keyboard } = setup();

    keyboard.tap(field("text"));

    expect(textarea.types(keyboard, `${INPUT_SENTINEL}h`)).toEqual([insert("h")]);
    expect(textarea.types(keyboard, `${INPUT_SENTINEL}hi`)).toEqual([insert("i")]);
  });

  it("sends Backspace in an empty field, where only the sentinel was deleted", () => {
    const { textarea, keyboard } = setup();

    keyboard.tap(field("email"));

    expect(textarea.types(keyboard, "")).toEqual(BACKSPACE);
    expect(textarea.value).toBe(INPUT_SENTINEL);
  });

  it("sends an autocorrect replacement as Backspaces and the corrected word", () => {
    const { textarea, keyboard } = setup();

    keyboard.tap(field("text"));
    textarea.types(keyboard, `${INPUT_SENTINEL}Teh`);

    expect(textarea.types(keyboard, `${INPUT_SENTINEL}The`)).toEqual([
      ...BACKSPACE,
      ...BACKSPACE,
      insert("he"),
    ]);
  });

  it("starts over after each character where the keyboard does not correct (an email field)", () => {
    const { textarea, keyboard } = setup();

    keyboard.tap(field("email"));
    textarea.types(keyboard, `${INPUT_SENTINEL}a`);

    expect(textarea.value).toBe(INPUT_SENTINEL);
    expect(textarea.types(keyboard, `${INPUT_SENTINEL}@`)).toEqual([insert("@")]);
  });

  it("sends a line break as Enter", () => {
    const { textarea, keyboard } = setup();

    keyboard.tap(field("textarea"));

    expect(textarea.types(keyboard, `${INPUT_SENTINEL}hi\n`)).toEqual([insert("hi"), ...ENTER]);
  });

  it("waits for a composition to end before starting over", () => {
    const { textarea, keyboard } = setup();

    keyboard.tap(field("email"));
    keyboard.compositionStart();

    expect(textarea.types(keyboard, `${INPUT_SENTINEL}k`)).toEqual([insert("k")]);
    expect(textarea.value).toBe(`${INPUT_SENTINEL}k`);
    expect(textarea.types(keyboard, `${INPUT_SENTINEL}ka`)).toEqual([insert("a")]);

    expect(keyboard.compositionEnd()).toEqual([]);
    expect(textarea.value).toBe(INPUT_SENTINEL);
  });

  it("forwards arrows, Tab and Escape as keys and starts over, as the tab's caret moved", () => {
    const { textarea, keyboard } = setup();

    keyboard.tap(field("text"));
    textarea.types(keyboard, `${INPUT_SENTINEL}ab`);

    expect(keyboard.key("ArrowLeft")).toEqual(keyPress("ArrowLeft"));
    expect(textarea.value).toBe(INPUT_SENTINEL);
    expect(keyboard.key("a")).toBeUndefined();
  });

  it("types pasted text without its trailing line break, and starts over", () => {
    const { textarea, keyboard } = setup();

    keyboard.tap(field("text"));

    expect(keyboard.paste("copied\n")).toEqual([insert("copied")]);
    expect(textarea.value).toBe(INPUT_SENTINEL);
  });
});
