// @effect-diagnostics missingPipeableSignature:off -- a plain function of the task graph.

// What a Subagent page (GLOSSARY.md → Subagent page) shows of its subagent: the page names it by its canonical ID, and
// the Session's task graph, watched on its socket, gives the conversation to show. A subagent the graph does not list
// once it has loaded was deleted: the page says so, with a way back to its Session. A new subagent that takes the ID
// later (ADR-0040) is shown in its place.

import type { GraphAgent, TaskGraphSummary } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

/** The subagent of a Subagent page: still loading the task graph, gone from it, or listed. */
export type SubagentOnPage =
  | { readonly kind: "loading" }
  | { readonly kind: "gone" }
  | { readonly kind: "shown"; readonly agent: GraphAgent };

/** What the page of agent `agentId` shows, as the task graph `graph` (null until the Session sends one) lists it. */
export const subagentOnPage = (graph: TaskGraphSummary | null, agentId: string): SubagentOnPage => {
  if (graph === null) return { kind: "loading" };

  return Option.match(
    Arr.findFirst(graph.agents, (agent) => agent.id === agentId),
    {
      onNone: (): SubagentOnPage => ({ kind: "gone" }),
      onSome: (agent): SubagentOnPage => ({ kind: "shown", agent }),
    },
  );
};
