// The Session a chat shows, for the components deep inside it (a subagent's card in the transcript, the Tasks Pane,
// the composers), and the key of one of its conversations, which the composer's atoms are kept by.

// @effect-diagnostics missingPipeableSignature:off -- a plain constructor of a key, not a combinator.

import { useAtomValue } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Atom from "effect/reactivity/Atom";

/** The ID of the Session shown: its chat provides it once, around everything it renders. */
export const ShownSession = ScopedAtom.make((sessionId: string) => Atom.make(sessionId));

/** The ID of the Session shown. */
export const useShownSessionId = (): string => useAtomValue(ShownSession.use());

/** One conversation of a Session: the root's when `conversationId` is undefined, else a subagent's. */
export interface ConversationKey {
  readonly sessionId: string;
  readonly conversationId: number | undefined;
}

/** The key of a conversation, with both fields set, so equal keys are equal values. */
export const conversationKey = (
  sessionId: string,
  conversationId: number | undefined,
): ConversationKey => ({ sessionId, conversationId });
