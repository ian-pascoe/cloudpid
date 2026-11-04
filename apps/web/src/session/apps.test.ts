// @effect-diagnostics preferEffectArray:off -- ids read from a native list.
// docs/architecture/mcp-apps.md → Socket messages. The Session's App calls, kept by conversation, read as one list.
import type { McpAppEntry } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { appEntries, appEntryOf } from "./apps.ts";

const entry = (callId: string): McpAppEntry => ({
  callId,
  server: "docs",
  tool: "page",
  state: "kept",
  at: 1,
});

const apps = { "1": [entry("a"), entry("b")], "2": [entry("c")] };

describe("the Session's App calls", () => {
  it("are every conversation's, in one list", () => {
    expect(appEntries(apps).map((each) => each.callId)).toEqual(["a", "b", "c"]);
    expect(appEntries({})).toEqual([]);
  });

  it("are found by call, whichever conversation made it", () => {
    expect(appEntryOf(apps, "c")?.callId).toBe("c");
    expect(appEntryOf(apps, "none")).toBeUndefined();
  });
});
