// A Subagent Pane: one subagent's conversation, filling the Pane, under a header with what the agent is (its ID, role,
// model, the branch of its Subagent Workspace) and how it is doing, with its own Stop. The Subagents Pane's rows and the
// Session details open one per subagent (`subagent:<conversationId>`); the thread is watched while the Pane is open.

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { List, Square } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import { conversationOfSubagentPane, SUBAGENTS_PANE, type PaneProps } from "../panes.ts";
import { panesAtom } from "../panes-state.ts";
import { agentOfConversation } from "../session/agents.ts";
import { abortAtom, taskGraphAtom } from "../session/atoms.ts";
import { ChildThread } from "./child-thread.tsx";
import { useShownSessionId } from "./conversation.ts";
import { Messages } from "./messages.tsx";
import { AgentBranch, AgentStatus, shortModel } from "./subagent-card.tsx";

const Header = ({ conversationId }: { conversationId: number }) => {
  const sessionId = useShownSessionId();
  const abort = useAtomSet(abortAtom(sessionId));
  const actOnPanes = useAtomSet(panesAtom);

  const agent = useAtomValue(taskGraphAtom(sessionId), (graph) =>
    agentOfConversation(graph, conversationId),
  );

  return (
    <header className="flex items-center gap-2 border-b px-4 py-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="font-mono text-[0.8125rem]">{agent?.id ?? "Subagent"}</span>
        {agent !== undefined && agent.role !== null && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{agent.role}</span>
        )}
        {agent !== undefined && (
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {shortModel(agent.model)}
          </span>
        )}
        <span className="min-w-0 text-muted-foreground">
          <AgentBranch agent={agent} />
        </span>
      </div>
      <AgentStatus agent={agent} />
      {agent?.status === "working" && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="size-7 px-0"
          aria-label={`Stop ${agent.id}`}
          title={`Stop ${agent.id}`}
          onClick={() => {
            abort({ conversationId });
          }}
        >
          <Square />
        </Button>
      )}
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
