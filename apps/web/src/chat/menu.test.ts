// @effect-diagnostics preferEffectArray:off preferEffectRecord:off -- assertions over the menu's native arrays and records.

import type { McpMenuResource, McpPromptEntry, McpResourceMenu } from "@cloudpid/protocol";
import * as Match from "effect/Match";
import { describe, expect, it } from "vitest";
import type { ComposerCommand } from "./commands.ts";
import { detectTrigger } from "./completion.ts";
import {
  completionFor,
  type FileResults,
  menuKey,
  type MenuPick,
  promptHint,
  promptSummary,
} from "./menu.ts";

const run = () => null;

/** What a pick does, in words: the text it inserts, or `run <command>`. */
const pickedAs = (pick: MenuPick): string =>
  Match.value(pick).pipe(
    Match.discriminatorsExhaustive("kind")({
      insert: ({ text }) => text,
      run: ({ command }) => `run ${command.name}`,
      prompt: () => "prompt",
      resource: ({ server, resource }) => `attach ${server} ${resource.uri}`,
      none: () => "none",
    }),
  );

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
      completion?.entries.map((entry) => [entry.label, pickedAs(entry.pick)]) ?? [],
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

describe("the MCP prompts in the composer's menu", () => {
  const prompt = (
    server: string,
    name: string,
    more: Partial<McpPromptEntry> = {},
  ): McpPromptEntry => ({
    command: `/mcp__${server}__${name}`,
    server,
    source: "owner",
    name,
    description: "",
    arguments: [],
    completions: false,
    ...more,
  });

  const withPrompts = {
    ...catalog,
    prompts: [
      prompt("docs", "review", {
        title: "Review PR",
        description: "Review a pull request\nin depth",
        arguments: [
          { name: "pr", required: true },
          { name: "focus", required: false },
        ],
      }),
      prompt("docs", "summarize"),
      prompt("lint", "fix", { source: "repo:acme/web", title: "Fix lint" }),
    ],
    mcpServers: [
      { server: "wiki", state: "connecting" },
      { server: "crm", state: "sign_in" },
      { server: "old", state: "a state a newer Session adds" },
    ],
  };

  const menuFor = (text: string) => {
    const trigger = detectTrigger(text, text.length);

    return trigger === null ? null : completionFor(trigger, commands, withPrompts);
  };

  it("lists them after the Skills, a section for each server, and says where a Repo's definition is", () => {
    expect(menuFor("/")?.sections.map((section) => section.label)).toEqual([
      "Commands",
      "Prompt templates",
      "Skills",
      "MCP · docs",
      "MCP · lint · from acme/web",
      "MCP · wiki",
      "MCP · crm",
      "MCP · old",
    ]);
  });

  it("shows a row with `mcp__<server>__` muted before its name, its argument hint, then its title and first description line", () => {
    const row = menuFor("/")?.entries.find((entry) => entry.id === "prompt:docs:review");

    expect(row).toMatchObject({
      prefix: "/mcp__docs__",
      label: "review",
      hint: "<pr> [focus]",
      description: "Review PR — Review a pull request",
    });
    expect(row?.pick).toMatchObject({ kind: "prompt", prompt: { name: "review" } });
  });

  it("says why a server has no prompts yet in a muted row that cannot be picked", () => {
    const rows = menuFor("/")?.entries.filter((entry) => entry.muted === true);

    expect(rows?.map((row) => [row.label, row.description, row.pick.kind])).toEqual([
      ["wiki", "connecting…", "none"],
      ["crm", "sign-in needed", "none"],
      ["old", "unavailable", "none"],
    ]);
  });

  it("ranks the rows by what is typed, across the command, and leaves them out of the `$` menu", () => {
    expect(menuFor("/rev")?.entries.map((entry) => entry.id)).toContain("prompt:docs:review");
    expect(menuFor("/mcp__lint")?.entries.map((entry) => entry.id)).toEqual(["prompt:lint:fix"]);
    expect(menuFor("$")?.entries.some((entry) => entry.id.startsWith("prompt:"))).toBe(false);
  });

  it("hints required arguments in angle brackets and optional ones in square brackets, and nothing for none", () => {
    expect(promptHint(prompt("a", "b"))).toBeUndefined();
    expect(promptSummary(prompt("a", "b"))).toBeUndefined();
    expect(promptSummary(prompt("a", "b", { description: "Only a description" }))).toBe(
      "Only a description",
    );
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

describe("the MCP resources in the @ menu", () => {
  const resource = (name: string, uri: string, more: Partial<McpMenuResource> = {}) => ({
    name,
    uri,
    ...more,
  });

  const resources: McpResourceMenu = {
    servers: [
      {
        server: "docs",
        source: "owner",
        state: "ok",
        resources: [
          resource("readme", "file:///docs/readme.md", {
            title: "Read me",
            description: "How to start\nmore",
          }),
          resource("changelog", "file:///docs/changelog.md"),
        ],
      },
      {
        server: "wiki",
        source: "repo:acme/web",
        state: "ok",
        resources: [resource("home", "https://wiki.test/home", { mimeType: "text/html" })],
      },
      { server: "logs", source: "owner", state: "stopped", resources: [] },
      { server: "crm", source: "owner", state: "sign_in", resources: [] },
    ],
  };

  const none: FileResults = { query: "", paths: [], searching: false, failed: false };

  const menuFor = (text: string, listed: McpResourceMenu | null = resources, files = none) => {
    const trigger = detectTrigger(text, text.length);

    return trigger === null ? null : completionFor(trigger, commands, catalog, files, listed);
  };

  it("lists the servers' resources after the files, a section for each, with a Repo's source said", () => {
    const files: FileResults = { ...none, paths: ["README.md"] };

    expect(menuFor("@", resources, files)?.sections.map((section) => section.label)).toEqual([
      "Files",
      "MCP · docs",
      "MCP · wiki · from acme/web",
      "MCP · logs",
      "MCP · crm",
    ]);
  });

  it("shows a resource as its title or name, its URI muted after it, and the first description line", () => {
    const row = menuFor("@")?.entries.find(
      (entry) => entry.id === "resource:docs:file:///docs/readme.md",
    );

    expect(row).toMatchObject({
      label: "Read me",
      detail: "file:///docs/readme.md",
      description: "How to start",
    });
    expect(row?.pick).toMatchObject({ kind: "resource", server: "docs" });
  });

  it("says why a server lists none in a muted row that cannot be picked", () => {
    const rows = menuFor("@")?.entries.filter((entry) => entry.muted === true);

    expect(rows?.map((row) => [row.label, row.description, row.pick.kind])).toEqual([
      ["logs", "not running: its Container is stopped", "none"],
      ["crm", "sign-in needed", "none"],
    ]);
  });

  it("ranks by what is typed, by name or title first and then by URI", () => {
    expect(menuFor("@chan")?.entries.map((entry) => entry.id)).toEqual([
      "resource:docs:file:///docs/changelog.md",
    ]);
    expect(menuFor("@wiki.test")?.entries.map((entry) => entry.id)).toEqual([
      "resource:wiki:https://wiki.test/home",
    ]);
  });

  it("ranks by match first and then by the server's priority, higher first, then in the server's order", () => {
    const ranked: McpResourceMenu = {
      servers: [
        {
          server: "docs",
          source: "owner",
          state: "ok",
          resources: [
            resource("note-low", "file:///1", { priority: 0.1 }),
            resource("note-unset", "file:///2"),
            resource("note-high", "file:///3", { priority: 0.9 }),
            resource("note", "file:///4", { priority: 0 }),
          ],
        },
      ],
    };

    // With nothing typed every row ties on match: priority decides, an unset one between low and high.
    expect(menuFor("@", ranked)?.entries.map((entry) => entry.label)).toEqual([
      "note-high",
      "note-unset",
      "note-low",
      "note",
    ]);
    // An exact match stays ahead of a higher priority, and the prefix matches follow by priority.
    expect(menuFor("@note", ranked)?.entries.map((entry) => entry.label)).toEqual([
      "note",
      "note-high",
      "note-unset",
      "note-low",
    ]);
    expect(menuFor("@docs:", ranked)?.entries.map((entry) => entry.label)).toEqual([
      "note-high",
      "note-unset",
      "note-low",
      "note",
    ]);
  });

  it("narrows to one server's resources after @server:", () => {
    const completion = menuFor("@docs:");

    expect(completion?.sections.map((section) => section.label)).toEqual(["MCP · docs"]);
    expect(completion?.entries.map((entry) => entry.label)).toEqual(["Read me", "changelog"]);
    expect(menuFor("@docs:read")?.entries.map((entry) => entry.label)).toEqual(["Read me"]);
    expect(menuFor("@docs:zzz")?.notice).toBe("No matching resources in docs.");
    expect(menuFor("@logs:")?.entries.map((entry) => entry.description)).toEqual([
      "not running: its Container is stopped",
    ]);
  });

  it("is the files menu alone until the Session has answered, or when it has no resources", () => {
    expect(menuFor("@", null)?.notice).toBe(menuFor("@", { servers: [] })?.notice);
    expect(menuFor("@", null)?.entries.some((entry) => entry.pick.kind === "resource")).toBe(false);
  });
});
