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
    expect(toolSummary("container_restart", { reason: "echo hung\nfor minutes" })).toBe(
      "echo hung",
    );
    expect(toolSummary("container_restart", { reason: "echo hung", fresh: true })).toBe(
      "echo hung (fresh)",
    );
    expect(
      toolSummary("container_resize", { size: "cpu-2", reason: "tsc ran out\nof memory" }),
    ).toBe("tsc ran out (to cpu-2)");
    // A call made before the rename, in a transcript.
    expect(toolSummary("restart_container", { reason: "echo hung" })).toBe("echo hung");
    expect(toolSummary("environment_get", { id: "0000abcd" })).toBe("0000abcd");
    expect(toolSummary("environment_get", {})).toBeUndefined();
    expect(toolSummary("environment_variable_set", { name: "API_URL", value: "x" })).toBe(
      "API_URL",
    );
    expect(toolSummary("environment_variable_unset", { id: "0000abcd", name: "MODE" })).toBe(
      "MODE in 0000abcd",
    );
    expect(
      toolSummary("environment_secret_build", { id: "*", name: "NPM_TOKEN", build: true }),
    ).toBe("NPM_TOKEN for every environment");
    expect(
      toolSummary("environment_variable_set", { id: "*", name: "CLOUDFLARE_EMAIL", value: "x" }),
    ).toBe("CLOUDFLARE_EMAIL for every environment");
    expect(
      toolSummary("environment_container_resize", { size: "cpu-2", reason: "needs 6 GiB" }),
    ).toBe("needs 6 GiB (to cpu-2)");
    expect(
      toolSummary("environment_idle_time_set", { id: "0000abcd", minutes: 10, reason: "warm" }),
    ).toBe("0000abcd: warm (10 min)");
    expect(
      toolSummary("environment_setup_script_set", { script: "echo", reason: "jq\nmore" }),
    ).toBe("jq");
    expect(toolSummary("environment_ignore_set", { patterns: ["/a"], reason: "big" })).toBe("big");
    expect(toolSummary("environment_create", { name: "Billing", reason: "r" })).toBe("Billing");
    expect(toolSummary("environment_rename", { id: "0000abcd", name: "Main" })).toBe(
      "Main in 0000abcd",
    );
    expect(toolSummary("environment_repo_add", { url: "o/api" })).toBe("o/api");
    expect(toolSummary("environment_repo_remove", { name: "api", id: "0000abcd" })).toBe(
      "api in 0000abcd",
    );
    expect(toolSummary("environment_rebuild", {})).toBeUndefined();
    expect(toolSummary("environment_rebuild", { id: "0000abcd" })).toBe("0000abcd");
    expect(
      toolSummary("environment_rebuild", {
        reason: "r",
        proposed: { setup_script: "x", toolchains: "" },
      }),
    ).toBe("Test Build of setup_script, toolchains");
    expect(toolSummary("environment_rebuild", { id: "0000abcd", reason: "r", proposed: {} })).toBe(
      "0000abcd: Test Build",
    );
    expect(
      toolSummary("settings_model_set", {
        model: "anthropic/claude-sonnet-5-5",
        thinking_level: "low",
        reason: "r",
      }),
    ).toBe("anthropic/claude-sonnet-5-5 at low");
    expect(toolSummary("settings_model_set", { thinking_level: "low" })).toBe("low");
    expect(toolSummary("settings_model_set", { reason: "r" })).toBeUndefined();
    expect(
      toolSummary("settings_role_set", { role: "small", model: "anthropic/claude-haiku-5-5" }),
    ).toBe("small: anthropic/claude-haiku-5-5");
    expect(toolSummary("settings_tool_offer", { pattern: "web_fetch", reason: "r" })).toBe(
      "web_fetch",
    );
    expect(toolSummary("settings_tool_defer", { pattern: "grep" })).toBe("grep");
    expect(
      toolSummary("settings_extension_set", { extension: "subagents", key: "readToolset" }),
    ).toBe("subagents.readToolset");
    expect(toolSummary("settings_compaction_set", { reason: "more room\nplease" })).toBe(
      "more room",
    );
    // The tools that wait for the owner's Approval.
    expect(toolSummary("settings_spend_limit_set", { per_session: 25, reason: "r" })).toBe(
      "$25 per Session",
    );
    expect(toolSummary("settings_spend_limit_set", { per_session: null, reason: "r" })).toBe(
      "no limit",
    );
    expect(toolSummary("settings_subagent_depth_set", { depth: 3, reason: "r" })).toBe("depth 3");
    expect(toolSummary("settings_subagent_workspaces_set", { limit: 5, reason: "r" })).toBe(
      "limit 5",
    );
    expect(
      toolSummary("environment_container_size_limit_set", { id: "0000abcd", size: "cpu-3" }),
    ).toBe("0000abcd: limit cpu-3");
    expect(toolSummary("environment_delete", { id: "0000abcd", reason: "r" })).toBe("0000abcd");
    expect(toolSummary("environment_secret_delete", { id: "*", name: "NPM_TOKEN" })).toBe(
      "NPM_TOKEN for every environment",
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

  it("shows what a todo call does: its action, the Task it names, or how many it takes", () => {
    expect(toolSummary("todo", { action: "list" })).toBe("list");
    expect(toolSummary("todo", { action: "add", title: "Write it\nSoon" })).toBe("add: Write it");
    expect(toolSummary("todo", { action: "update", id: 2, status: "completed" })).toBe("update #2");
    expect(toolSummary("todo", { action: "update", id: 2, title: "New" })).toBe("update #2: New");
    expect(toolSummary("todo", { action: "add", tasks: [{ title: "A" }, { title: "B" }] })).toBe(
      "add 2 Tasks",
    );
    expect(toolSummary("todo", { action: "update", updates: [{ id: 1 }] })).toBe("update 1 Task");
    expect(toolSummary("todo", {})).toBeUndefined();
  });
});
