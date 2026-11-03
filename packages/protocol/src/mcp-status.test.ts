// @effect-diagnostics schemaSync:off preferTypedSchemaDecoder:off -- the answers of a later build, decoded as they would cross the edge.
/* oxlint-disable anti-slop-effect/no-manual-tagged-construction -- answers of a later build, as they cross the edge */
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  mcpStateIsProblem,
  McpReconnectView,
  McpServerLogView,
  McpServersView,
  readMcpServerState,
} from "./mcp-status.ts";

describe("readMcpServerState", () => {
  it("reads a state it does not know as unknown, which is a problem", () => {
    expect(readMcpServerState("connected")).toBe("connected");
    expect(readMcpServerState("hibernating")).toBe("unknown");
    expect(mcpStateIsProblem("hibernating")).toBe(true);
    expect(mcpStateIsProblem("failed")).toBe(true);
    expect(mcpStateIsProblem("connected")).toBe(false);
    expect(mcpStateIsProblem("disabled")).toBe(false);
  });
});

describe("the MCP status answers", () => {
  it("read an answer of a tag they do not know as Unavailable, never as a decode error", () => {
    const later = { _tag: "Throttled", retryAfter: 5 };

    for (const view of [McpServersView, McpServerLogView, McpReconnectView]) {
      const decoded = Schema.decodeUnknownSync(view)(later);

      expect(decoded).toMatchObject({ _tag: "Unavailable" });
    }
  });

  it("keep a known answer, ignoring fields they do not know", () => {
    const decoded = Schema.decodeUnknownSync(McpServerLogView)({
      _tag: "Log",
      entries: [{ at: 1, level: "notice-ish", data: "x", extra: true }],
      later: 1,
    });

    expect(decoded).toEqual({ _tag: "Log", entries: [{ at: 1, level: "notice-ish", data: "x" }] });
  });
});
