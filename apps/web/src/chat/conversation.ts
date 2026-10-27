// The Session a chat shows, for the components deep inside it (a subagent's card in the transcript, the Subagents Pane,
// the composers), and the key of one of its conversations, which the composer's atoms are kept by.

// @effect-diagnostics missingPipeableSignature:off -- a plain constructor of a key, not a combinator.

import { useAtomValue } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Atom from "effect/reactivity/Atom";
import { createContext, use } from "react";
import { layoutKey } from "../session-layout.ts";
import { ROOT_AGENT } from "../session/agents.ts";
import { type ConversationKey, conversationKey } from "../session/conversation-key.ts";

export { type ConversationKey, conversationKey };

/** The ID of the Session shown: its chat provides it once, around everything it renders. */
export const ShownSession = ScopedAtom.make((sessionId: string) => Atom.make(sessionId));

/** The ID of the Session shown. */
export const useShownSessionId = (): string => useAtomValue(ShownSession.use());

/**
 * The subagent a Subagent page shows (GLOSSARY.md → Subagent page): its canonical ID and its conversation. The page
 * provides it around everything it renders, once the task graph has named the conversation; the Session page provides
 * none.
 */
export interface ShownSubagent {
  readonly agentId: string;
  readonly conversationId: number;
}

export const ShownSubagentContext = createContext<ShownSubagent | undefined>(undefined);

/** The subagent the Subagent page shown is of; undefined on the Session page. */
export const useShownSubagent = (): ShownSubagent | undefined => use(ShownSubagentContext);

/** The key the page shown keeps its layout under: the Session page's, or the Subagent page's own (`layoutKey`). */
export const useShownLayoutKey = (): string =>
  layoutKey(useShownSessionId(), useShownSubagent()?.agentId);

/**
 * The agent the page shown is about: `ROOT_AGENT` on the Session page, the subagent's ID on a Subagent page. Its
 * subtree is what the page's Subagents Pane lists, and its children what its Session details do.
 */
export const useShownAgentId = (): string => useShownSubagent()?.agentId ?? ROOT_AGENT;

/**
 * The Changes the page shown watches (GLOSSARY.md → Changes): the Session's on its page, those of the subagent's
 * conversation's Workspace on a Subagent page.
 */
export const useShownChanges = (): ConversationKey =>
  conversationKey(useShownSessionId(), useShownSubagent()?.conversationId);

/**
 * The conversation of the thread a message renders in: undefined in the root's thread, a subagent's in that subagent's
 * thread (`child-thread.tsx` provides it).
 */
export const ThreadConversation = createContext<number | undefined>(undefined);

/** The conversation of the thread this renders in; undefined for the root's. */
export const useThreadConversation = (): number | undefined => use(ThreadConversation);
