// What the task graph says about the Session's subagents, for the cards, the panel, and the stop buttons.

// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- plain functions over native arrays, not combinators.

import type { GraphAgent, TaskGraphSummary } from "@cloudpid/protocol";

/** The root agent's ID: the `parent` of the Session's top subagents, and the agent a Session page shows. */
export const ROOT_AGENT = "root";

/** The agent that runs conversation `conversationId`, if the summary lists it. */
export const agentOfConversation = (
  graph: TaskGraphSummary | null,
  conversationId: number,
): GraphAgent | undefined => graph?.agents.find((agent) => agent.conversationId === conversationId);

/**
 * How to name the agent that conversation `conversationId` belongs to for the owner: its ID and role, or undefined when
 * it is the root agent's (which the summary does not list) or unknown.
 */
export const agentLabel = (
  graph: TaskGraphSummary | null,
  conversationId: number,
): string | undefined => {
  const agent = agentOfConversation(graph, conversationId);

  if (agent === undefined) return undefined;

  return agent.role === null ? agent.id : `${agent.id} (${agent.role})`;
};

const isBelowAgent = (graph: TaskGraphSummary, agentId: string, parentOf: string): boolean => {
  const parents = new Map(graph.agents.map((agent) => [agent.id, agent.parent]));

  for (let parent = parentOf; ;) {
    if (parent === agentId) return true;

    const next = parents.get(parent);

    if (next === undefined) return false;

    parent = next;
  }
};

/** The agents working below `agentId` (`ROOT_AGENT` for all), at any depth. */
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

/**
 * The agents below `agentId` (`ROOT_AGENT` for all), at any depth, in the graph's order (parents before their
 * children): a Subagent page's Subagents Pane lists its subtree.
 */
export const agentsBelow = (graph: TaskGraphSummary | null, agentId: string): GraphAgent[] =>
  graph === null
    ? []
    : agentId === ROOT_AGENT
      ? [...graph.agents]
      : graph.agents.filter((agent) => isBelowAgent(graph, agentId, agent.parent));

/** The agents `agentId` started itself, in the graph's order: a Subagent page's Session details list them. */
export const childrenOf = (graph: TaskGraphSummary | null, agentId: string): GraphAgent[] =>
  graph === null ? [] : graph.agents.filter((agent) => agent.parent === agentId);

/**
 * The part of the task graph a Subagent page shows: the agents below `agentId`, and the background work of it and of
 * them.
 */
export const subtreeGraph = (
  graph: TaskGraphSummary | null,
  agentId: string,
): TaskGraphSummary | null => {
  if (graph === null || agentId === ROOT_AGENT) return graph;

  const agents = agentsBelow(graph, agentId);
  const ids = new Set([agentId, ...agents.map((agent) => agent.id)]);

  return { agents, background: graph.background.filter((task) => ids.has(task.agent)) };
};

/**
 * The branch of the Workspace conversation `conversationId` works in: its Subagent Workspace's (its own, or its nearest
 * ancestor's), or undefined for the Session's Workspace, which the root conversation (`undefined`) works in, and so does
 * a conversation the graph does not list.
 */
const workspaceBranchOf = (
  graph: TaskGraphSummary | null,
  conversationId: number | undefined,
): string | undefined =>
  conversationId === undefined ? undefined : agentOfConversation(graph, conversationId)?.branch;

/**
 * Whether conversations `one` and `other` (undefined: the root's) work in the same Workspace, so the Changes one's page
 * shows hold what the other wrote: the task graph names each Subagent Workspace by its branch.
 */
export const sameWorkspace = (
  graph: TaskGraphSummary | null,
  one: number | undefined,
  other: number | undefined,
): boolean => workspaceBranchOf(graph, one) === workspaceBranchOf(graph, other);

/** How deep `agent` is below `from` (the root by default): 0 for a child of it. */
export const depthOf = (graph: TaskGraphSummary, agent: GraphAgent, from = ROOT_AGENT): number => {
  const parents = new Map(graph.agents.map((each) => [each.id, each.parent]));
  let depth = 0;

  for (let parent = agent.parent; parent !== from && parent !== ROOT_AGENT; depth += 1) {
    const next = parents.get(parent);

    if (next === undefined) break;

    parent = next;
  }

  return depth;
};
