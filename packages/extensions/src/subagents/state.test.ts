// @effect-diagnostics preferEffectArray:off -- plain fixtures.
// Which conversation is the root agent's once the Session has branches (GLOSSARY.md → Session tree), and where a
// child's reports go.
import { type ConversationId, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  type AgentRecord,
  agentOf,
  conversationOf,
  EMPTY_STATE,
  isSessionBranch,
  reportConversationOf,
  type SubagentsState,
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
