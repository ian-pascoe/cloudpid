// @effect-diagnostics preferEffectArray:off -- tests of plain text functions.
import { describe, expect, it } from "vitest";
import {
  type Annotation,
  cutQuote,
  MAX_QUOTE_BYTES,
  MAX_QUOTE_LINES,
  resolvePath,
} from "./annotations.ts";
import type { ConversationId } from "./conversation-id.ts";
import { languageOf, renderReview, reviewMessage, shownReview } from "./review.ts";

// SAFETY: a pi-durable conversation ID is a positive integer.
const conversation = 3 as ConversationId;

const onChanges = (overrides: Partial<Annotation> = {}): Annotation => ({
  id: "a1",
  source: { kind: "changes", repo: "app", head: "abc1234" },
  path: "src/a.ts",
  side: "new",
  start: 12,
  end: 13,
  quote: ["const a = 1;", "const b = 2;"],
  more: 0,
  text: "Name these better.",
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const onCall = (overrides: Partial<Annotation> = {}): Annotation => ({
  id: "c1",
  source: { kind: "call", conversationId: conversation, callId: "call-7", tool: "edit" },
  path: "/workspace/app/README.md",
  side: "new",
  start: 3,
  end: 3,
  quote: ["Hello."],
  more: 0,
  text: "Say more here.",
  createdAt: 5,
  updatedAt: 5,
  ...overrides,
});

describe("cutQuote", () => {
  it("leaves a quote within the limits as it is", () => {
    expect(cutQuote(["a", "b"])).toEqual({ quote: ["a", "b"], more: 0 });
  });

  it("keeps the first 50 lines and counts the rest", () => {
    const lines = Array.from({ length: 62 }, (_, index) => `line ${index + 1}`);

    expect(cutQuote(lines)).toEqual({ quote: lines.slice(0, MAX_QUOTE_LINES), more: 12 });
  });

  it("keeps the lines that fit 8 KB, a newline counted after each", () => {
    const line = "x".repeat(1023);
    const cut = cutQuote(Array.from({ length: 10 }, () => line));

    // 1,024 bytes a line with its newline: eight fit 8,192 bytes.
    expect(cut.quote).toHaveLength(8);
    expect(cut.more).toBe(2);
  });

  it("cuts a first line longer than the limit short, on a whole character", () => {
    const cut = cutQuote(["é".repeat(5_000), "next"]);

    expect(cut.clipped).toBe(true);
    expect(cut.more).toBe(1);
    expect(cut.quote[0]).toBe("é".repeat(4_095));
    expect(new TextEncoder().encode(cut.quote[0]).length).toBeLessThan(MAX_QUOTE_BYTES);
    expect(cutQuote(cut.quote, cut.more, cut.clipped)).toEqual(cut);
  });
});

describe("resolvePath", () => {
  it("resolves a relative path against the directory, folding . and .., and keeps an absolute one", () => {
    expect(resolvePath("/workspace/app", "src/a.ts")).toBe("/workspace/app/src/a.ts");
    expect(resolvePath("/workspace/app", "./src/../lib/b.ts")).toBe("/workspace/app/lib/b.ts");
    expect(resolvePath("/workspace/app", "/etc/hosts")).toBe("/etc/hosts");
    expect(resolvePath("/workspace", "../../x")).toBe("/x");
  });
});

describe("languageOf", () => {
  it("names a fence by the file's extension, and leaves an unknown one plain", () => {
    expect(languageOf("/workspace/app/src/a.ts")).toBe("ts");
    expect(languageOf("main.PY")).toBe("python");
    expect(languageOf("Dockerfile")).toBe("dockerfile");
    expect(languageOf("notes.weird")).toBe("");
    expect(languageOf(".env")).toBe("");
  });
});

describe("renderReview", () => {
  it("groups by source, then file, then line, numbers the Annotations, and quotes each in its language", () => {
    const { markdown } = renderReview([
      onCall(),
      onChanges({ id: "a2", path: "src/b.py", start: 4, end: 4, quote: ["x = 1"], text: "Why?" }),
      onChanges(),
      onChanges({
        id: "a3",
        side: "old",
        start: 10,
        end: 12,
        quote: ["one", "two", "three"],
        text: "Keep these.",
      }),
    ]);

    expect(markdown).toBe(
      [
        "## Review: 4 Annotations",
        "",
        "### Uncommitted Changes in `app`",
        "",
        "**Annotation 1**: `/workspace/app/src/a.ts`, removed lines 10–12",
        "",
        "```ts",
        "one",
        "two",
        "three",
        "```",
        "",
        "Keep these.",
        "",
        "**Annotation 2**: `/workspace/app/src/a.ts`, lines 12–13",
        "",
        "```ts",
        "const a = 1;",
        "const b = 2;",
        "```",
        "",
        "Name these better.",
        "",
        "**Annotation 3**: `/workspace/app/src/b.py`, line 4",
        "",
        "```python",
        "x = 1",
        "```",
        "",
        "Why?",
        "",
        "### Your `edit` call on `/workspace/app/README.md`: lines as of that call",
        "",
        "**Annotation 4**: `/workspace/app/README.md`, line 3",
        "",
        "```md",
        "Hello.",
        "```",
        "",
        "Say more here.",
      ].join("\n"),
    );
  });

  it("says when the lines have changed since, or are no longer in the diff", () => {
    const { markdown } = renderReview([
      onChanges({ status: "outdated" }),
      onChanges({ id: "a2", path: "src/c.ts", status: "gone" }),
    ]);

    expect(markdown).toContain("```\n\nThese lines have changed since.\n\nName these better.");
    expect(markdown).toContain("```\n\nThese lines are no longer in the diff.\n\nName these better.");
  });

  it("says how many lines a cut quote leaves out, and fences a quote holding backticks with more of them", () => {
    const { markdown } = renderReview([
      onChanges({ start: 1, end: 70, quote: ["```", "code"], more: 68 }),
      onChanges({ id: "a2", start: 80, end: 80, quote: ["x".repeat(10)], clipped: true }),
    ]);

    expect(markdown).toContain(
      "lines 1–70\n\n````ts\n```\ncode\n````\n… 68 more lines\n\nName these better.",
    );
    expect(markdown).toContain("line 80\n\n```ts\nxxxxxxxxxx\n```\n… the line goes on\n\n");
  });

  it("names a rename's old path, and a single Annotation in the singular", () => {
    const { markdown } = renderReview([onChanges({ oldPath: "src/old.ts" })]);

    expect(markdown).toMatch(/^## Review: 1 Annotation\n/);
    expect(markdown).toContain("lines 12–13 (renamed from `src/old.ts`)");
  });

  it("never calls an Annotation a note", () => {
    const { markdown } = renderReview([
      onChanges({ status: "outdated", more: 3 }),
      onCall({ side: "old", clipped: true }),
      onChanges({ id: "a3", status: "gone" }),
    ]);

    expect(markdown).not.toMatch(/note/i);
  });
});

describe("shownReview", () => {
  it("reads each quote and text back from the model message, after the summary", () => {
    const { markdown, data } = renderReview([
      onChanges(),
      onCall({ quote: [""], text: "" }),
    ]);

    const shown = shownReview(reviewMessage("Please look.", markdown), data);

    expect(shown).toMatchObject([
      {
        file: "/workspace/app/src/a.ts",
        side: "new",
        start: 12,
        end: 13,
        quote: ["const a = 1;", "const b = 2;"],
        text: "Name these better.",
      },
      { file: "/workspace/app/README.md", quote: [""], text: "" },
    ]);
  });

  it("puts the Markdown alone when the summary is empty", () => {
    expect(reviewMessage("  ", "## Review: 1 Annotation")).toBe("## Review: 1 Annotation");
    expect(reviewMessage("Look", "## R")).toBe("Look\n\n## R");
  });
});
