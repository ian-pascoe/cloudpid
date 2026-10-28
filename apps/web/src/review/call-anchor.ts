// What a Call diff's drafts anchor to (`docs/architecture/diffs-and-review.md` → Annotations and Reviews): the conversation
// whose call it is, the call (and the `codemode` call's own number), the tool, and the file; they go to that
// conversation's composer: a subagent's for its calls, shown in its card, the active branch's for the root's.

import type { ConversationId } from "@cloudpid/protocol";
import { useAtomValue } from "@effect/atom-react";
import { useShownSessionId, useThreadConversation } from "../chat/conversation.ts";
import { activeBranchAtom } from "../session/atoms.ts";
import type { DiffAnchor } from "./drafts.ts";

/** The call a Call diff was drawn from. */
export interface CallRef {
  readonly callId: string;
  /** The call's number in a `codemode` script, for one the script made. */
  readonly nested?: string | undefined;
  readonly tool: string;
  /** The file, as the call names it. */
  readonly path: string | undefined;
}

/** The anchor of a Call diff shown in this thread; undefined until the Session says its active branch, or with no path. */
export const useCallAnchor = ({ callId, nested, tool, path }: CallRef): DiffAnchor | undefined => {
  const sessionId = useShownSessionId();
  const thread = useThreadConversation();
  const active = useAtomValue(activeBranchAtom(sessionId));
  const conversation = thread ?? active;

  if (path === undefined || conversation === null) return undefined;

  const source = {
    kind: "call" as const,
    // SAFETY: a conversation the Session named: the thread's subagent, or its active branch.
    conversationId: conversation as ConversationId,
    callId,
    tool,
  };

  return {
    source: nested === undefined ? source : { ...source, nested },
    path,
    conversationId: thread,
  };
};
