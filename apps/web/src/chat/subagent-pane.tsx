// A Subagent Pane: one subagent's conversation, filling the Pane, under a header with what the agent is (its ID, role,
// model, the branch of its Subagent Workspace) and how it is doing, with its own Stop. The Subagents Pane's rows and the
// Session details open one per subagent (`subagent:<conversationId>`); the conversation is watched while it is open.

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { List } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import {
  conversationOfSubagentPane,
  SUBAGENTS_PANE,
  subagentPaneName,
  type PaneProps,
} from "../panes.ts";
import { panesAtom } from "../panes-state.ts";
import { agentOfConversation } from "../session/agents.ts";
import { taskGraphAtom } from "../session/atoms.ts";
import { ChildThread } from "./child-thread.tsx";
import { useShownSessionId } from "./conversation.ts";
import { Messages } from "./messages.tsx";
import { AgentStatus, AgentStopButton, AgentSummary } from "./subagent-card.tsx";

const Header = ({ conversationId }: { conversationId: number }) => {
  const actOnPanes = useAtomSet(panesAtom);

  const agent = useAtomValue(taskGraphAtom(useShownSessionId()), (graph) =>
    agentOfConversation(graph, conversationId),
  );

  return (
    <header className="flex items-center gap-2 border-b px-4 py-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
        {agent === undefined ? (
          <span className="text-sm">{subagentPaneName(conversationId, undefined)}</span>
        ) : (
          <AgentSummary agent={agent} />
        )}
      </div>
      <AgentStatus agent={agent} />
      <AgentStopButton agent={agent} />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="size-7 px-0 text-muted-foreground"
        aria-label="All subagents"
        title="All subagents"
        onClick={() => {
          actOnPanes({ type: "open", key: SUBAGENTS_PANE });
        }}
      >
        <List />
      </Button>
    </header>
  );
};

/** The Subagent Pane opened with `argument`, a conversation's ID, which the Pane types checked it is. */
export const SubagentPane = ({ argument }: PaneProps) => {
  const conversationId = conversationOfSubagentPane(argument);

  if (conversationId === undefined) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header conversationId={conversationId} />
      <div className="flex min-h-0 flex-1 flex-col px-4 pb-3">
        <ChildThread conversationId={conversationId} messages={<Messages />} fill />
      </div>
    </div>
  );
};
