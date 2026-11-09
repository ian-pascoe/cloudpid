// @effect-diagnostics schemaSync:off preferTypedSchemaDecoder:off preferEffectRecord:off -- plain assertions over decoded values.
import { describe, expect, it } from "vitest";
import {
  cleanPromptArgument,
  flatCut,
  looksLikeMcpPromptCommand,
  promptArguments,
  promptArgumentsProblem,
} from "./mcp-prompts.ts";
import { userEntryData } from "./user-entry.ts";

const declared = [
  { name: "pr", required: true },
  { name: "note", required: false },
];

describe("an argument's value on one line", () => {
  it("runs its lines together and cuts it with a …", () => {
    expect(flatCut("  a\n b\t c ", 20)).toBe("a b c");
    expect(flatCut("x".repeat(30), 10)).toBe(`${"x".repeat(9)}…`);
    expect(flatCut("x".repeat(10), 10)).toBe("x".repeat(10));
  });
});

describe("a prompt's arguments", () => {
  it("are checked for required fields and the size bounds", () => {
    expect(promptArgumentsProblem(declared, { pr: "1" })).toBeUndefined();
    expect(promptArgumentsProblem(declared, { note: "x" })).toMatch(/pr is required/);
    expect(promptArgumentsProblem(declared, { pr: "  " })).toMatch(/pr is required/);
    expect(promptArgumentsProblem(declared, { pr: "x".repeat(64 * 1024 + 1) })).toMatch(
      /over 64 KiB/,
    );
    expect(
      promptArgumentsProblem([], {
        a: "x".repeat(60_000),
        b: "x".repeat(60_000),
        c: "x".repeat(60_000),
      }),
    ).toMatch(/over 128 KiB together/);
  });

  it("are sent as declared: cleaned, in order, the empty optional ones left out, the undeclared dropped", () => {
    expect(cleanPromptArgument("a\u0000b\u0007c\nd\te")).toBe("abc\nd\te");
    expect(promptArguments(declared, { note: "", extra: "x", pr: "12\u0000" })).toEqual({
      pr: "12",
    });
    expect(Object.keys(promptArguments(declared, { note: "n", pr: "1" }))).toEqual(["pr", "note"]);
  });
});

describe("the typed form of a prompt", () => {
  it("is /mcp__ and a non-space", () => {
    expect(looksLikeMcpPromptCommand("/mcp__github__review")).toBe(true);
    expect(looksLikeMcpPromptCommand("/mcp__ x")).toBe(false);
    expect(looksLikeMcpPromptCommand("/mcp")).toBe(false);
    expect(looksLikeMcpPromptCommand(" /mcp__a")).toBe(false);
  });
});

describe("what only gains", () => {
  it("decodes an entry that keeps an MCP prompt, and one whose prompt it cannot read", () => {
    const data = userEntryData({
      kind: "cloudpid.user",
      data: {
        display: "go",
        skills: [],
        mcpPrompt: {
          server: "github",
          command: "/mcp__github__review",
          name: "review",
          arguments: { pr: "1" },
          parts: [{ role: "user", type: "text" }],
          resources: [],
        },
      },
    });

    expect(data?.mcpPrompt?.command).toBe("/mcp__github__review");
    // An entry whose prompt this version cannot read stays readable, without it.
    expect(
      userEntryData({ kind: "cloudpid.user", data: { display: "go", skills: [], mcpPrompt: 7 } }),
    ).toEqual({ display: "go", skills: [] });
  });
});
