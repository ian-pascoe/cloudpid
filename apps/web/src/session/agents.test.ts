// @effect-diagnostics preferEffectArray:off -- test code over native arrays.
import type { GraphAgent, TaskGraphSummary } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { agentOfConversation, workingBelow } from "./agents.ts";

const agent = (id: string, parent: string, conversationId: number, status: GraphAgent["status"]) =>
  ({
    id,
    parent,
    // SAFETY: test IDs; the brand is for the type system only.
    conversationId: conversationId as GraphAgent["conversationId"],
    role: null,
    model: "anthropic/claude-haiku-5",
    status,
  }) satisfies GraphAgent;

const graph: TaskGraphSummary = {
  agents: [
    agent("agent-1", "root", 2, "idle"),
    agent("agent-1.a", "agent-1", 3, "working"),
    agent("agent-2", "root", 4, "working"),
  ],
  background: [],
};

describe("the agents of a task graph", () => {
  it("finds the agent a conversation belongs to", () => {
    expect(agentOfConversation(graph, 3)?.id).toBe("agent-1.a");
    expect(agentOfConversation(graph, 99)).toBeUndefined();
    expect(agentOfConversation(null, 3)).toBeUndefined();
  });

  it("counts the agents working below an agent, however deep, or below the root", () => {
    expect(workingBelow(graph, "agent-1").map((each) => each.id)).toEqual(["agent-1.a"]);
    expect(workingBelow(graph, "agent-1.a")).toEqual([]);
    expect(workingBelow(graph, "root").map((each) => each.id)).toEqual(["agent-1.a", "agent-2"]);
    expect(workingBelow(null, "root")).toEqual([]);
  });
});
