// What the task graph says about the Session's subagents, for the cards, the panel, and the stop buttons.

// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- browser code in a React app with no Effect runtime.

import type { GraphAgent, TaskGraphSummary } from "@cloudpid/protocol";

/** The agent that runs conversation `conversationId`, if the summary lists it. */
export const agentOfConversation = (
  graph: TaskGraphSummary | null,
  conversationId: number,
): GraphAgent | undefined => graph?.agents.find((agent) => agent.conversationId === conversationId);

/** The agents working below `agentId` (`root` for all), at any depth: what stopping it with its subagents would stop. */
export const workingBelow = (graph: TaskGraphSummary | null, agentId: string): GraphAgent[] => {
  if (graph === null) return [];

  const parents = new Map(graph.agents.map((agent) => [agent.id, agent.parent]));

  const isBelow = (agent: GraphAgent): boolean => {
    for (let parent = agent.parent; ;) {
      if (parent === agentId) return true;

      const next = parents.get(parent);

      if (next === undefined) return false;

      parent = next;
    }
  };

  return graph.agents.filter((agent) => agent.status === "working" && isBelow(agent));
};

/** How deep `agent` is: 0 for a child of the root. */
export const depthOf = (graph: TaskGraphSummary, agent: GraphAgent): number => {
  const parents = new Map(graph.agents.map((each) => [each.id, each.parent]));
  let depth = 0;

  for (let parent = agent.parent; parent !== "root"; depth += 1) {
    const next = parents.get(parent);

    if (next === undefined) break;

    parent = next;
  }

  return depth;
};
