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

  it("shows the task a subagent starts with, the message an agent sends, and the agent a call addresses", () => {
    expect(toolSummary("subagent", { task: "Find the bug\nIt is in src" })).toBe("Find the bug");
    expect(toolSummary("subagent", { task: "Review", agent_id: "reviewer" })).toBe(
      "reviewer: Review",
    );
    expect(toolSummary("agent_message", { agent_id: "agent-1", message: "Stop" })).toBe(
      "agent-1: Stop",
    );
    expect(toolSummary("agent_message", { message: "Done early" })).toBe("Done early");
    expect(toolSummary("subagent_wait", { agent_id: "agent-1" })).toBe("agent-1");
    expect(toolSummary("browser_handoff", { instructions: "Log in\nthen press Done" })).toBe(
      "Log in",
    );
    expect(toolSummary("subagent_status", {})).toBeUndefined();
    expect(toolSummary("subagent_cancel", { agent_id: "agent-1" })).toBe("agent-1");
    expect(toolSummary("subagent_delete", { agent_id: "agent-1" })).toBe("agent-1");
  });

  it("has nothing to say about a tool it does not know, or arguments it cannot read", () => {
    expect(toolSummary("web_fetch", { url: "https://example.com" })).toBeUndefined();
    expect(toolSummary("read", {})).toBeUndefined();
    expect(toolSummary("read", { path: 3 })).toBeUndefined();
    expect(toolSummary("ls", {})).toBeUndefined();
  });
});
