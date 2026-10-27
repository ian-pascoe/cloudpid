// @effect-diagnostics missingPipeableSignature:off -- a plain constructor of a key, not a combinator.

// One conversation of a Session, as the atoms kept per conversation are keyed: the composer's, a thread's, and the
// Changes a page watches (GLOSSARY.md → Changes; ADR-0024): the Session's own Workspace's for the root conversation,
// else those of the subagent conversation's Workspace (its Subagent Workspace, else its nearest ancestor's, else the
// Session's), which a Subagent page shows. A Session page's and a Subagent page's atoms never mix.

/** One conversation of a Session: the root's when `conversationId` is undefined, else a subagent's. */
export interface ConversationKey {
  readonly sessionId: string;
  readonly conversationId: number | undefined;
}

/** The key of a conversation, with both fields set, so equal keys are equal values (as an atom family compares them). */
export const conversationKey = (
  sessionId: string,
  conversationId: number | undefined,
): ConversationKey => ({ sessionId, conversationId });
