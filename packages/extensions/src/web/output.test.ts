// @effect-diagnostics preferEffectArray:off
import { describe, expect, it } from "vitest";
import {
  boundStructuredText,
  fitOutput,
  fitWindowedOutput,
  OUTPUT_MAX_BYTES,
  OUTPUT_MAX_LINES,
  selectLines,
  STRUCTURED_MAX_BYTES,
} from "./output.ts";

const lines = (count: number, make = (index: number) => `line ${index + 1}`): string =>
  Array.from({ length: count }, (_, index) => make(index)).join("\n");

const bytes = (text: string): number => new TextEncoder().encode(text).length;

/** A window over a whole text, as a fetch without `offset`/`limit` has. */
const whole = (text: string) => ({ firstLine: 1, totalLines: text.split("\n").length });

describe("fitWindowedOutput", () => {
  it("returns a small whole page unchanged, with no note", () => {
    const text = lines(10);

    expect(fitWindowedOutput(text, whole(text))).toEqual({ content: text, truncated: false });
  });

  it("notes the lines that remain after a requested window, and where to continue", () => {
    const window = { firstLine: 5, totalLines: 100 };

    expect(fitWindowedOutput(lines(10), window).content).toBe(
      `${lines(10)}\n\n[Showing lines 5-14 of 100. 86 lines remain. Use offset=15 to continue.]`,
    );
  });

  it("says '1 line remains' for the last one", () => {
    expect(fitWindowedOutput("a\nb", { firstLine: 1, totalLines: 3 }).content).toMatch(
      /1 line remains\. Use offset=3 to continue\.\]$/,
    );
  });

  it("adds no note when the window reaches the end of the page", () => {
    expect(fitWindowedOutput("c\nd", { firstLine: 3, totalLines: 4 })).toEqual({
      content: "c\nd",
      truncated: false,
    });
  });

  it("cuts at the line limit, naming the next unseen line", () => {
    const text = lines(5000);
    const out = fitWindowedOutput(text, whole(text));

    expect(out.truncated).toBe(true);
    expect(out.content.split("\n").length).toBeLessThanOrEqual(OUTPUT_MAX_LINES);

    const shown = Number(/Showing lines 1-(\d+) of 5000/.exec(out.content)?.[1]);

    expect(out.content).toContain(`Use offset=${shown + 1} to continue.`);
    expect(out.content.startsWith("line 1\nline 2\n")).toBe(true);
    expect(out.content).toContain(`\n${`line ${shown}`}\n\n[Showing`);
  });

  it("cuts at the byte limit with the note inside the limit, counting multibyte text", () => {
    const text = lines(1000, (index) => `日本語の行 ${index}: ${"é".repeat(60)}`);
    const out = fitWindowedOutput(text, whole(text));

    expect(out.truncated).toBe(true);
    expect(bytes(out.content)).toBeLessThanOrEqual(OUTPUT_MAX_BYTES);
    expect(out.content).toMatch(/Use offset=\d+ to continue\.\]$/);
  });

  it("pages through a long page with the notes' offsets and sees every line exactly once", () => {
    const text = lines(7000, (index) => `row ${index + 1} ${"x".repeat(index % 40)}`);
    const total = text.split("\n").length;
    const seen: string[] = [];
    let offset = 1;

    while (offset <= total) {
      const selected = selectLines(text, offset, undefined);

      expect(selected).toBeDefined();

      const out = fitWindowedOutput(selected?.text ?? "", selected?.window ?? whole(text));
      const next = /Use offset=(\d+) to continue\.\]$/.exec(out.content);

      const body =
        next === null ? out.content : out.content.slice(0, out.content.lastIndexOf("\n\n[Showing"));

      seen.push(...body.split("\n"));
      offset = next === null ? total + 1 : Number(next[1]);
    }

    expect(seen).toEqual(text.split("\n"));
  });

  it("shows the start of a first line that is over the byte limit, and where to read on", () => {
    const text = `${"x".repeat(OUTPUT_MAX_BYTES * 2)}\nsecond`;
    const out = fitWindowedOutput(text, whole(text));

    expect(out.truncated).toBe(true);
    expect(bytes(out.content)).toBeLessThanOrEqual(OUTPUT_MAX_BYTES);
    expect(out.content.startsWith("xxxx")).toBe(true);
    expect(out.content).toMatch(
      /Line 1 is longer than the 50 KiB output limit.*Use offset=2 to continue after it\.\]$/,
    );
  });

  it("does not suggest an offset after an oversized last line", () => {
    const out = fitWindowedOutput("y".repeat(OUTPUT_MAX_BYTES * 2), {
      firstLine: 1,
      totalLines: 1,
    });

    expect(out.content).not.toContain("offset=");
    expect(out.content).toContain("cannot be read");
  });
});

describe("fitOutput", () => {
  it("returns text within the limits unchanged", () => {
    expect(fitOutput("hello", "narrow it")).toEqual({ content: "hello", truncated: false });
  });

  it("cuts to whole lines inside the limits and gives the advice", () => {
    const out = fitOutput(lines(4000), "Lower contextMaxCharacters.");

    expect(out.truncated).toBe(true);
    expect(out.content).toMatch(
      /\n\n\[Output truncated to the first \d+ of 4000 lines\. Lower contextMaxCharacters\.\]$/,
    );
    expect(out.content.split("\n").length).toBeLessThanOrEqual(OUTPUT_MAX_LINES);
    expect(bytes(out.content)).toBeLessThanOrEqual(OUTPUT_MAX_BYTES);
  });
});

describe("selectLines", () => {
  const text = lines(10);

  it("reads limit lines from a 1-indexed offset", () => {
    expect(selectLines(text, 3, 2)).toEqual({
      text: "line 3\nline 4",
      window: { firstLine: 3, totalLines: 10 },
      lastLine: 4,
    });
  });

  it("treats a limit without an offset as starting at line 1, and an offset alone as running to the end", () => {
    expect(selectLines(text, undefined, 2)?.text).toBe("line 1\nline 2");
    expect(selectLines(text, 9, undefined)?.text).toBe("line 9\nline 10");
  });

  it("returns the page whole without either", () => {
    expect(selectLines(text, undefined, undefined)?.text).toBe(text);
  });

  it("finds nothing past the end", () => {
    expect(selectLines(text, 11, undefined)).toBeUndefined();
  });
});

describe("boundStructuredText", () => {
  it("cuts at 1 MiB on a character boundary", () => {
    const text = "é".repeat(STRUCTURED_MAX_BYTES);
    const bounded = boundStructuredText(text);

    expect(bounded.truncated).toBe(true);
    expect(bytes(bounded.content)).toBeLessThanOrEqual(STRUCTURED_MAX_BYTES);
    expect(bounded.content).not.toContain("\ufffd");
    expect(boundStructuredText("small")).toEqual({ content: "small", truncated: false });
  });
});
