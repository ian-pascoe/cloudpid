import type { GraphAgent, TaskGraphSummary } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { subagentOnPage } from "./subagent-page-state.ts";

const agent = {
  id: "agent-1.reviewer",
  parent: "agent-1",
  // SAFETY: a test ID; the brand is for the type system only.
  conversationId: 3 as GraphAgent["conversationId"],
  role: "reviewer",
  model: "anthropic/claude-haiku-5",
  status: "working",
} satisfies GraphAgent;

const graph: TaskGraphSummary = { agents: [agent], background: [] };

describe("a Subagent page's subagent", () => {
  it("is loading until the Session sends its task graph", () => {
    expect(subagentOnPage(null, "agent-1.reviewer")).toEqual({ kind: "loading" });
  });

  it("is the agent the task graph lists under the page's ID", () => {
    expect(subagentOnPage(graph, "agent-1.reviewer")).toEqual({ kind: "shown", agent });
  });

  it("is gone once the task graph has loaded without it: it was deleted", () => {
    expect(subagentOnPage(graph, "agent-2")).toEqual({ kind: "gone" });
    expect(subagentOnPage({ agents: [], background: [] }, "agent-1.reviewer")).toEqual({
      kind: "gone",
    });
  });
});
