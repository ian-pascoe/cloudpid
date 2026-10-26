// The Session's task graph as a client's panel shows it (`docs/spec.md` → Client and protocol): pi-durable's
// `TaskGraph` lists every live task with its internals, so it is boiled down to the Session's subagents and its live
// background work before it goes on a socket.
import {
  type AgentRecord,
  isSessionBranch,
  type SubagentsState,
  workspaceOf,
} from "@cloudpid/extensions/subagents";
import {
  type ConversationId,
  type GraphAgent,
  type GraphBackgroundTask,
  type TaskGraphSummary,
} from "@cloudpid/protocol";
import type {
  ConversationId as PiConversationId,
  TaskGraph,
  TaskGraphNode,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Order from "effect/Order";
import * as Record from "effect/Record";

/** How many background tasks one summary lists; the oldest come first. */
export const MAX_BACKGROUND_TASKS = 50;

/** The root conversation's name among the agents. */
const ROOT = "root";

/** Tasks that only carry the subagents' turns and waits: the agents list already shows them. */
const isSubagentBookkeeping = (kind: string): boolean => kind.startsWith("cloudpid.subagent-");

const byTaskId = Order.mapInput(Order.Number, (task: TaskGraphNode) => task.id);

const byAge = Order.mapInput(Order.Number, (agent: AgentRecord) => agent.createdAt);

/** The agents under `parent`, each followed by its own, children in the order they were started. */
const inTreeOrder = (agents: ReadonlyArray<AgentRecord>, parent: string): AgentRecord[] =>
  pipe(
    agents,
    Arr.filter((agent) => agent.parent === parent),
    Arr.sort(byAge),
    Arr.flatMap((agent): AgentRecord[] => [agent, ...inTreeOrder(agents, agent.id)]),
  );

/**
 * The subagents of `state` and the live background tasks of `graph`. A subagent is `working` while a live task that is
 * not background work runs in its conversation (a generation, a tool call, a wait), `idle` otherwise.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain function over two values.
export const summarizeTaskGraph = (graph: TaskGraph, state: SubagentsState): TaskGraphSummary => {
  const tasks = Arr.sort(Record.values(graph.tasks), byTaskId);

  const working = new Set(
    Arr.flatMap(tasks, (task) => (task.background ? [] : [task.conversationId])),
  );

  const agentOf = (conversationId: number): string => {
    // SAFETY: a task's conversation is a pi-durable conversation ID.
    const id = conversationId as PiConversationId;

    return state.conversations[String(id)] ?? (isSessionBranch(state, id) ? ROOT : "unknown");
  };

  const agents = Arr.map(inTreeOrder(Record.values(state.agents), ROOT), (agent): GraphAgent => {
    const shown: GraphAgent = {
      id: agent.id,
      parent: agent.parent,
      // SAFETY: the conversation ID of an agent the Harness created, a pi-durable conversation ID.
      conversationId: agent.conversationId as ConversationId,
      role: agent.contract.role,
      model: agent.contract.model,
      status: working.has(agent.conversationId) ? "working" : "idle",
    };

    // The Subagent Workspace it works in, shown in its thread's header.
    const workspace = workspaceOf(state, agent.id);

    return workspace === undefined ? shown : { ...shown, branch: workspace.branch };
  });

  const background = Arr.map(
    Arr.take(
      Arr.filter(tasks, (task) => task.background && !isSubagentBookkeeping(task.kind)),
      MAX_BACKGROUND_TASKS,
    ),
    (task): GraphBackgroundTask => ({
      id: task.id,
      kind: task.kind,
      agent: agentOf(task.conversationId),
      // SAFETY: a task's conversation is a pi-durable conversation ID.
      conversationId: task.conversationId as ConversationId,
      state: task.state.status,
      aborting: task.abortRequested,
    }),
  );

  return { agents, background };
};
