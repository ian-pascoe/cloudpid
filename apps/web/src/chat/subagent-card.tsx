// A `subagent` tool call as a card: which agent it started (role, model, and the branch of its Subagent Workspace when
// it has one) and whether it is working, opening into the agent's live thread, with a link to its Subagent page.

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { GraphAgent } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Predicate from "effect/Predicate";
import { Bot, ChevronRight, ExternalLink, GitBranch, Loader, Square } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../components/ui/button.tsx";
import { cn } from "../lib/utils.ts";
import { InAppLink } from "../in-app-link.tsx";
import { subagentPath } from "../router.ts";
import { agentOfConversation } from "../session/agents.ts";
import { abortAtom, taskGraphAtom } from "../session/atoms.ts";
import { subagentCardOpenAtom } from "../session-layout-state.ts";
import { ChildThread } from "./child-thread.tsx";
import { useShownLayoutKey, useShownSessionId } from "./conversation.ts";
import { keepClosedInView } from "./scroller.ts";
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

/**
 * What an agent is, as a row of the Subagents Pane and a Subagent Pane's header show it: its ID, role, model, and the
 * branch of its Subagent Workspace. A Subagent page's header names the agent in its breadcrumb, so it leaves the ID out
 * (`named`).
 */
export const AgentSummary = ({ agent, named = false }: { agent: GraphAgent; named?: boolean }) => (
  <>
    {!named && <span className="font-mono text-[0.8125rem]">{agent.id}</span>}
    {agent.role !== null && (
      <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{agent.role}</span>
    )}
    <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
      {shortModel(agent.model)}
    </span>
    <span className="min-w-0 text-muted-foreground">
      <AgentBranch agent={agent} />
    </span>
  </>
);

/**
 * A link to the Subagent page of agent `agentId` (its canonical ID) in the Session shown: its conversation as a page of
 * its own, with its Changes and its own Panes. A modified click opens it as the browser does (a new tab).
 */
export const OpenPageLink = ({
  agentId,
  className,
}: {
  agentId: string;
  className?: string | undefined;
}) => {
  const href = subagentPath(useShownSessionId(), agentId);

  return (
    <InAppLink
      href={href}
      aria-label={`Open the page of ${agentId}`}
      title={`Open the page of ${agentId}`}
      onClick={(event) => {
        // Inside a card's summary, a click must not also toggle the card.
        event.stopPropagation();
      }}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5",
        className,
      )}
    >
      <ExternalLink aria-hidden />
    </InAppLink>
  );
};

/** Stops an agent's conversation, never the agents below it, while it works; nothing while it does not. */
export const AgentStopButton = ({ agent }: { agent: GraphAgent | undefined }) => {
  const abort = useAtomSet(abortAtom(useShownSessionId()));

  if (agent?.status !== "working") return null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="size-7 px-0"
      aria-label={`Stop ${agent.id}`}
      title={`Stop ${agent.id}`}
      onClick={() => {
        abort({ conversationId: agent.conversationId });
      }}
    >
      <Square />
    </Button>
  );
};

type CardProps = {
  subagent: StartedSubagent;
  args: ToolCallMessagePartProps["args"];
  /** The transcript's messages, for the thread inside. */
  messages: ReactNode;
};

/**
 * The card of a subagent: its ID, role and model, and its status from the task graph. Opening it watches the agent's
 * conversation, and closing it stops, so a long list of subagents costs one watch per open card. Whether it is open is
 * kept in the Session's layout. Like a tool card's, its line sticks to the top of the transcript while the opened card
 * runs past it; the group is named so the tool cards in its thread do not read as open with it.
 */
export const SubagentCard = ({ subagent, args, messages }: CardProps) => {
  const sessionId = useShownSessionId();

  const [open, setOpen] = useAtom(
    subagentCardOpenAtom(useShownLayoutKey(), subagent.conversationId),
  );

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
      className="group/subagent my-2 rounded-md border"
    >
      <summary
        onClick={keepClosedInView}
        className="sticky top-0 z-[1] flex cursor-pointer list-none items-center gap-2 rounded-md bg-background px-3 py-1.5 text-sm text-muted-foreground select-none group-open/subagent:rounded-b-none group-open/subagent:border-b [&::-webkit-details-marker]:hidden"
      >
        <ChevronRight
          className="size-3.5 transition-transform group-open/subagent:rotate-90"
          aria-hidden
        />
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
        <OpenPageLink agentId={subagent.agentId} className="-my-1 -mr-1.5" />
      </summary>
      {open && (
        <div className="isolate px-3 py-2">
          <ChildThread conversationId={subagent.conversationId} messages={messages} />
        </div>
      )}
    </details>
  );
};
