// A `subagent` tool call as a card: which agent it started (role, model, and the branch of its Subagent Workspace when
// it has one) and whether it is working, opening into the agent's live thread.

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { GraphAgent } from "@cloudpid/protocol";
import { useAtom, useAtomValue } from "@effect/atom-react";
import * as Predicate from "effect/Predicate";
import { Bot, ChevronRight, GitBranch, Loader } from "lucide-react";
import type { ReactNode } from "react";
import { agentOfConversation } from "../session/agents.ts";
import { taskGraphAtom } from "../session/atoms.ts";
import { subagentCardOpenAtom } from "../session-layout-state.ts";
import { ChildThread } from "./child-thread.tsx";
import { useShownSessionId } from "./conversation.ts";
import type { StartedSubagent } from "./subagent.ts";

/** How an agent is doing, as the card and the panel say it. */
export const AgentStatus = ({ agent }: { agent: GraphAgent | undefined }) =>
  agent?.status === "working" ? (
    <span className="flex items-center gap-1.5 text-xs text-foreground">
      <Loader className="size-3 motion-safe:animate-spin" aria-hidden />
      Working
    </span>
  ) : (
    <span className="text-xs text-muted-foreground">
      {agent === undefined ? "Not running" : "Idle"}
    </span>
  );

/** The branch of the Subagent Workspace an agent works in, as the card and the panel show it; nothing without one. */
export const AgentBranch = ({ agent }: { agent: GraphAgent | undefined }) =>
  agent?.branch === undefined ? null : (
    <span
      className="flex min-w-0 items-center gap-1 text-xs"
      title={`Works in a Subagent Workspace, on branch ${agent.branch}`}
    >
      <GitBranch className="size-3 shrink-0" aria-hidden />
      <span className="truncate font-mono">{agent.branch}</span>
    </span>
  );

/** The model without its provider, which the card has no room for. */
export const shortModel = (model: string): string => model.slice(model.indexOf("/") + 1);

type CardProps = {
  subagent: StartedSubagent;
  args: ToolCallMessagePartProps["args"];
  /** The transcript's messages, for the thread inside. */
  messages: ReactNode;
};

/**
 * The card of a subagent: its ID, role and model, and its status from the task graph. Opening it watches the agent's
 * conversation, and closing it stops, so a long list of subagents costs one watch per open card. Whether it is open is
 * kept in the Session's layout.
 */
export const SubagentCard = ({ subagent, args, messages }: CardProps) => {
  const sessionId = useShownSessionId();
  const [open, setOpen] = useAtom(subagentCardOpenAtom(sessionId, subagent.conversationId));

  const agent = useAtomValue(taskGraphAtom(sessionId), (graph) =>
    agentOfConversation(graph, subagent.conversationId),
  );

  const named = args.role;

  const role = agent?.role ?? (Predicate.isString(named) ? named : undefined);

  return (
    <details
      open={open}
      onToggle={(event) => {
        // A `details` rendered open fires a toggle too; only a change is kept.
        if (event.currentTarget.open !== open) setOpen(event.currentTarget.open);
      }}
      className="group my-2 rounded-md border"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
        <Bot className="size-3.5" aria-hidden />
        <span className="font-mono text-[0.8125rem] text-foreground">{subagent.agentId}</span>
        {role !== undefined && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-foreground">{role}</span>
        )}
        {agent !== undefined && (
          <span className="min-w-0 truncate font-mono text-xs">{shortModel(agent.model)}</span>
        )}
        <AgentBranch agent={agent} />
        <span className="ml-auto shrink-0">
          <AgentStatus agent={agent} />
        </span>
      </summary>
      {open && (
        <div className="border-t px-3 py-2">
          <ChildThread conversationId={subagent.conversationId} messages={messages} />
        </div>
      )}
    </details>
  );
};
