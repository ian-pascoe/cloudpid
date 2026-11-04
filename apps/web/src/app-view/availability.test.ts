// docs/architecture/mcp-apps.md → Lifecycle (Server states). What a card with an App call shows.
import type { McpAppEntry, McpAppTool } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { appAvailability } from "./availability.ts";

const tool: McpAppTool = {
  name: "mcp__docs__page",
  server: "docs",
  tool: "page",
  uri: "ui://docs/page",
  visibility: ["model", "app"],
};

const entry = (state: string): McpAppEntry => ({
  callId: "c1",
  server: "docs",
  tool: "page",
  state,
  at: 1,
});

const facts = (over: Partial<Parameters<typeof appAvailability>[0]> = {}) => ({
  toolName: "mcp__docs__page",
  tools: [tool],
  entry: entry("kept"),
  serverState: "connected" as const,
  ...over,
});

describe("appAvailability", () => {
  it("mounts a kept call of a connected server, with no badge", () => {
    expect(appAvailability(facts())).toEqual({ kind: "mount", badge: null });
  });

  it("is nothing for an ordinary tool", () => {
    expect(appAvailability(facts({ toolName: "mcp__docs__other", entry: undefined }))).toEqual({
      kind: "none",
    });
    expect(appAvailability(facts({ entry: undefined, tools: [] }))).toEqual({ kind: "none" });
  });

  it("mounts, badged, for a server that is offline or wants a sign-in", () => {
    for (const state of ["unavailable", "failed", "unknown"] as const) {
      expect(appAvailability(facts({ serverState: state }))).toEqual({
        kind: "mount",
        badge: "offline",
      });
    }

    for (const state of ["sign_in", "rejected"] as const) {
      expect(appAvailability(facts({ serverState: state }))).toEqual({
        kind: "mount",
        badge: "sign-in",
      });
    }
  });

  it("is unavailable once the server is switched off or its tool is no App's any more", () => {
    expect(appAvailability(facts({ serverState: "disabled" }))).toEqual({ kind: "unavailable" });
    expect(appAvailability(facts({ tools: [] }))).toEqual({ kind: "unavailable" });
  });

  it("is the summary only for an evicted record, or a state it does not know", () => {
    expect(appAvailability(facts({ entry: entry("evicted") }))).toEqual({ kind: "evicted" });
    expect(appAvailability(facts({ entry: entry("archived-later") }))).toEqual({ kind: "evicted" });
  });

  it("waits for what it does not know yet: it mounts when the inventory or the server's state is not read", () => {
    expect(appAvailability(facts({ tools: null }))).toEqual({ kind: "mount", badge: null });
    expect(appAvailability(facts({ serverState: undefined }))).toEqual({
      kind: "mount",
      badge: null,
    });
  });
});
