// @effect-diagnostics asyncFunction:off missingPipeableSignature:off -- helpers for pi-durable commit callbacks, which are Promise code.
// The Session's subagents, as one Session document: every live agent with its launch contract and recent turns, the
// tombstones of deleted IDs, and the waits blocked on a child. A commit that changes it decides one delivery at a
// time, so a result is either claimed by a wait or reported back automatically, never both.
import {
  AssistantEntry,
  type ConversationId,
  defineDoc,
  type EntryId,
  ROOT_CONVERSATION_ID,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Record from "effect/Record";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

/** Whether a child may start children of its own: `fanout` may, below the depth cap. */
export type Delegation = "none" | "fanout";

/** What a child starts with: nothing but its task, its parent's conversation quoted, or a summary of it. */
export type SessionContext = "omit" | "inherit" | "compact";

/** What a child was created with; settings changed later never alter it. */
export type LaunchContract = {
  task: string;
  /** The role named at the spawn, if any. */
  role: string | null;
  /** `provider/modelId`. */
  model: string;
  thinkingLevel: string;
  /** Ordinary tools granted. */
  tools: string[];
  /** What `tools` asked for: a preset, `exact`, or `inherit` when omitted. */
  toolSelection: string;
  delegation: Delegation;
  sessionContext: SessionContext;
  /** The caller's ordinary tools at the spawn, which the grant stayed within. */
  ceiling: string[];
};

/**
 * How a settled turn's result reached the parent: claimed by a `subagent_wait`, reported automatically as a follow-up,
 * the same answer as an earlier turn's, or not at all (an aborted turn). `pending` is a report held while the parent
 * is busy, which a `subagent_wait` may still claim.
 */
export type Delivery = "wait" | "pending" | "auto" | "duplicate" | "none";

export type TurnStatus = "running" | "completed" | "failed" | "aborted";

/** One input to a child and the answer it got, carried by one reporter task. */
export type Turn = {
  id: string;
  reporter: TaskId;
  status: TurnStatus;
  startedAt: number;
  endedAt: number | null;
  /** The child's answer entry once completed. */
  answer: EntryId | null;
  error: string | null;
  delivery: Delivery | null;
  /**
   * For an agent with a Subagent Workspace of its own: what the turn's report ends with, its Workspace's branch and what
   * it has not pushed as the turn settled (`handBackLine`). Absent for any other.
   */
  handBack?: string;
};

/**
 * A Subagent Workspace (GLOSSARY.md), as its agent's record keeps it: the Workspace's id and branch, and where the
 * agent's conversation works, the Workspace's Durable Object (`object`) and its directory: its Placement.
 */
export type AgentWorkspace = {
  id: string;
  branch: string;
  object: string;
  directory: string;
};

export type AgentRecord = {
  id: string;
  parent: string;
  depth: number;
  conversationId: ConversationId;
  /**
   * For a child of the root agent: the Session branch it was started from (`branches`), which its reports go to whichever
   * branch is active by then. Absent for a deeper child, and for a child started before Session branches existed (the
   * root conversation's).
   */
  origin?: ConversationId;
  /** The background task that owns the child's conversation. */
  anchor: TaskId;
  createdAt: number;
  contract: LaunchContract;
  nextTurn: number;
  /** The newest turns, oldest first. */
  turns: Turn[];
  /**
   * The Subagent Workspace the agent was started in (`workspace: "new"`), which its conversation's tools use. Absent for
   * an agent that works in its parent's Workspace.
   */
  workspace?: AgentWorkspace;
};

/** What a `subagent_wait` returns. */
export type WaitEvent = {
  event: "turn" | "message" | "timeout" | "steered";
  agent_id: string;
  turn_id: string | null;
  /** `turn`: how the turn ended, or `deleted`; `timeout` and `steered`: whether the child is `running` or `idle`. */
  status: string;
  /** `turn`: the child's answer, unless it was already delivered automatically. */
  output: string | null;
  error: string | null;
  /** `turn`, without a `turn_id`: the result already reached the caller automatically, so it is not repeated. */
  already_delivered: boolean;
  /** `message`: the coordination message the child sent. */
  message: string | null;
  elapsed_ms: number;
};

/** A `subagent_wait` blocked on a child, keyed by its wait task. `result` is set by the commit that ends it. */
export type Waiter = {
  caller: string;
  target: string;
  turnId: string;
  startedAt: number;
  result: WaitEvent | null;
};

export type SubagentsState = {
  agents: Record<string, AgentRecord>;
  /** Agent ID by conversation ID, for a tool to find which agent calls it. */
  conversations: Record<string, string>;
  /** Deleted IDs, which are never reused. */
  tombstones: string[];
  /** The next automatic ID number, by parent. */
  nextIndex: Record<string, number>;
  waiters: Record<string, Waiter>;
  /**
   * The conversation the root agent runs now: the Session's active branch (GLOSSARY.md → Session tree). Absent while it
   * is the root conversation.
   */
  activeBranch?: ConversationId;
  /** Every Session branch's conversation but the root conversation's: each is the root agent's when it calls a tool. */
  branches?: ConversationId[];
};

/** How many settled turns an agent keeps, besides running ones. */
export const RETAINED_TURNS = 20;

export const SubagentsDoc = defineDoc<SubagentsState>({
  kind: "cloudpid.subagents",
  version: 1,
  scope: "session",
  initial: () => ({ agents: {}, conversations: {}, tombstones: [], nextIndex: {}, waiters: {} }),
});

/** The state as read outside a commit: the initial one until the first spawn. */
export const EMPTY_STATE: SubagentsState = SubagentsDoc.definition.initial();

/** Whether `conversationId` is one of the Session's branches: the root conversation, or a branch made from it. */
export const isSessionBranch = (state: SubagentsState, conversationId: ConversationId): boolean =>
  conversationId === ROOT_CONVERSATION_ID || (state.branches ?? []).includes(conversationId);

/** The agent conversation `conversationId` runs, `root` for any of the Session's branches. */
export const agentOf = (
  state: SubagentsState,
  conversationId: ConversationId,
): string | undefined =>
  isSessionBranch(state, conversationId) ? "root" : state.conversations[String(conversationId)];

/** The conversation agent `id` runs: the active Session branch's for the root agent. */
export const conversationOf = (state: SubagentsState, id: string): ConversationId | undefined =>
  id === "root" ? (state.activeBranch ?? ROOT_CONVERSATION_ID) : state.agents[id]?.conversationId;

/**
 * Where agent `id`'s reports go: its parent's conversation, or, for a child of the root agent, the Session branch it was
 * started from, so a branch left since still hears from the work it started.
 */
export const reportConversationOf = (
  state: SubagentsState,
  id: string,
): ConversationId | undefined => {
  const agent = state.agents[id];

  if (agent === undefined) return undefined;

  return agent.parent === "root" && agent.origin !== undefined
    ? agent.origin
    : conversationOf(state, agent.parent);
};

/**
 * The Subagent Workspace agent `id` works in: its own, else the nearest ancestor's that has one. Undefined for the root
 * agent, and for an agent that works in the Session's Workspace.
 */
export const workspaceOf = (state: SubagentsState, id: string): AgentWorkspace | undefined => {
  for (let agent = state.agents[id]; agent !== undefined; agent = state.agents[agent.parent]) {
    if (agent.workspace !== undefined) return agent.workspace;
  }

  return undefined;
};

/** The Subagent Workspace conversation `conversationId` works in (`workspaceOf` its agent), if any. */
export const conversationWorkspace = (
  state: SubagentsState,
  conversationId: ConversationId,
): AgentWorkspace | undefined => {
  const agent = agentOf(state, conversationId);

  return agent === undefined ? undefined : workspaceOf(state, agent);
};

/** The direct children of `id`, oldest first. */
export const childrenOf = (state: SubagentsState, id: string): AgentRecord[] =>
  Arr.filter(Record.values(state.agents), (agent) => agent.parent === id);

/** `id` and everything below it, deepest first, so a subtree is stopped from its leaves up. */
export const subtreeOf = (state: SubagentsState, id: string): AgentRecord[] =>
  Arr.sort(
    Arr.filter(
      Record.values(state.agents),
      (agent) => agent.id === id || agent.id.startsWith(`${id}.`),
    ),
    Order.mapInput(Order.Number, (agent: AgentRecord) => -agent.depth),
  );

/** The text of an assistant answer entry. */
export const answerText = async (tx: Tx, answer: EntryId): Promise<string> => {
  const entry = await tx.entry(AssistantEntry, answer);
  const message = entry?.model?.[0];

  return message?.role === "assistant"
    ? Arr.join(
        Arr.flatMap(message.content, (block) => (block.type === "text" ? [block.text] : [])),
        "",
      )
    : "";
};

/** Start turn `turn` of `agent`, keeping only the newest settled turns. */
export const addTurn = (agent: AgentRecord, turn: Turn): void => {
  agent.turns.push(turn);

  const settled = Arr.filter(agent.turns, (each) => each.status !== "running");
  const drop = settled.length - RETAINED_TURNS;

  if (drop > 0) {
    const dropped = new Set(Arr.map(Arr.take(settled, drop), (each) => each.id));

    agent.turns = Arr.filter(agent.turns, (each) => !dropped.has(each.id));
  }
};

/** A wait event with only what its kind needs. */
export const waitEvent = (
  event: WaitEvent["event"],
  agentId: string,
  fields: Partial<Omit<WaitEvent, "event" | "agent_id">>,
): WaitEvent => ({
  event,
  agent_id: agentId,
  turn_id: fields.turn_id ?? null,
  status: fields.status ?? "",
  output: fields.output ?? null,
  error: fields.error ?? null,
  already_delivered: fields.already_delivered ?? false,
  message: fields.message ?? null,
  elapsed_ms: fields.elapsed_ms ?? 0,
});

/** The open waiter of `caller` on `target`, if one is blocked, with its wait task's ID. */
export const openWaiter = (
  state: SubagentsState,
  caller: string,
  target: string,
): [string, Waiter] | undefined =>
  Arr.findFirst(
    Record.toEntries(state.waiters),
    ([, waiter]) => waiter.caller === caller && waiter.target === target && waiter.result === null,
  ).pipe(Option.getOrUndefined);
