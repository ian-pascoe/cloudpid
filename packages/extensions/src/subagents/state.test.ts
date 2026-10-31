// @effect-diagnostics preferEffectArray:off -- plain fixtures.
// Which conversation is the root agent's once the Session has branches (GLOSSARY.md → Session tree), where a child's
// reports go, and what a delete leaves of a freed ID (ADR-0040).
import { type ConversationId, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  type AgentRecord,
  agentOf,
  conversationOf,
  deleteSubtree,
  EMPTY_STATE,
  isSessionBranch,
  reportConversationOf,
  runs,
  type SubagentsState,
  takeId,
} from "./state.ts";

// SAFETY: test conversation IDs, as pi-durable brands them.
const conversation = (id: number) => id as ConversationId;

/** A child `id` of `parent`, running conversation `runs`, started from Session branch `origin` if any. */
const child = (id: string, parent: string, runs: number, origin?: number): AgentRecord => {
  // SAFETY: the fields these functions read; the rest of a record is never looked at.
  const record = {
    id,
    parent,
    depth: parent === "root" ? 1 : 2,
    conversationId: conversation(runs),
  } as AgentRecord;

  return origin === undefined ? record : { ...record, origin: conversation(origin) };
};

/** Branch 5 active, branch 9 left; agent-1 started from 9, agent-2 from before branches, agent-3 below agent-1. */
const STATE: SubagentsState = {
  ...EMPTY_STATE,
  activeBranch: conversation(5),
  branches: [conversation(5), conversation(9)],
  agents: {
    "agent-1": child("agent-1", "root", 20, 9),
    "agent-2": child("agent-2", "root", 21),
    "agent-3": child("agent-3", "agent-1", 22),
  },
  conversations: { "20": "agent-1", "21": "agent-2", "22": "agent-3" },
};

describe("the root agent's conversations", () => {
  it("are the root conversation and every Session branch", () => {
    expect(isSessionBranch(STATE, ROOT_CONVERSATION_ID)).toBe(true);
    expect(isSessionBranch(STATE, conversation(9))).toBe(true);
    expect(isSessionBranch(STATE, conversation(20))).toBe(false);
    expect(agentOf(STATE, conversation(9))).toBe("root");
    expect(agentOf(STATE, conversation(20))).toBe("agent-1");
  });

  it("run the active branch, or the root conversation before any branch", () => {
    expect(conversationOf(STATE, "root")).toBe(5);
    expect(conversationOf(EMPTY_STATE, "root")).toBe(ROOT_CONVERSATION_ID);
    expect(conversationOf(STATE, "agent-1")).toBe(20);
  });
});

describe("where a child's reports go", () => {
  it("is the branch a child of the root was started from, though another is active now", () => {
    expect(reportConversationOf(STATE, "agent-1")).toBe(9);
  });

  it("is the active branch for a child started before branches, and the parent's for a deeper one", () => {
    expect(reportConversationOf(STATE, "agent-2")).toBe(5);
    expect(reportConversationOf(STATE, "agent-3")).toBe(20);
    expect(reportConversationOf(STATE, "agent-9")).toBeUndefined();
  });
});

describe("a deleted ID", () => {
  /** STATE as a commit's draft: a copy it may change. */
  const draft = (): SubagentsState => structuredClone({ ...STATE, waiters: {} });

  it("is deleted only while its agent still runs the conversation the delete read", () => {
    const doc = draft();

    expect(deleteSubtree(doc, "agent-1", conversation(99))).toEqual([]);
    expect(runs(doc, "agent-1", conversation(20))).toBe(true);
    expect(deleteSubtree(doc, "agent-1", conversation(20)).map((agent) => agent.id)).toEqual([
      "agent-1",
    ]);
    expect(runs(doc, "agent-1", conversation(20))).toBe(false);
  });

  it("keeps where its turns ended and its Workspace, until a new agent takes the ID", () => {
    const doc = draft();
    const workspace = { id: "00000001", branch: "b", object: "ws:00000001", directory: "/w" };

    doc.agents["agent-2"] = { ...child("agent-2", "root", 21), nextTurn: 4, workspace };
    deleteSubtree(doc, "agent-2", conversation(21));

    expect(doc.tombstones).toEqual(["agent-2"]);
    expect(doc.freed).toEqual({ "agent-2": { nextTurn: 4, workspace } });
    expect(takeId(doc, "agent-2")).toBe(4);
    expect(doc.tombstones).toEqual([]);
    expect(doc.freed).toEqual({});
    expect(takeId(doc, "agent-7")).toBe(1);
  });
});
