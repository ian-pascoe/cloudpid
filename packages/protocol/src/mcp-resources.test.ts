// A resource preview's messages (`docs/architecture/mcp-in-a-session.md` → Resource links and embedded resources).
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { isMcpSpillPath } from "./mcp-resources.ts";
import { ClientMessage, Hello } from "./session.ts";

describe("a resource preview", () => {
  const decodeClient = Schema.decodeUnknownOption(ClientMessage);

  it("may name the Result Spill the card's chip holds, which is read only if it is one", () => {
    const read = { type: "mcp_resource_read", id: "1", server: "docs", uri: "u" };
    const spill = "/workspace/.cloudpid/tmp/tmp-0a1b2c3d-4e5f/mcp-6a7b8c9d-0e1f.png";

    expect(Option.isSome(decodeClient({ ...read, path: spill }))).toBe(true);
    expect(isMcpSpillPath(spill)).toBe(true);
    expect(isMcpSpillPath("/workspace/.cloudpid/tmp/tmp-a/mcp-b.txt")).toBe(true);

    for (const other of [
      "/workspace/.cloudpid/tmp/tmp-a/../../../etc/passwd",
      "/workspace/.cloudpid/tmp/tmp-a/mcp-b/../../c.txt",
      "/workspace/.cloudpid/tmp/mcp-b.txt",
      "/workspace/.cloudpid/tmp/tmp-a/b.txt",
      "/workspace/repo/mcp-b.txt",
      "/workspace/.cloudpid/tmp/tmp-a/mcp-b",
      "../workspace/.cloudpid/tmp/tmp-a/mcp-b.txt",
      "/workspace/.cloudpid/tmp/tmp-a/mcp-b.txt\n/etc/passwd",
      "",
    ]) {
      expect(isMcpSpillPath(other)).toBe(false);
    }
  });

  it("is said in hello, which an older Session leaves out", () => {
    const decodeHello = Schema.decodeUnknownOption(Hello);

    expect(Option.isSome(decodeHello({ type: "hello", root: 1, resourcePreviews: true }))).toBe(
      true,
    );
    expect(Option.isSome(decodeHello({ type: "hello", root: 1 }))).toBe(true);
  });
});
