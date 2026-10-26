import type { ConversationId, OwnerTabDriver } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import { drivingNote } from "./driving.ts";

const driver = (ownerTabId: string, conversationId: number): OwnerTabDriver => ({
  ownerTabId,
  // SAFETY: a test's conversations are plain numbers, as pi-durable's are.
  conversationId: conversationId as ConversationId,
});

/** The root agent's conversation is 1; conversation 4 is subagent `agent-1` (reviewer). */
const agentOf = (conversationId: number) =>
  conversationId === 4 ? "agent-1 (reviewer)" : undefined;

describe("what the Browser Pane says while the agent drives an Owner tab", () => {
  it("names the root agent as the agent, and a subagent by its ID and role", () => {
    expect(drivingNote([driver("a", 1)], "a", agentOf)).toBe("The agent is driving this tab");
    expect(drivingNote([driver("a", 4)], "a", agentOf)).toBe(
      "agent-1 (reviewer) is driving this tab",
    );
    expect(drivingNote([driver("a", 1), driver("a", 4)], "a", agentOf)).toBe(
      "The agent and agent-1 (reviewer) are driving this tab",
    );
  });

  it("says nothing of a call in another Owner tab, or before the Pane knows which tab it shows", () => {
    expect(drivingNote([driver("b", 1)], "a", agentOf)).toBeNull();
    expect(drivingNote([], "a", agentOf)).toBeNull();
    expect(drivingNote([driver("a", 1)], null, agentOf)).toBeNull();
  });
});
