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
  deleteSubtree,
  EMPTY_STATE,
  SubagentsDoc,
  subtreeOf,
  type AgentRecord,
  type SubagentsState,
} from "./state.ts";
import type { SubagentWorkspaceHost } from "./workspaces.ts";

/** What the owner reads and stops through: a Harness's Session documents and conversations. */
export type OwnerHarness = Pick<Harness, "conversation" | "snapshot">;

/** What the owner deletes an agent through: also the Harness's commits. */
export type OwnerDeleteHarness = OwnerHarness & Pick<Harness, "commit">;

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
  Arr.sort(
    agentId === ROOT_AGENT
      ? Record.values(state.agents)
      : Arr.filter(subtreeOf(state, agentId), (agent) => agent.id !== agentId),
    byDepthDescending,
  );

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

  // Same loop as the extension's `stopSubtree`: an abort waits until its conversation is idle, and meanwhile an agent
  // still running (the parent of the one being stopped) can start another. So read the state again after each pass and
  // stop whatever is new, until nothing is.
  const stopped = new Set<string>();

  for (;;) {
    const state = await readState(harness, context);
    const target = agentOf(state, conversationId) ?? ROOT_AGENT;
    const fresh = Arr.filter(below(state, target), (agent) => !stopped.has(agent.id));

    if (fresh.length === 0) return;

    for (const agent of fresh) {
      stopped.add(agent.id);

      await (
        await harness.conversation(agent.conversationId, context)
      )?.abort(context, {
        background: true,
      });
    }
  }
};

/** What an owner's delete did: the agents deleted, and why a Subagent Workspace of theirs is still there. */
export type OwnerDeletion = {
  readonly deleted: ReadonlyArray<string>;
  readonly kept: ReadonlyArray<string>;
};

/**
 * Delete agent `agentId` with everything below it, as `subagent_delete` with `discard: true` does (the owner confirmed
 * losing what was not pushed): stop them, retire their IDs, end the waits on them, and remove their Subagent Workspaces
 * through `workspaces`. An agent already deleted deletes nothing.
 */
export const deleteAgent = async (
  harness: OwnerDeleteHarness,
  agentId: string,
  workspaces: SubagentWorkspaceHost | undefined,
  context: Context,
): Promise<OwnerDeletion> => {
  const agent = (await readState(harness, context)).agents[agentId];

  if (agent === undefined || agentId === ROOT_AGENT) return { deleted: [], kept: [] };

  await stopConversation(harness, agent.conversationId, { subagents: true }, context);

  const gone = await harness.commit(
    async (tx) => deleteSubtree(await tx.doc(SubagentsDoc), agentId),
    context,
  );

  // One spawned after the stop is deleted too: stop it now that it can spawn no more.
  for (const each of gone) {
    await (
      await harness.conversation(each.conversationId, context)
    )?.abort(context, { background: true });
  }

  const kept: string[] = [];

  for (const { id, workspace } of gone) {
    if (workspace === undefined || workspaces === undefined) continue;

    try {
      await workspaces.remove(workspace);
    } catch (error) {
      kept.push(
        `The Subagent Workspace ${workspace.id} of ${id} could not be removed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { deleted: Arr.map(gone, (each) => each.id), kept };
};
