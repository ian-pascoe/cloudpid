// @effect-diagnostics preferEffectRecord:off preferEffectArray:off -- test data built with native arrays and records.
import type { AgentRecord, SubagentsState } from "@cloudpid/extensions/subagents";
import type { ConversationId, TaskGraph, TaskGraphNode, TaskId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { MAX_BACKGROUND_TASKS, summarizeTaskGraph } from "./task-graph.ts";

// SAFETY: test IDs; pi-durable's IDs are positive integers branded for the type system only.
const conversation = (id: number) => id as ConversationId;

// SAFETY: as above.
const taskId = (id: number) => id as TaskId;

const node = (
  id: number,
  kind: string,
  conversationId: number,
  fields: Partial<TaskGraphNode> = {},
): TaskGraphNode => ({
  id: taskId(id),
  kind,
  conversationId: conversation(conversationId),
  background: false,
  abortRequested: false,
  state: { status: "running", phase: "run" },
  conversations: [],
  ...fields,
});

const graphOf = (...nodes: TaskGraphNode[]): TaskGraph => ({
  tasks: Object.fromEntries(nodes.map((each) => [String(each.id), each])),
});

const agent = (
  id: string,
  parent: string,
  conversationId: number,
  createdAt: number,
  role?: string,
) => ({
  id,
  parent,
  depth: id.split(".").length,
  conversationId: conversation(conversationId),
  anchor: taskId(0),
  createdAt,
  contract: {
    task: "t",
    role: role ?? null,
    model: "anthropic/claude-haiku-5",
    thinkingLevel: "low",
    tools: [],
    toolSelection: "inherit",
    delegation: "none" as const,
    sessionContext: "omit" as const,
    ceiling: [],
  },
  nextTurn: 1,
  turns: [],
});

const stateOf = (
  ...agents: Array<ReturnType<typeof agent> & Partial<AgentRecord>>
): SubagentsState => ({
  agents: Object.fromEntries(agents.map((each) => [each.id, each])),
  conversations: Object.fromEntries(agents.map((each) => [String(each.conversationId), each.id])),
  tombstones: [],
  nextIndex: {},
  waiters: {},
});

describe("summarizeTaskGraph", () => {
  it("lists every subagent, working while its conversation has live work and idle otherwise", () => {
    const state = stateOf(agent("agent-1", "root", 2, 1, "small"), agent("agent-2", "root", 3, 2));
    const graph = graphOf(node(10, "pi.generation", 2), node(11, "pi.generation", 1));

    expect(summarizeTaskGraph(graph, state).agents).toEqual([
      {
        id: "agent-1",
        parent: "root",
        conversationId: 2,
        role: "small",
        model: "anthropic/claude-haiku-5",
        status: "working",
      },
      {
        id: "agent-2",
        parent: "root",
        conversationId: 3,
        role: null,
        model: "anthropic/claude-haiku-5",
        status: "idle",
      },
    ]);
  });

  it("names the branch of the Subagent Workspace each subagent works in, its own or its parent's", () => {
    const workspace = {
      id: "9f9f9f9f",
      branch: "cloudpid/9f9f9f9f",
      object: "ws:9f9f9f9f",
      directory: "/workspace",
    };

    const state = stateOf(
      { ...agent("agent-1", "root", 2, 1), workspace },
      agent("agent-1.a", "agent-1", 3, 2),
      agent("agent-2", "root", 4, 3),
    );

    expect(
      summarizeTaskGraph(graphOf(), state).agents.map((each) => [each.id, each.branch]),
    ).toEqual([
      ["agent-1", "cloudpid/9f9f9f9f"],
      ["agent-1.a", "cloudpid/9f9f9f9f"],
      ["agent-2", undefined],
    ]);
  });

  it("does not count a subagent's own background work as it working", () => {
    const state = stateOf(agent("agent-1", "root", 2, 1));
    const graph = graphOf(node(10, "pi.compaction", 2, { background: true }));

    expect(summarizeTaskGraph(graph, state).agents[0]?.status).toBe("idle");
  });

  it("puts each subagent right after its parent, children in the order they were started", () => {
    const state = stateOf(
      agent("agent-2", "root", 3, 5),
      agent("agent-1.b", "agent-1", 5, 4),
      agent("agent-1", "root", 2, 1),
      agent("agent-1.a", "agent-1", 4, 3),
    );

    expect(summarizeTaskGraph(graphOf(), state).agents.map((each) => each.id)).toEqual([
      "agent-1",
      "agent-1.a",
      "agent-1.b",
      "agent-2",
    ]);
  });

  it("lists live background tasks, not the subagents' own bookkeeping, naming the agent each belongs to", () => {
    const state = stateOf(agent("agent-1", "root", 2, 1));

    const graph = graphOf(
      node(1, "cloudpid.subagent-anchor", 1, { background: true }),
      node(2, "cloudpid.subagent-reporter", 1, { background: true }),
      node(3, "pi.compaction", 2, { background: true, abortRequested: true }),
      node(4, "pi.generation", 1),
      node(5, "browser.session", 1, {
        background: true,
        state: { status: "waiting", phase: "idle", on: [taskId(3)], policy: "allSettled" },
      }),
    );

    expect(summarizeTaskGraph(graph, state).background).toEqual([
      {
        id: 3,
        kind: "pi.compaction",
        agent: "agent-1",
        conversationId: 2,
        state: "running",
        aborting: true,
      },
      {
        id: 5,
        kind: "browser.session",
        agent: "root",
        conversationId: 1,
        state: "waiting",
        aborting: false,
      },
    ]);
  });

  it("shows a sleeping task as sleeping, and a subagent whose generation sleeps out a backoff as working", () => {
    const state = stateOf(agent("agent-1", "root", 2, 1));
    const sleeping = { status: "sleeping", phase: "retry", until: 5_000 } as const;

    const graph = graphOf(
      node(3, "pi.compaction", 1, { background: true, state: sleeping }),
      node(4, "pi.generation", 2, { state: sleeping }),
    );

    const summary = summarizeTaskGraph(graph, state);

    expect(summary.background.map((task) => task.state)).toEqual(["sleeping"]);
    expect(summary.agents[0]?.status).toBe("working");
  });

  it("keeps only the oldest `MAX_BACKGROUND_TASKS` background tasks", () => {
    const many = Array.from({ length: MAX_BACKGROUND_TASKS + 5 }, (_, index) =>
      node(index + 1, "work", 1, { background: true }),
    );

    expect(summarizeTaskGraph(graphOf(...many), stateOf()).background).toHaveLength(
      MAX_BACKGROUND_TASKS,
    );
  });
});
