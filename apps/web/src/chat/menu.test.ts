// @effect-diagnostics preferEffectArray:off preferEffectRecord:off -- assertions over the menu's native arrays and records.

import { describe, expect, it } from "vitest";
import type { ComposerCommand } from "./commands.ts";
import { detectTrigger } from "./completion.ts";
import { completionFor, type FileResults, menuKey } from "./menu.ts";

const run = () => null;

const commands: readonly ComposerCommand[] = [
  { name: "compact", description: "Compact", argument: "optional", argumentHint: "[focus]", run },
  { name: "export", description: "Export", argument: "none", run },
  {
    name: "todo",
    description: "Todo",
    argument: "required",
    argumentHint: "clear",
    choices: [{ value: "clear", description: "Remove every Task" }],
    run,
  },
];

const catalog = {
  templates: [{ name: "review", description: "Review a change", argumentHint: "<ref>" }],
  skills: [
    { name: "deploy", description: "Deploy" },
    { name: "review-pr", description: "Review a PR" },
  ],
};

/** The menu for `text` with the caret at its end: each section's label and its rows' labels. */
const menuOf = (text: string) => {
  const trigger = detectTrigger(text, text.length);
  const completion = trigger === null ? null : completionFor(trigger, commands, catalog);

  return completion?.sections.map((section) => [
    section.label,
    section.rows.map((row) => row.label),
  ]);
};

describe("the composer's menu", () => {
  it("lists commands, then Prompt templates, then Skills as /skill:name after /", () => {
    expect(menuOf("/")).toEqual([
      ["Commands", ["/compact", "/export", "/todo"]],
      ["Prompt templates", ["/review"]],
      ["Skills", ["/skill:deploy", "/skill:review-pr"]],
    ]);
    expect(menuOf("/rev")).toEqual([
      ["Prompt templates", ["/review"]],
      ["Skills", ["/skill:review-pr"]],
    ]);
    expect(menuOf("/skill:d")).toEqual([["Skills", ["/skill:deploy"]]]);
  });

  it("inserts a template's or a Skill's command, and runs a command without an argument", () => {
    const completion = completionFor(detectTrigger("/", 1)!, commands, catalog);

    const picks = Object.fromEntries(
      completion?.entries.map((entry) => [
        entry.label,
        entry.pick.kind === "insert" ? entry.pick.text : `run ${entry.pick.command.name}`,
      ]) ?? [],
    );

    expect(picks).toEqual({
      "/compact": "/compact",
      "/export": "run export",
      "/todo": "/todo",
      "/review": "/review",
      "/skill:deploy": "/skill:deploy",
      "/skill:review-pr": "/skill:review-pr",
    });
  });

  it("lists a command's argument values", () => {
    expect(menuOf("/todo ")).toEqual([["/todo", ["clear"]]]);
    expect(menuOf("/review ")).toBeUndefined();
  });

  it("lists only the Skills after $, inserting $name", () => {
    expect(menuOf("use $")).toEqual([["Skills", ["$deploy", "$review-pr"]]]);

    const completion = completionFor(detectTrigger("$dep", 4)!, commands, catalog);

    expect(completion?.entries[0]?.pick).toEqual({ kind: "insert", text: "$deploy" });
  });

  it("shows no menu after $ when no Skill matches, as for a shell variable", () => {
    expect(menuOf("echo $HOME")).toBeUndefined();
    expect(menuOf("/zzz")).toBeUndefined();
  });

  it("lists only the composer's commands before the catalog arrives", () => {
    const trigger = detectTrigger("/", 1)!;

    expect(completionFor(trigger, commands)?.sections.map((section) => section.label)).toEqual([
      "Commands",
    ]);
    expect(completionFor(detectTrigger("$", 1)!, commands)).toBeNull();
  });
});

describe("the @ menu", () => {
  const found = (query: string, paths: readonly string[]): FileResults => ({
    query,
    paths,
    searching: false,
    failed: false,
  });

  /** The menu for `text` with the caret at its end and `files` as the Session answered: its rows' labels and notice. */
  const filesMenu = (text: string, files: FileResults | undefined) => {
    const completion = completionFor(detectTrigger(text, text.length)!, commands, catalog, files);

    return {
      rows: completion?.entries.map((entry) => `${entry.detail ?? ""}${entry.label}`),
      notice: completion?.notice,
    };
  };

  it("lists the files and folders the Session answered for the query, inserting @path", () => {
    const files = found("src", ["src/", "src/app.ts"]);

    expect(filesMenu("see @src", files)).toEqual({
      rows: ["src/", "src/app.ts"],
      notice: undefined,
    });

    const completion = completionFor(detectTrigger("@src", 4)!, commands, catalog, files);

    // A file ends the mention; a folder keeps it open, so typing on narrows into it.
    expect(completion?.entries.map((entry) => entry.pick)).toEqual([
      { kind: "insert", text: "@src/", continues: true },
      { kind: "insert", text: "@src/app.ts" },
    ]);
    expect(completion?.label).toBe("Files");
  });

  it("says it is searching until the Session first answers", () => {
    expect(filesMenu("@", undefined)).toEqual({ rows: [], notice: "Searching files…" });
    expect(filesMenu("@ap", { query: null, paths: [], searching: true, failed: false })).toEqual({
      rows: [],
      notice: "Searching files…",
    });
  });

  it("narrows the last answer while the Session searches for the new query", () => {
    const files: FileResults = {
      query: "s",
      paths: ["src/", "src/app.ts", "src/menu.ts"],
      searching: true,
      failed: false,
    };

    expect(filesMenu("@src/ap", files)).toEqual({ rows: ["src/app.ts"], notice: undefined });
    expect(filesMenu("@zzz", files)).toEqual({ rows: [], notice: "Searching files…" });
  });

  it("says when nothing matches, and when the Session could not search", () => {
    expect(filesMenu("@zzz", found("zzz", []))).toEqual({
      rows: [],
      notice: "No matching files or folders.",
    });
    expect(filesMenu("@ap", { query: "ap", paths: [], searching: false, failed: true })).toEqual({
      rows: [],
      notice: "Could not search the files.",
    });
  });
});

describe("a file row", () => {
  it("shows the name first, a folder's with its slash, and the folder it is in apart", () => {
    const files: FileResults = {
      query: "",
      paths: ["README.md", "src/", "src/chat/", "src/chat/menu.ts"],
      searching: false,
      failed: false,
    };

    const completion = completionFor(detectTrigger("@", 1)!, commands, catalog, files);

    expect(completion?.entries.map(({ label, detail }) => [label, detail])).toEqual([
      ["README.md", undefined],
      ["src/", undefined],
      ["chat/", "src/"],
      ["menu.ts", "src/chat/"],
    ]);
  });
});

describe("the keys an open menu takes", () => {
  const press = (key: string, rows: number, more: { shiftKey?: boolean; altKey?: boolean } = {}) =>
    menuKey({ key, shiftKey: more.shiftKey ?? false, altKey: more.altKey ?? false }, rows);

  it("moves, picks and closes while it has rows", () => {
    expect(press("ArrowDown", 2)).toBe("next");
    expect(press("ArrowUp", 2)).toBe("previous");
    expect(press("Enter", 2)).toBe("pick");
    expect(press("Tab", 2)).toBe("pick");
    expect(press("Escape", 2)).toBe("close");
    // Shift+Enter is a new line, Alt+Enter a follow-up.
    expect(press("Enter", 2, { shiftKey: true })).toBeNull();
    expect(press("Enter", 2, { altKey: true })).toBeNull();
  });

  it("leaves Enter to send and the arrows to the caret with only its notice", () => {
    expect(press("Enter", 0)).toBeNull();
    expect(press("Tab", 0)).toBeNull();
    expect(press("ArrowDown", 0)).toBeNull();
    expect(press("ArrowUp", 0)).toBeNull();
    expect(press("Escape", 0)).toBe("close");
  });
});
