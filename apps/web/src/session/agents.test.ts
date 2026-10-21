// @effect-diagnostics preferEffectArray:off -- test code over native arrays.
import type { GraphAgent, TaskGraphSummary } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { agentLabel, agentOfConversation, canStopAllBelow, workingBelow } from "./agents.ts";

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

  it("offers Stop all for work below an agent, or for idle agents while it runs", () => {
    const idle: TaskGraphSummary = {
      agents: [agent("agent-1", "root", 2, "idle")],
      background: [],
    };

    expect(canStopAllBelow(null, "root", true)).toBe(false);
    expect(canStopAllBelow(graph, "agent-1", false)).toBe(true);
    expect(canStopAllBelow(graph, "agent-1.a", false)).toBe(false);
    // A report from the idle agent can be held for the run that is going.
    expect(canStopAllBelow(idle, "root", true)).toBe(true);
    expect(canStopAllBelow(idle, "root", false)).toBe(false);
    expect(canStopAllBelow(idle, "agent-1", true)).toBe(false);

    const withTask: TaskGraphSummary = {
      ...idle,
      background: [
        {
          id: 1,
          kind: "pi.compaction",
          agent: "agent-1",
          // SAFETY: test ID; the brand is for the type system only.
          conversationId: 2 as GraphAgent["conversationId"],
          state: "running",
          aborting: false,
        },
      ],
    };

    expect(canStopAllBelow(withTask, "root", false)).toBe(true);
    expect(canStopAllBelow(withTask, "agent-1", false)).toBe(true);
  });

  it("names the agent of a conversation, and no one for the root's or an unknown one", () => {
    const named: TaskGraphSummary = {
      agents: [{ ...agent("agent-1", "root", 2, "idle"), role: "researcher" }],
      background: [],
    };

    expect(agentLabel(named, 2)).toBe("agent-1 (researcher)");
    expect(agentLabel(graph, 3)).toBe("agent-1.a");
    expect(agentLabel(graph, 1)).toBeUndefined();
    expect(agentLabel(null, 2)).toBeUndefined();
  });
});
