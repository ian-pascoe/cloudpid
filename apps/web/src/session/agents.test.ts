// @effect-diagnostics preferEffectArray:off -- test code over native arrays.
import type { GraphAgent, TaskGraphSummary } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import {
  agentLabel,
  agentOfConversation,
  agentsBelow,
  childrenOf,
  canStopAllBelow,
  depthOf,
  sameWorkspace,
  subtreeGraph,
  workingBelow,
} from "./agents.ts";

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

  it("lists the agents below an agent, however deep, in the graph's order, or every one below the root", () => {
    const deep: TaskGraphSummary = {
      ...graph,
      agents: [...graph.agents, agent("agent-1.a.x", "agent-1.a", 5, "idle")],
    };

    expect(agentsBelow(deep, "agent-1").map((each) => each.id)).toEqual([
      "agent-1.a",
      "agent-1.a.x",
    ]);
    expect(agentsBelow(deep, "agent-2")).toEqual([]);
    expect(agentsBelow(deep, "root")).toHaveLength(4);
    expect(agentsBelow(null, "agent-1")).toEqual([]);
  });

  it("lists the agents an agent started itself, not those they started", () => {
    const deep: TaskGraphSummary = {
      ...graph,
      agents: [...graph.agents, agent("agent-1.a.x", "agent-1.a", 5, "idle")],
    };

    expect(childrenOf(deep, "agent-1").map((each) => each.id)).toEqual(["agent-1.a"]);
    expect(childrenOf(deep, "agent-1.a").map((each) => each.id)).toEqual(["agent-1.a.x"]);
    expect(childrenOf(deep, "agent-2")).toEqual([]);
    expect(childrenOf(null, "agent-1")).toEqual([]);
  });

  it("cuts the graph to a subagent's subtree, with the background work of it and below it", () => {
    const task = (id: number, agentId: string) => ({
      id,
      kind: "pi.compaction",
      agent: agentId,
      // SAFETY: test ID; the brand is for the type system only.
      conversationId: 2 as GraphAgent["conversationId"],
      state: "running" as const,
      aborting: false,
    });

    const busy: TaskGraphSummary = {
      ...graph,
      background: [task(1, "agent-1"), task(2, "agent-1.a"), task(3, "agent-2"), task(4, "root")],
    };

    const subtree = subtreeGraph(busy, "agent-1");

    expect(subtree?.agents.map((each) => each.id)).toEqual(["agent-1.a"]);
    expect(subtree?.background.map((each) => each.id)).toEqual([1, 2]);
    expect(subtreeGraph(busy, "root")).toBe(busy);
    expect(subtreeGraph(null, "agent-1")).toBeNull();
  });

  it("counts an agent's depth from the root, or from one of its ancestors", () => {
    const deep = agent("agent-1.a.x", "agent-1.a", 5, "idle");
    const withDeep: TaskGraphSummary = { ...graph, agents: [...graph.agents, deep] };

    expect(depthOf(withDeep, deep)).toBe(2);
    expect(depthOf(withDeep, deep, "agent-1")).toBe(1);
    expect(depthOf(withDeep, deep, "agent-1.a")).toBe(0);
  });

  it("tells whether two conversations work in the same Workspace, by their Subagent Workspace's branch", () => {
    const placed: TaskGraphSummary = {
      agents: [
        { ...agent("agent-1", "root", 2, "idle"), branch: "cloudpid/agent-1" },
        { ...agent("agent-1.a", "agent-1", 3, "idle"), branch: "cloudpid/agent-1" },
        agent("agent-2", "root", 4, "idle"),
      ],
      background: [],
    };

    // The root, and a subagent without a Subagent Workspace, work in the Session's.
    expect(sameWorkspace(placed, undefined, 4)).toBe(true);
    expect(sameWorkspace(placed, undefined, 2)).toBe(false);
    // A subagent that shares its parent's Subagent Workspace.
    expect(sameWorkspace(placed, 2, 3)).toBe(true);
    expect(sameWorkspace(placed, 3, 4)).toBe(false);
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
