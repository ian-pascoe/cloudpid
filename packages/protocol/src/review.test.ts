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

const onBranch = (overrides: Partial<Annotation> = {}): Annotation => ({
  id: "b1",
  source: {
    kind: "branch",
    repo: "app",
    branch: "feat/x",
    base: "main",
    mergeBase: "abc1234def",
    head: "0000000aaaa",
  },
  path: "src/a.ts",
  side: "new",
  start: 5,
  end: 6,
  quote: ["let a;", "let b;"],
  more: 0,
  text: "Why two?",
  createdAt: 3,
  updatedAt: 3,
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
        "> Keep these.",
        "",
        "**Annotation 2**: `/workspace/app/src/a.ts`, lines 12–13",
        "",
        "```ts",
        "const a = 1;",
        "const b = 2;",
        "```",
        "",
        "> Name these better.",
        "",
        "**Annotation 3**: `/workspace/app/src/b.py`, line 4",
        "",
        "```python",
        "x = 1",
        "```",
        "",
        "> Why?",
        "",
        "### Your `edit` call on `/workspace/app/README.md`: lines as of that call",
        "",
        "**Annotation 4**: `/workspace/app/README.md`, line 3",
        "",
        "```md",
        "Hello.",
        "```",
        "",
        "> Say more here.",
      ].join("\n"),
    );
  });

  it('heads a branch\'s group "Branch x against main at abc1234", between the Changes and the Call diffs', () => {
    const { markdown } = renderReview([
      onCall(),
      onBranch(),
      onBranch({
        id: "b2",
        source: {
          kind: "branch",
          repo: "lib",
          branch: null,
          base: "develop",
          mergeBase: "fedcba9876",
          head: "1111111",
        },
      }),
      onChanges(),
    ]);

    const headings = markdown.split("\n").filter((line) => line.startsWith("### "));

    expect(headings).toEqual([
      "### Uncommitted Changes in `app`",
      "### Branch `feat/x` against `main` at `abc1234`",
      "### Detached at `1111111` against `develop` at `fedcba9`",
      "### Your `edit` call on `/workspace/app/README.md`: lines as of that call",
    ]);
    expect(markdown).toContain("**Annotation 2**: `/workspace/app/src/a.ts`, lines 5–6");
    expect(markdown).toContain("**Annotation 3**: `/workspace/lib/src/a.ts`, lines 5–6");
  });

  it("heads a pull request's group \"Pull request #123 'title' at abc1234\", after the branches and before the Call diffs", () => {
    const onPull = (id: string, repo: string, number: number): Annotation => ({
      ...onBranch({ id }),
      source: {
        kind: "pull",
        repo,
        number,
        title: "Fix  the\nthing",
        mergeBase: "abc1234def",
        head: "0123456789",
      },
    });

    const { markdown } = renderReview([
      onCall(),
      onPull("p2", "app", 124),
      onPull("p1", "app", 123),
      onBranch(),
    ]);

    const headings = markdown.split("\n").filter((line) => line.startsWith("### "));

    expect(headings).toEqual([
      "### Branch `feat/x` against `main` at `abc1234`",
      "### Pull request #123 'Fix the thing' at `0123456`",
      "### Pull request #124 'Fix the thing' at `0123456`",
      "### Your `edit` call on `/workspace/app/README.md`: lines as of that call",
    ]);
  });

  it("names the current head of a group, not its first draft's, and the repo when two repos share a number", () => {
    const onPull = (
      id: string,
      repo: string,
      head: string,
      extra: Partial<Annotation>,
    ): Annotation => ({
      ...onBranch({ id }),
      source: { kind: "pull", repo, number: 7, title: "T", mergeBase: "abc1234def", head },
      ...extra,
    });

    // The first by path is marked, and keeps the old head; the others moved to the new one.
    const { markdown } = renderReview([
      onPull("old", "app", "1111111aaa", { path: "a.ts", status: "outdated", updatedAt: 9 }),
      onPull("new", "app", "2222222bbb", { path: "b.ts", updatedAt: 5 }),
      onPull("newer", "app", "3333333ccc", { path: "c.ts", updatedAt: 6 }),
    ]);

    expect(markdown).toContain("### Pull request #7 'T' at `3333333`");
    expect(markdown).not.toContain("` in `");

    const both = renderReview([
      onPull("a", "app", "1111111aaa", {}),
      onPull("b", "lib", "2222222bbb", {}),
    ]).markdown;

    expect(both).toContain("### Pull request #7 in `app` 'T' at `1111111`");
    expect(both).toContain("### Pull request #7 in `lib` 'T' at `2222222`");
  });

  it("heads the Last run's drafts by file, between the pull requests and the Call diffs, saying whether the Run had ended", () => {
    const onRun = (overrides: Partial<Annotation> = {}): Annotation => ({
      ...onChanges({ id: "r1", text: "Why here?" }),
      source: {
        kind: "run",
        conversationId: conversation,
        run: "run1abc",
        repo: "app",
        start: "1111111",
        end: "2222222",
      },
      ...overrides,
    });

    const { markdown } = renderReview([
      onCall(),
      onRun(),
      onRun({ id: "r2", path: "src/b.ts" }),
      onBranch(),
      onChanges(),
    ]);

    expect(markdown.split("\n").filter((line) => line.startsWith("### "))).toEqual([
      "### Uncommitted Changes in `app`",
      "### Branch `feat/x` against `main` at `abc1234`",
      "### Your changes in your last run to `/workspace/app/src/a.ts`: lines as of the end of that run",
      "### Your changes in your last run to `/workspace/app/src/b.ts`: lines as of the end of that run",
      "### Your `edit` call on `/workspace/app/README.md`: lines as of that call",
    ]);

    const live = renderReview([
      onRun({
        source: {
          kind: "run",
          conversationId: conversation,
          run: "run1abc",
          repo: "app",
          start: "1111111",
          end: null,
        },
      }),
    ]).markdown;

    expect(live).toContain("lines as of now");
  });

  it("says when the lines have changed since, or are no longer in the diff", () => {
    const { markdown } = renderReview([
      onChanges({ status: "outdated" }),
      onChanges({ id: "a2", path: "src/c.ts", status: "gone" }),
    ]);

    expect(markdown).toContain("```\n\nThese lines have changed since.\n\n> Name these better.");
    expect(markdown).toContain(
      "```\n\nThese lines are no longer in the diff.\n\n> Name these better.",
    );
  });

  it("puts removed lines first where both sides start at one line", () => {
    const { markdown } = renderReview([
      onChanges({ id: "added", text: "Added." }),
      onChanges({ id: "removed", side: "old", text: "Removed." }),
    ]);

    expect(markdown.indexOf("removed lines 12–13")).toBeLessThan(markdown.indexOf(", lines 12–13"));
    expect(markdown.indexOf("> Removed.")).toBeLessThan(markdown.indexOf("> Added."));
  });

  it("keeps a path or repo with backticks one code span, and the owner's open fence inside its quote", () => {
    const { markdown, data } = renderReview([
      onChanges({
        source: { kind: "changes", repo: "we`ird", head: null },
        path: "`a`.ts",
        text: "Try:\n```ts\nconst x = 1;\n\nno closing fence",
      }),
      onChanges({ id: "a2", start: 40, end: 40, text: "Next." }),
      onCall({
        source: { kind: "call", conversationId: conversation, callId: "c", tool: "e`dit" },
        path: "`x`",
      }),
    ]);

    expect(markdown).toContain("### Uncommitted Changes in ``we`ird``");
    // After repo `app`'s group.
    expect(markdown).toContain("**Annotation 2**: ``/workspace/we`ird/`a`.ts``");
    expect(markdown).toContain("### Your ``e`dit`` call on `` `x` ``");
    expect(markdown).toContain("> Try:\n> ```ts\n> const x = 1;\n>\n> no closing fence\n\n");
    expect(shownReview(markdown, data)[1]?.text).toBe(
      "Try:\n```ts\nconst x = 1;\n\nno closing fence",
    );
  });

  it("says how many lines a cut quote leaves out, and fences a quote holding backticks with more of them", () => {
    const { markdown } = renderReview([
      onChanges({ start: 1, end: 70, quote: ["```", "code"], more: 68 }),
      onChanges({ id: "a2", start: 80, end: 80, quote: ["x".repeat(10)], clipped: true }),
    ]);

    expect(markdown).toContain(
      "lines 1–70\n\n````ts\n```\ncode\n````\n… 68 more lines\n\n> Name these better.",
    );
    expect(markdown).toContain("line 80\n\n```ts\nxxxxxxxxxx\n```\n… the line goes on\n\n");
  });

  it("names a rename's old path, and a single Annotation in the singular", () => {
    const { markdown } = renderReview([onChanges({ oldPath: "src/old.ts" })]);

    expect(markdown).toMatch(/^## Review: 1 Annotation\n/);
    expect(markdown).toContain("lines 12–13 (renamed from `/workspace/app/src/old.ts`)");
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
    const { markdown, data } = renderReview([onChanges(), onCall({ quote: [""], text: "" })]);

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
