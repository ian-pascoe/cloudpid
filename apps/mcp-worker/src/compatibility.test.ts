import { describe, expect, it } from "vitest";
import { MCP_WORKER_COMPATIBILITY } from "./compatibility.ts";

describe("McpWorker's compatibility", () => {
  it("sends the engine's fetch through the front door, as a client's, and keeps nodejs_compat off", () => {
    expect(MCP_WORKER_COMPATIBILITY.flags).toContain("global_fetch_strictly_public");
    expect(MCP_WORKER_COMPATIBILITY.flags).not.toContain("nodejs_compat");
  });
});
