// The conversation a tool runs for, as the Session's Workspace services take it: a conversation with a Subagent
// Workspace of its own works there, any other in the Session's Workspace (`docs/spec.md` → Subagents).
import { ChordContext } from "@cloudpid/effect-durable";
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentReader, ToolExecutionApi } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";

/** A conversation, with what reads its Session's documents (the Subagents document, which says where it works). */
export type ConversationTarget = {
  readonly conversationId: ConversationId;
  readonly read: Pick<DocumentReader, "snapshot">;
  readonly context: Context;
};

/** The conversation a tool call runs for. */
export const conversationTarget = (api: ToolExecutionApi): Effect.Effect<ConversationTarget> =>
  Effect.gen(function* () {
    const context = yield* ChordContext;

    return { conversationId: api.conversationId, read: api, context };
  });
