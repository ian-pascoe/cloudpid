// @effect-diagnostics asyncFunction:off missingPipeableSignature:off -- pi-durable commit callbacks are Promise code; helpers take the call's API.
// What the context tools read and write: the Notes document, stored entries, and the conversations of an agent's
// lineage, through a tool call's pi-durable API.
import { ChordContext } from "@cloudpid/effect-durable";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { Context as ChordContextValue } from "@earendil-works/chord/context";
import type {
  ConversationId,
  EntryId,
  EntryRecord,
  ToolExecutionApi,
  Tx,
} from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import {
  agentOf,
  conversationOf,
  EMPTY_STATE as NO_SUBAGENTS,
  SubagentsDoc,
  subtreeOf,
} from "../subagents/state.ts";
import { ContextDoc, type ContextState, EMPTY_STATE } from "./notes.ts";

/** A context tool call failed; its message is what the model sees. */
export class ContextError extends Schema.TaggedError<
  ContextError,
  { readonly brand: unique symbol }
>()("ContextError", { message: Schema.String }) {}

export const fail = (message: string) => Effect.fail(ContextError.make({ message }));

/** A decision a commit refuses; it rolls the commit back and becomes the call's error. */
// @effect-diagnostics-next-line extendsNativeError:off -- thrown inside a pi-durable commit callback, to roll it back.
export class Refusal extends Error {}

/** Run pi-durable call `run` with the fiber's Chord context; a refusal's message is the call's error. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- the operation names the call, as `Effect.fn` does.
export const durable = <A>(
  operation: string,
  run: (context: ChordContextValue) => Promise<A>,
): Effect.Effect<A, ContextError> =>
  Effect.gen(function* () {
    const chord = yield* ChordContext;

    return yield* Effect.tryPromise({
      try: (signal) => run(withAbortSignal(signal, chord)),
      catch: (cause) =>
        ContextError.make({
          message:
            cause instanceof Refusal ? cause.message : `${operation} failed: ${String(cause)}`,
        }),
    });
  });

/** Conversation `conversationId`'s Notes and saved Handoff. */
export const readContext = (
  api: ToolExecutionApi,
  conversationId: ConversationId,
): Effect.Effect<ContextState, ContextError> =>
  Effect.map(
    durable("snapshot", (context) => api.snapshot(ContextDoc, conversationId, context)),
    (state) => state ?? EMPTY_STATE,
  );

/** Every entry stored for conversation `conversationId`, oldest first, including those before a Handoff. */
export const scanAll = async (tx: Tx, conversationId: ConversationId): Promise<EntryRecord[]> => {
  const entries: EntryRecord[] = [];
  let cursor;

  do {
    const page = await tx.scanEntries({ conversationId, order: "ascending" }, 500, cursor);

    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);

  return entries;
};

/** Every stored entry of conversation `conversationId`, oldest first. */
export const readEntries = (
  api: ToolExecutionApi,
  conversationId: ConversationId,
): Effect.Effect<EntryRecord[], ContextError> =>
  durable("scanEntries", (context) => api.commit((tx) => scanAll(tx, conversationId), context));

/** Entry `id`, when conversation `conversationId` can see it. */
export const readEntry = (
  api: ToolExecutionApi,
  conversationId: ConversationId,
  id: EntryId,
): Effect.Effect<EntryRecord | undefined, ContextError> =>
  durable("scanEntries", (context) =>
    api.commit(
      async (tx) =>
        (await tx.scanEntries({ conversationId, minEntryId: id, maxEntryId: id }, 1)).items[0],
      context,
    ),
  );

const byId = Order.mapInput(Order.String, (record: { readonly id: string }) => record.id);

/** A conversation of an agent's lineage, labelled by the agent that runs it. */
export type Owner = { readonly conversationId: ConversationId; readonly agent: string };

/**
 * The conversations of `self`'s lineage, its own first: the agents that spawned it, nearest first, then the agents it
 * spawned, at any depth. Siblings are left out. A conversation the subagents do not know is its own lineage.
 */
export const lineage = (
  api: ToolExecutionApi,
  self: ConversationId,
): Effect.Effect<ReadonlyArray<Owner>, ContextError> =>
  Effect.map(
    durable("snapshot", (context) => api.snapshot(SubagentsDoc, context)),
    (snapshot) => {
      const state = snapshot ?? NO_SUBAGENTS;
      const agent = agentOf(state, self);

      if (agent === undefined) return [{ conversationId: self, agent: "root" }];

      const owners: Owner[] = [{ conversationId: self, agent }];

      for (let id = state.agents[agent]?.parent; id !== undefined; id = state.agents[id]?.parent) {
        const conversationId = conversationOf(state, id);

        if (conversationId !== undefined) owners.push({ conversationId, agent: id });
      }

      const below =
        agent === "root"
          ? Record.values(state.agents)
          : Arr.filter(subtreeOf(state, agent), (record) => record.id !== agent);

      for (const record of Arr.sort(below, byId)) {
        owners.push({ conversationId: record.conversationId, agent: record.id });
      }

      return owners;
    },
  );
