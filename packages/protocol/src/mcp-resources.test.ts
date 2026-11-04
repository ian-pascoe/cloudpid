// A resource preview's messages (`docs/architecture/mcp-in-a-session.md` → Resource links and embedded resources).
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  isMcpSpillPath,
  MAX_MCP_RESOURCE_KEY,
  MAX_MCP_RESOURCE_PREVIEW_BYTES,
  McpResourcePreviewAnswer,
  McpResourceReason,
  resourceUnavailable,
} from "./mcp-resources.ts";
import { ClientMessage, Hello } from "./session.ts";

describe("a resource preview", () => {
  const decodeClient = Schema.decodeUnknownOption(ClientMessage);
  const decodeAnswer = Schema.decodeUnknownOption(McpResourcePreviewAnswer);

  it("is a client message with a server and a URI, and a conversation when the card is not the root's", () => {
    const read = { type: "mcp_resource_read", id: "1", server: "docs", uri: "file:///a.md" };

    expect(Option.isSome(decodeClient(read))).toBe(true);
    expect(Option.isSome(decodeClient({ ...read, conversationId: 3 }))).toBe(true);
    expect(Option.isNone(decodeClient({ ...read, uri: undefined }))).toBe(true);
    expect(
      Option.isNone(decodeClient({ ...read, uri: "u".repeat(MAX_MCP_RESOURCE_KEY + 1) })),
    ).toBe(true);
    // The socket decodes with `onExcessProperty: "error"` elsewhere; a field this build does not know is no message.
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(ClientMessage, { onExcessProperty: "error" })({
          ...read,
          extra: 1,
        }),
      ),
    ).toBe(true);
  });

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

  it("carries as much as an MCP result may on every path", () => {
    expect(MAX_MCP_RESOURCE_PREVIEW_BYTES).toBe(16 * 1024 * 1024);
    // The host's reasons are told apart: a host that cannot promise it, and a Session that is older than previews.
    expect(Schema.is(McpResourceReason)("host_unsupported")).toBe(true);
    expect(Schema.is(McpResourceReason)("session_unsupported")).toBe(true);
    expect(Schema.is(McpResourceReason)("unsupported")).toBe(false);
  });

  it("is said in hello, which an older Session leaves out", () => {
    const decodeHello = Schema.decodeUnknownOption(Hello);

    expect(Option.isSome(decodeHello({ type: "hello", root: 1, resourcePreviews: true }))).toBe(
      true,
    );
    expect(Option.isSome(decodeHello({ type: "hello", root: 1 }))).toBe(true);
  });

  it("answers the contents or why there are none, and reads a status it does not know as the fallback", () => {
    expect(
      Option.isSome(decodeAnswer({ status: "contents", contents: [{ uri: "u", text: "t" }] })),
    ).toBe(true);
    expect(decodeAnswer(resourceUnavailable("stopped", "m"))).toEqual(
      Option.some({ status: "unavailable", reason: "stopped", message: "m" }),
    );
    expect(Option.isSome(decodeAnswer({ status: "from-the-future", message: "later" }))).toBe(true);
  });
});
