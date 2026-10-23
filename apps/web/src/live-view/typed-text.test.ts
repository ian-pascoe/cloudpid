import { describe, expect, it } from "vitest";
import { INPUT_SENTINEL, TypedText, textDiff } from "./typed-text.ts";

const typedAfterSentinel = (text: string) => `${INPUT_SENTINEL}${text}`;

describe("the difference between what was sent and what the textarea holds", () => {
  it("deletes back to the common start, then inserts the rest", () => {
    expect(textDiff("teh", "the")).toEqual({ deletes: 2, insert: "he" });
    expect(textDiff("", "hi")).toEqual({ deletes: 0, insert: "hi" });
    expect(textDiff("hello", "hel")).toEqual({ deletes: 2, insert: "" });
  });

  it("counts an emoji as one character, as Backspace deletes it", () => {
    expect(textDiff("a👋", "a")).toEqual({ deletes: 1, insert: "" });
  });
});

describe("text typed after the sentinel", () => {
  it("sends each new character as it is typed", () => {
    const typed = new TypedText();

    expect(typed.edit(typedAfterSentinel("h"))).toEqual({ backspaces: 0, insert: "h", kept: true });
    expect(typed.edit(typedAfterSentinel("hi"))).toEqual({
      backspaces: 0,
      insert: "i",
      kept: true,
    });
  });

  it("sends an autocorrect replacement as Backspaces and the new word", () => {
    const typed = new TypedText();

    typed.edit(typedAfterSentinel("Teh"));

    expect(typed.edit(typedAfterSentinel("The"))).toEqual({
      backspaces: 2,
      insert: "he",
      kept: true,
    });
  });

  it("sends Backspace past the kept text when the sentinel itself is deleted, and asks to start over", () => {
    const typed = new TypedText();

    // An empty field: the textarea held only the sentinel, and Backspace deleted it.
    expect(typed.edit("")).toEqual({ backspaces: 1, insert: "", kept: false });

    typed.reset();
    typed.edit(typedAfterSentinel("ab"));

    // Selecting everything and deleting it removes the two letters and one character before them.
    expect(typed.edit("")).toEqual({ backspaces: 3, insert: "", kept: false });
  });

  it("starts over once it holds too much", () => {
    const typed = new TypedText();

    expect(typed.edit(typedAfterSentinel("x".repeat(1001))).kept).toBe(false);
  });

  it("forgets what was sent at a reset, as the tab's caret may have moved", () => {
    const typed = new TypedText();

    typed.edit(typedAfterSentinel("abc"));
    typed.reset();

    expect(typed.edit(typedAfterSentinel("d"))).toEqual({ backspaces: 0, insert: "d", kept: true });
  });
});
