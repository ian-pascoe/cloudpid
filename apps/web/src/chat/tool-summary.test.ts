import { describe, expect, it } from "vitest";
import { toolSummary } from "./tool-summary.ts";

describe("toolSummary", () => {
  it("names the path a file tool works on", () => {
    expect(toolSummary("read", { path: "src/a.ts" })).toBe("src/a.ts");
    expect(toolSummary("write", { path: "notes.txt", content: "long text" })).toBe("notes.txt");
    expect(toolSummary("edit", { path: "src/a.ts", edits: [] })).toBe("src/a.ts");
    expect(toolSummary("ls", { path: "src" })).toBe("src");
  });

  it("names the pattern a search looks for, and where", () => {
    expect(toolSummary("grep", { pattern: "needle" })).toBe("needle");
    expect(toolSummary("grep", { pattern: "needle", path: "src" })).toBe("needle in src");
    expect(toolSummary("find", { pattern: "*.ts", path: "src" })).toBe("*.ts in src");
  });

  it("shows the first line of a command, cut when it is long", () => {
    expect(toolSummary("bash", { command: "ls -la\nrm -rf x" })).toBe("ls -la");
    expect(toolSummary("bash", { command: "x".repeat(200) })).toBe(`${"x".repeat(79)}…`);
  });

  it("shows the first line of a script, past its options line", () => {
    expect(
      toolSummary("codemode", { code: "const a = await tools.read({ path: 'a' });\nreturn a;" }),
    ).toBe("const a = await tools.read({ path: 'a' });");
    expect(
      toolSummary("codemode", { code: '// @options: {"timeout_ms": 5000}\n\nreturn 1;' }),
    ).toBe("return 1;");
    expect(toolSummary("codemode", { code: "" })).toBeUndefined();
  });

  it("has nothing to say about a tool it does not know, or arguments it cannot read", () => {
    expect(toolSummary("web_fetch", { url: "https://example.com" })).toBeUndefined();
    expect(toolSummary("read", {})).toBeUndefined();
    expect(toolSummary("read", { path: 3 })).toBeUndefined();
    expect(toolSummary("ls", {})).toBeUndefined();
  });
});
