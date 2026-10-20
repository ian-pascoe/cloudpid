// What the task graph says about the Session's subagents, for the cards, the panel, and the stop buttons.

// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- browser code in a React app with no Effect runtime.

import type { GraphAgent, TaskGraphSummary } from "@cloudpid/protocol";

/** The agent that runs conversation `conversationId`, if the summary lists it. */
export const agentOfConversation = (
  graph: TaskGraphSummary | null,
  conversationId: number,
): GraphAgent | undefined => graph?.agents.find((agent) => agent.conversationId === conversationId);

const isBelowAgent = (graph: TaskGraphSummary, agentId: string, parentOf: string): boolean => {
  const parents = new Map(graph.agents.map((agent) => [agent.id, agent.parent]));

  for (let parent = parentOf; ;) {
    if (parent === agentId) return true;

    const next = parents.get(parent);

    if (next === undefined) return false;

    parent = next;
  }
};

/** The agents working below `agentId` (`root` for all), at any depth. */
export const workingBelow = (graph: TaskGraphSummary | null, agentId: string): GraphAgent[] =>
  graph === null
    ? []
    : graph.agents.filter(
        (agent) => agent.status === "working" && isBelowAgent(graph, agentId, agent.parent),
      );

/**
 * Whether stopping `agentId` with its subagents would stop anything beyond what a plain Stop does: an agent working
 * below it, background work of it or below it, or, while it is running itself, any agent below it, since one that has
 * answered (and is idle) can have a report held for the run that is still going.
 */
export const canStopAllBelow = (
  graph: TaskGraphSummary | null,
  agentId: string,
  running: boolean,
): boolean => {
  if (graph === null) return false;

  const below = graph.agents.filter((agent) => isBelowAgent(graph, agentId, agent.parent));

  return (
    below.some((agent) => agent.status === "working") ||
    (running && below.length > 0) ||
    graph.background.some(
      (task) => task.agent === agentId || isBelowAgent(graph, agentId, task.agent),
    )
  );
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
