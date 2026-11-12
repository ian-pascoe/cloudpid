// docs/architecture/mcp-apps.md → App Views in the transcript (Remounting).
// @effect-diagnostics preferEffectArray:off -- messages and entries in native lists.
import type { McpAppEntry, TranscriptMessage } from "@cloudpid/protocol";
import { describe, expect, it } from "vite-plus/test";
import { callsDroppedBy } from "./branch.ts";

const assistant = (id: string, ...calls: string[]): TranscriptMessage => ({
  id,
  role: "assistant",
  timestamp: 0,
  parts: calls.map((call) => ({ type: "tool-call", id: call, name: "x", arguments: {} })),
});

const nested = (callId: string, parentCall: string): McpAppEntry => ({
  callId,
  parentCall,
  server: "docs",
  tool: "page",
  state: "kept",
  at: 1,
});

describe("the calls a move to another branch drops", () => {
  const messages = [assistant("2", "a"), assistant("4", "b"), assistant("6", "c")];

  it("is the calls of the messages the branch does not hold, and none the branch keeps", () => {
    expect([...callsDroppedBy(messages, [], new Set([1, 2, 3, 4]))]).toEqual(["c"]);
    expect([...callsDroppedBy(messages, [], new Set([1, 2, 3, 4, 5, 6]))]).toEqual([]);
    expect([...callsDroppedBy(messages, [], new Set())].sort()).toEqual(["a", "b", "c"]);
  });

  it("drops a nested call with the script's call that made it", () => {
    const apps = [nested("n1", "c"), nested("n2", "a")];

    expect([...callsDroppedBy(messages, apps, new Set([1, 2]))].sort()).toEqual(["b", "c", "n1"]);
  });

  it("leaves alone a message that has no entry, such as the one being streamed", () => {
    expect([...callsDroppedBy([assistant("live", "z")], [], new Set())]).toEqual([]);
  });
});
