// @effect-diagnostics missingPipeableSignature:off -- a plain constructor of a key, not a combinator.

// Which Changes a page watches (GLOSSARY.md → Changes; ADR-0024): the Session's own, or those of a subagent's
// conversation's Workspace (its Subagent Workspace, else its nearest ancestor's, else the Session's), which a Subagent
// page shows. Every atom over Changes is kept by this key, so a Session page's and a Subagent page's never mix.

/** The Changes of Session `sessionId`: its own when `conversationId` is undefined, else that subagent conversation's. */
export interface ChangesKey {
  readonly sessionId: string;
  readonly conversationId: number | undefined;
}

/** The key of some Changes, with both fields set, so equal keys are equal values (as an atom family compares them). */
export const changesKey = (sessionId: string, conversationId?: number): ChangesKey => ({
  sessionId,
  conversationId,
});
