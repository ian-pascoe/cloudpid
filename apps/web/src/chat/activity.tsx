// The Activity overlay (GLOSSARY.md → Activity overlay): a small paper over the top right of the chat that follows the
// root agent's Todo List and the Session's subagents while the owner reads, each subagent opening the Subagents Pane at
// it. An icon button in the Session's header opens and closes it, whatever there is to show; whether it is open is kept
// in the Session's layout.

import type { GraphAgent, TodoTask } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import { ListChecks, PanelRightOpen, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { Button } from "../components/ui/button.tsx";
import { cn } from "../lib/utils.ts";
import { SUBAGENTS_PANE } from "../panes.ts";
import { panesAtom } from "../panes-state.ts";
import { sessionStatusAtom, taskGraphAtom, todosAtom } from "../session/atoms.ts";
import { activityOpenAtom } from "../session-layout-state.ts";
import { useShownSessionId } from "./conversation.ts";
import { AgentStatus } from "./subagent-card.tsx";
import { showAgentAtom } from "./subagents-state.ts";
import { TodoList } from "./todo-list.tsx";

/** The overlay's element, which the header's button controls: a Session page has one. */
const OVERLAY_ID = "activity-overlay";

/** The header's button, which takes the focus back when the overlay closes from inside. */
const BUTTON_ID = "activity-button";

const focusButton = () => {
  document.getElementById(BUTTON_ID)?.focus();
};

/** What the Session shown has to follow: the root's Todo List and the subagents. */
const useActivity = () => {
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
 * The header's button for the Activity overlay: it opens and closes it, and, while it is closed, carries a dot when
 * something is going on.
 */
export const ActivityButton = () => {
  const [open, setOpen] = useAtom(activityOpenAtom(useShownSessionId()));
  const { items, agents } = useActivity();
  const dot = !open && busy(items, agents);
  const label = open ? "Hide todos and subagents" : "Show todos and subagents";

  return (
    <Button
      id={BUTTON_ID}
      type="button"
      variant="ghost"
      size="icon"
      aria-label={dot ? `${label} (in progress)` : label}
      aria-expanded={open}
      aria-controls={open ? OVERLAY_ID : undefined}
      title={label}
      onClick={() => {
        setOpen(!open);
      }}
      className={cn("relative size-8 text-muted-foreground", open && "bg-accent text-foreground")}
    >
      <ListChecks />
      {dot && (
        <span
          aria-hidden
          className="absolute top-1 right-1 size-1.5 rounded-full bg-primary ring-2 ring-background"
        />
      )}
    </Button>
  );
};

/** A subagent on the overlay: opens the Subagents Pane with its row open and in sight. */
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

/** The Activity overlay of the Session shown, while the owner has it open. */
export const ActivityOverlay = () => {
  const sessionId = useShownSessionId();
  const [open, setOpen] = useAtom(activityOpenAtom(sessionId));
  const { items, agents } = useActivity();
  const live = useAtomValue(sessionStatusAtom(sessionId), (status) => status === "live");
  const actOnPanes = useAtomSet(panesAtom);

  if (!open) return null;

  const close = () => {
    setOpen(false);
    focusButton();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;

    event.preventDefault();
    close();
  };

  return (
    <section
      id={OVERLAY_ID}
      aria-label="Todos and subagents"
      onKeyDown={onKeyDown}
      className="absolute top-3 right-3 z-10 flex w-80 max-w-[calc(100%-1.5rem)] flex-col rounded-lg border bg-background/95 shadow-lg backdrop-blur-sm"
    >
      <header className="flex items-center gap-2 border-b py-1 pr-1 pl-3">
        <h3 className="flex-1 text-xs font-medium text-muted-foreground">Todos and subagents</h3>
        <button
          type="button"
          aria-label="Close"
          title="Close"
          onClick={close}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent [&_svg]:size-4"
        >
          <X />
        </button>
      </header>
      <div className="flex max-h-[min(28rem,60vh)] flex-col gap-3 overflow-y-auto px-3 py-2">
        {!live && (
          <p role="status" className="text-xs text-muted-foreground">
            Reconnecting: this may be out of date.
          </p>
        )}
        {items.length === 0 && agents.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">No todos or subagents yet.</p>
        ) : (
          <>
            <TodoList tasks={items} />
            {agents.length > 0 && (
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
            )}
          </>
        )}
      </div>
    </section>
  );
};
