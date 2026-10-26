// Session details (GLOSSARY.md → Session details): a small panel over the top right of the chat with what the owner
// follows of the Session while reading, in sections: the root agent's Todo List and the Session's subagents, each
// subagent opening the Subagents Pane at it. An icon button in the Session's header opens and closes it, whatever there
// is to show; whether it is open is kept in the Session's layout.

import type { GraphAgent, TodoTask } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import { PanelRightOpen, SquareMenu } from "lucide-react";
import type { KeyboardEvent } from "react";
import { Button } from "../components/ui/button.tsx";
import { cn } from "../lib/utils.ts";
import { SUBAGENTS_PANE } from "../panes.ts";
import { panesAtom } from "../panes-state.ts";
import { sessionStatusAtom, taskGraphAtom, todosAtom } from "../session/atoms.ts";
import { detailsOpenAtom } from "../session-layout-state.ts";
import { useShownSessionId } from "./conversation.ts";
import { AgentStatus } from "./subagent-card.tsx";
import { showAgentAtom } from "./subagents-state.ts";
import { TodoList } from "./todo-list.tsx";

/** The panel's element, which the header's button controls: a Session page has one. */
const PANEL_ID = "session-details";

/** The header's button, which takes the focus back when the panel closes from inside. */
const BUTTON_ID = "session-details-button";

/** What the Session shown has to follow: the root's Todo List and the subagents. */
const useDetails = () => {
  const sessionId = useShownSessionId();
  const items = useAtomValue(todosAtom(sessionId));
  const graph = useAtomValue(taskGraphAtom(sessionId));

  return { items, agents: graph?.agents ?? [] };
};

/** Whether anything is going on: a Todo Item not done, or a subagent working. */
const busy = (items: readonly TodoTask[], agents: readonly GraphAgent[]): boolean =>
  Arr.some(items, (item) => item.status !== "completed") ||
  Arr.some(agents, (agent) => agent.status === "working");

/**
 * The header's button for Session details: it opens and closes them (Escape on it closes them too), and, while they are
 * closed, carries a dot when something is going on.
 */
export const SessionDetailsButton = () => {
  const [open, setOpen] = useAtom(detailsOpenAtom(useShownSessionId()));
  const { items, agents } = useDetails();
  const dot = !open && busy(items, agents);
  const label = open ? "Hide session details" : "Show session details";

  return (
    <Button
      id={BUTTON_ID}
      type="button"
      variant="ghost"
      size="icon"
      aria-label={dot ? `${label} (in progress)` : label}
      aria-expanded={open}
      aria-controls={open ? PANEL_ID : undefined}
      title={label}
      onClick={() => {
        setOpen(!open);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;

        event.preventDefault();
        setOpen(false);
      }}
      className={cn("relative size-8 text-muted-foreground", open && "bg-accent text-foreground")}
    >
      <SquareMenu />
      {dot && (
        <span
          aria-hidden
          className="absolute top-1 right-1 size-1.5 rounded-full bg-primary ring-2 ring-background"
        />
      )}
    </Button>
  );
};

/** A subagent in Session details: opens the Subagents Pane with its row open and in sight. */
const AgentButton = ({ agent }: { agent: GraphAgent }) => {
  const show = useAtomSet(showAgentAtom(useShownSessionId()));

  return (
    <li>
      <button
        type="button"
        onClick={() => {
          show(agent.conversationId);
        }}
        title={`Open ${agent.id} in the Subagents pane`}
        className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-accent"
      >
        <span className="min-w-0 truncate font-mono text-[0.8125rem]">{agent.id}</span>
        {agent.role !== null && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs">{agent.role}</span>
        )}
        <span className="ml-auto shrink-0">
          <AgentStatus agent={agent} />
        </span>
      </button>
    </li>
  );
};

/** The Session's subagents, with a way to their Pane. */
const SubagentsSection = ({ agents }: { agents: readonly GraphAgent[] }) => {
  const actOnPanes = useAtomSet(panesAtom);

  return (
    <section aria-label="Subagents">
      <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
        <h4>Subagents</h4>
        <button
          type="button"
          onClick={() => {
            actOnPanes({ type: "open", key: SUBAGENTS_PANE });
          }}
          className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
        >
          <PanelRightOpen aria-hidden />
          Open pane
        </button>
      </div>
      <ul className="mt-1 -mx-1.5">
        {Arr.map(agents, (agent) => (
          <AgentButton key={agent.id} agent={agent} />
        ))}
      </ul>
    </section>
  );
};

/**
 * The Session details of the Session shown, while the owner has them open: one section per thing to follow, each
 * headed by what it is, with no title of their own. Escape closes them and gives the focus back to the header's button.
 */
export const SessionDetails = () => {
  const sessionId = useShownSessionId();
  const [open, setOpen] = useAtom(detailsOpenAtom(sessionId));
  const { items, agents } = useDetails();
  const live = useAtomValue(sessionStatusAtom(sessionId), (status) => status === "live");

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;

    event.preventDefault();
    setOpen(false);
    document.getElementById(BUTTON_ID)?.focus();
  };

  return (
    <aside
      id={PANEL_ID}
      aria-label="Session details"
      onKeyDown={onKeyDown}
      className="absolute top-3 right-3 z-10 flex max-h-[min(28rem,60vh)] w-80 max-w-[calc(100%-1.5rem)] flex-col divide-y overflow-y-auto rounded-lg border bg-background/95 shadow-lg backdrop-blur-sm *:px-3 *:py-2.5"
    >
      {!live && (
        <p role="status" className="text-xs text-muted-foreground">
          Reconnecting: this may be out of date.
        </p>
      )}
      {items.length === 0 && agents.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing to show yet.</p>
      )}
      {items.length > 0 && <TodoList tasks={items} />}
      {agents.length > 0 && <SubagentsSection agents={agents} />}
    </aside>
  );
};
