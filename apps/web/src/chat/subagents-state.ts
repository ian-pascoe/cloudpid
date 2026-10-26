// What brings a subagent into sight in the Subagents Pane, from elsewhere on the Session's page (the Activity card).

import * as Atom from "effect/reactivity/Atom";
import { SUBAGENTS_PANE } from "../panes.ts";
import { panesAtom } from "../panes-state.ts";
import { agentRowOpenAtom } from "../session-layout-state.ts";

/**
 * The conversation of the subagent the Subagents Pane of Session `sessionId` is asked to bring into sight; its row
 * scrolls to itself and clears it, and the Pane clears it when no row is that agent's.
 */
export const revealedAgentAtom = Atom.family((_sessionId: string) =>
  Atom.make<number | null>(null),
);

/**
 * Shows the subagent of a conversation in Session `sessionId`'s Subagents Pane: opens its row, opens or shows the Pane,
 * and brings the row into sight.
 */
export const showAgentAtom = Atom.family((sessionId: string) =>
  Atom.writable(
    () => null,
    (ctx, conversationId: number) => {
      ctx.set(agentRowOpenAtom(sessionId, conversationId), true);
      ctx.set(revealedAgentAtom(sessionId), conversationId);
      ctx.set(panesAtom, { type: "open", key: SUBAGENTS_PANE });
    },
  ),
);
