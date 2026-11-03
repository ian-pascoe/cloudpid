// @effect-diagnostics preferEffectArray:off -- plain arrays of fixtures.
import { describe, expect, it } from "vitest";
import { type ImportFacts, translatePiSession, translated } from "./import-translate.ts";

const facts: ImportFacts = {
  branch: "feature/x",
  repos: [{ name: "app", directory: "/workspace/app" }],
  warnings: ["The local model m is not one of the owner's models."],
};

const header = JSON.stringify({ type: "session", version: 3, id: "s", cwd: "/home/o/app" });

const user = JSON.stringify({
  type: "message",
  id: "1",
  parentId: null,
  message: { role: "user", content: "hello", timestamp: 1 },
});

const assistant = JSON.stringify({
  type: "message",
  id: "2",
  parentId: "1",
  message: { role: "assistant", content: [{ type: "text", text: "hi" }], usage: { input: 3 } },
});

const result = JSON.stringify({
  type: "message",
  id: "3",
  parentId: "2",
  message: { role: "toolResult", toolCallId: "c", content: [] },
});

describe("the baseline translation", () => {
  it("maps the three message roles unchanged, drops the rest by kind, and ends with the notice", () => {
    const lines = [
      header,
      user,
      JSON.stringify({ type: "model_change", id: "x" }),
      assistant,
      JSON.stringify({ type: "message", id: "b", message: { role: "bashExecution" } }),
      JSON.stringify({ type: "model_change", id: "y" }),
      result,
    ];

    const out = translatePiSession(lines, facts);

    if (!translated(out)) throw new Error(out.failed);

    expect(out.entries.map((entry) => entry.kind)).toEqual([
      "pi.user",
      "pi.assistant",
      "pi.tool-result",
      "pi.user",
    ]);
    expect(out.entries.map((entry) => entry.id)).toEqual([1, 2, 3, 4]);
    expect(out.entries[1]?.model?.[0]).toMatchObject({ role: "assistant", usage: { input: 3 } });
    expect(out.summary).toEqual({
      cut: 0,
      dropped: { model_change: 2, "message:bashExecution": 1 },
      closed: 0,
    });

    // The notice is last: it names the laptop's cwd, the Workspace's branch and Repos, the fallback and the counts.
    const notice = JSON.stringify(out.entries.at(-1)?.model);

    expect(notice).toContain("/home/o/app");
    expect(notice).toContain("feature/x");
    expect(notice).toContain("/workspace/app");
    expect(notice).toContain("not one of the owner's models");
    expect(notice).toContain("dropped 3");
    expect(notice).toContain("git pull");
  });

  it("is just the notice for a file with a header and nothing else", () => {
    const out = translatePiSession([header], facts);

    if (!translated(out)) throw new Error(out.failed);

    expect(out.entries).toHaveLength(1);
  });

  it.each([
    ["an empty file", [], /empty/],
    ["a file without a header", [user], /header/],
    ["a line that is not an entry", [header, "not json"], /Line 2/],
  ])("fails %s with a sentence", (_name, lines, message) => {
    const out = translatePiSession(lines, facts);

    expect(translated(out)).toBe(false);
    expect(translated(out) ? "" : out.failed).toMatch(message);
  });
});
