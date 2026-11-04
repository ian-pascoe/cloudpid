// The status chip of an MCP server change's card (`./mcp-status.ts`).
import { describe, expect, it } from "vitest";
import { mcpStatusLabel, mcpStatusOf, shownMcpStatus } from "./mcp-status.ts";

const status = (state: string, tools = 0, error: string | null = null) => ({
  server: "linear",
  status: state,
  tools,
  error,
});

describe("mcpStatusOf", () => {
  it("reads the status a call's details record, and none from details without one", () => {
    expect(mcpStatusOf({ mcp: status("connected", 3), scope: "*" })).toEqual(
      status("connected", 3),
    );
    expect(mcpStatusOf({ scope: "*" })).toBeUndefined();
    expect(mcpStatusOf(undefined)).toBeUndefined();
    expect(mcpStatusOf({ mcp: { server: "x" } })).toBeUndefined();
  });

  it("is what a card's artifact holds", () => {
    expect(shownMcpStatus({ mcp: status("connecting") })).toEqual(status("connecting"));
    expect(shownMcpStatus({})).toBeUndefined();
  });
});

describe("mcpStatusLabel", () => {
  it("words each state", () => {
    expect(mcpStatusLabel(status("connected", 3))).toBe("Connected · 3 tools");
    expect(mcpStatusLabel(status("connected", 1))).toBe("Connected · 1 tool");
    expect(mcpStatusLabel(status("needs_sign_in"))).toBe("Needs sign-in");
    expect(mcpStatusLabel(status("connecting"))).toBe("Connecting");
    expect(mcpStatusLabel(status("not_checked"))).toBe("Not checked");
    expect(mcpStatusLabel(status("failed", 0, "spawn ENOENT"))).toBe("Failed: spawn ENOENT");
  });

  it("cuts a long error and shows a state it does not know as it is", () => {
    expect(mcpStatusLabel(status("failed", 0, "e".repeat(200))).length).toBeLessThan(100);
    expect(mcpStatusLabel(status("from_a_later_build"))).toBe("from_a_later_build");
  });
});
