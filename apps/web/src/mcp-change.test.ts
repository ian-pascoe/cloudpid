import * as Arr from "effect/Array";
import { describe, expect, it } from "vitest";
import type { AgentChange } from "@cloudpid/protocol";
import { changeDiff } from "./line-diff.ts";
import { madeChanges } from "./chat/agent-change.ts";
import { changeFieldText, changeTitleText, fieldValueText } from "./environments.ts";
import {
  inheritedLabel,
  inheritedLines,
  inheritedNote,
  latestAgentChange,
  mcpEntryTexts,
} from "./mcp-change.ts";

describe("how an MCP change reads", () => {
  it("says the server and the key", () => {
    expect(changeFieldText("mcp.servers.linear")).toBe("MCP server linear");
    expect(changeFieldText("mcp.servers.linear.enabled")).toBe("MCP server linear · on/off");
    expect(changeFieldText("mcp.servers.linear.exposure")).toBe("MCP server linear · exposure");
    expect(changeFieldText("mcp.servers.linear.toolExposure")).toBe(
      "MCP server linear · tool exposure",
    );
  });

  it("shows a key's values in words, and null as not set", () => {
    expect(fieldValueText("mcp.servers.linear.enabled", false)).toBe("off");
    expect(fieldValueText("mcp.servers.linear.enabled", true)).toBe("on");
    expect(fieldValueText("mcp.servers.linear.enabled", null)).toBe("not set");
    expect(fieldValueText("mcp.servers.linear.exposure", "hidden")).toBe("hidden");
    expect(
      fieldValueText("mcp.servers.linear.toolExposure", {
        "delete_*": "hidden",
        get_issue: "direct",
      }),
    ).toBe("delete_* → hidden\nget_issue → direct");
    expect(fieldValueText("mcp.servers.linear.toolExposure", {})).toBe("no keys");
  });

  it("shows a whole entry as its JSON in the order written, as a line diff", () => {
    const rows = changeDiff(
      "mcp.servers.linear",
      { url: "https://mcp.linear.app", enabled: true },
      { url: "https://mcp.linear.app", enabled: false },
    );

    expect(Arr.filter(rows ?? [], (row) => row.kind === "removed")).toEqual([
      { kind: "removed", text: '  "enabled": true' },
    ]);
    expect(Arr.filter(rows ?? [], (row) => row.kind === "added")).toEqual([
      { kind: "added", text: '  "enabled": false' },
    ]);
    expect(changeDiff("mcp.servers.linear.enabled", true, false)).toBeUndefined();
  });

  it("gives an entry that is not there as empty text", () => {
    expect(mcpEntryTexts("mcp.servers.linear", null, { url: "u" })).toEqual({
      before: "",
      after: '{\n  "url": "u"\n}',
    });
    expect(mcpEntryTexts("mcp.servers.linear.enabled", true, false)).toBeNull();
  });
});

describe("inheritedNote", () => {
  it("is the entry's words for an entry and the plain note for a key", () => {
    expect(inheritedNote("mcp.servers.linear", true)).toBe("Global's entry (inherited)");
    expect(inheritedNote("mcp.servers.linear.enabled", true)).toBe(
      "Inherited from the server's own entry",
    );
    expect(inheritedNote("roles.small", true)).toBe("Inherited from Global");
  });

  it("labels a value and lists both sides' notes", () => {
    expect(inheritedLabel("Before", "roles.small", true)).toBe("Before · Inherited from Global");
    expect(inheritedLabel("After", "roles.small", false)).toBe("After");
    expect(
      inheritedLines({
        field: "mcp.servers.linear",
        beforeInherited: true,
        afterInherited: false,
      }),
    ).toEqual(["Before: Global's entry (inherited)"]);
  });

  it("is null for a value that was not inherited", () => {
    expect(inheritedNote("mcp.servers.linear", false)).toBeNull();
    expect(inheritedNote("mcp.servers.linear", undefined)).toBeNull();
  });
});

describe("latestAgentChange", () => {
  const change = (id: number, field: string, more: Partial<AgentChange> = {}): AgentChange => ({
    id,
    scope: "*",
    at: id,
    actor: "agent",
    session: "s",
    conversation: 1,
    tool: "settings_mcp_disable",
    reason: "r",
    field,
    before: true,
    after: false,
    reverts: null,
    revertedBy: null,
    ...more,
  });

  it("is the newest agent change to the server, of any of its keys", () => {
    const changes = [
      change(1, "mcp.servers.linear.enabled"),
      change(3, "mcp.servers.linear.exposure"),
      change(2, "mcp.servers.search.enabled"),
    ];

    expect(latestAgentChange(changes, "linear")?.id).toBe(3);
    expect(latestAgentChange(changes, "search")?.id).toBe(2);
    expect(latestAgentChange(changes, "files")).toBeNull();
  });

  it("leaves out a change that was reverted and the owner's own", () => {
    const changes = [
      change(1, "mcp.servers.linear.enabled"),
      change(2, "mcp.servers.linear.exposure", { revertedBy: 4 }),
      change(3, "mcp.servers.linear.enabled", { actor: "owner", session: null }),
    ];

    expect(latestAgentChange(changes, "linear")?.id).toBe(1);
  });
});

describe("what a card of the call shows", () => {
  it("keeps whether each value was inherited, and titles the change by server and place", () => {
    const made = madeChanges({
      scope: "env-1",
      agentChanges: [
        {
          id: 5,
          scope: "env-1",
          field: "mcp.servers.linear.enabled",
          before: true,
          after: false,
          environment: { id: "env-1", name: "Work" },
          beforeInherited: true,
          afterInherited: false,
        },
      ],
    });

    expect(made).toHaveLength(1);
    expect(made[0]?.beforeInherited).toBe(true);
    expect(made[0]?.afterInherited).toBe(false);
    expect(changeTitleText("mcp.servers.linear.enabled", "Work")).toBe(
      "MCP server linear · on/off in Work",
    );
  });
});
