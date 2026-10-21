// A `subagent` tool call as a card: which agent it started (role, model) and whether it is working, opening into the
// agent's live thread.

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { GraphAgent } from "@cloudpid/protocol";
import { useAtom, useAtomValue } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Predicate from "effect/Predicate";
import * as Atom from "effect/reactivity/Atom";
import { Bot, ChevronRight, Loader } from "lucide-react";
import type { ReactNode } from "react";
import { agentOfConversation } from "../session/agents.ts";
import { taskGraphAtom } from "../session/atoms.ts";
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

/** The model without its provider, which the card has no room for. */
export const shortModel = (model: string): string => model.slice(model.indexOf("/") + 1);

type CardProps = {
  subagent: StartedSubagent;
  args: ToolCallMessagePartProps["args"];
  /** The transcript's messages, for the thread inside. */
  messages: ReactNode;
};

/** Whether one card is open. */
const CardOpen = ScopedAtom.make(() => Atom.make(false));

const Card = ({ subagent, args, messages }: CardProps) => {
  const [open, setOpen] = useAtom(CardOpen.use());

  const agent = useAtomValue(taskGraphAtom(useShownSessionId()), (graph) =>
    agentOfConversation(graph, subagent.conversationId),
  );

  const named = args.role;

  const role = agent?.role ?? (Predicate.isString(named) ? named : undefined);

  return (
    <details
      open={open}
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
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

/**
 * The card of a subagent: its ID, role and model, and its status from the task graph. Opening it watches the agent's
 * conversation, and closing it stops, so a long list of subagents costs one watch per open card.
 */
export const SubagentCard = (props: CardProps) => (
  <CardOpen.Provider>
    <Card {...props} />
  </CardOpen.Provider>
);
