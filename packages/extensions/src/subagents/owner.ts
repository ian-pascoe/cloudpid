// @effect-diagnostics asyncFunction:off missingPipeableSignature:off -- helpers over pi-durable's Promise-based Harness.
// What the Session's owner may do to a subagent directly, from its thread in the UI (`docs/spec.md` → Subagents): the
// conversations that count as agents, and stopping one, or all of them, without going through an agent's tools.
import type { Context } from "@earendil-works/chord/context";
import {
  type ConversationId,
  type Harness,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import { ROOT_AGENT } from "./ids.ts";
import {
  agentOf,
  EMPTY_STATE,
  SubagentsDoc,
  subtreeOf,
  type AgentRecord,
  type SubagentsState,
} from "./state.ts";

/** What the owner reads and stops through: a Harness's Session documents and conversations. */
export type OwnerHarness = Pick<Harness, "conversation" | "snapshot">;

const readState = async (harness: OwnerHarness, context: Context): Promise<SubagentsState> =>
  (await harness.snapshot(SubagentsDoc, context)) ?? EMPTY_STATE;

/**
 * Whether `conversationId` is the root conversation or one a live subagent runs: the conversations the owner may
 * message and stop. A deleted subagent's conversation is not one, and neither is any other conversation of the Session.
 */
export const isAgentConversation = async (
  harness: OwnerHarness,
  conversationId: ConversationId,
  context: Context,
): Promise<boolean> =>
  conversationId === ROOT_CONVERSATION_ID ||
  agentOf(await readState(harness, context), conversationId) !== undefined;

const byDepthDescending = Order.mapInput(
  Order.flip(Order.Number),
  (agent: AgentRecord) => agent.depth,
);

/** The agents below `agentId`, deepest first: all of them for the root. */
const below = (state: SubagentsState, agentId: string): AgentRecord[] =>
  agentId === ROOT_AGENT
    ? Arr.sort(Record.values(state.agents), byDepthDescending)
    : Arr.filter(subtreeOf(state, agentId), (agent) => agent.id !== agentId);

/**
 * Abort the work of the agent whose conversation is `conversationId`, and withdraw its queued input. With
 * `subagents`, everything below it stops too, background work and the reports it held included: a subagent's own
 * subagents are agents of their own, and keep working otherwise. The caller has checked that it is an agent's.
 */
export const stopConversation = async (
  harness: OwnerHarness,
  conversationId: ConversationId,
  options: { readonly subagents: boolean },
  context: Context,
): Promise<void> => {
  await (
    await harness.conversation(conversationId, context)
  )?.abort(context, {
    background: options.subagents,
  });

  if (!options.subagents) return;

  // An agent that was started while the abort ran is stopped by a second pass, deepest first.
  const state = await readState(harness, context);
  const target = agentOf(state, conversationId) ?? ROOT_AGENT;

  for (const agent of below(state, target)) {
    await (
      await harness.conversation(agent.conversationId, context)
    )?.abort(context, {
      background: true,
    });
  }
};
