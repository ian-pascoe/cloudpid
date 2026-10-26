// The Activity card (GLOSSARY.md → Activity card): a small card over the top right of the chat that follows the root
// agent's Todo List and the Session's subagents while the owner reads. Collapsed, it is a pill with the list's progress
// and the Todo Item in progress; expanded, the list and the subagents, each opening the Subagents Pane at that agent.
// Whether it is expanded is kept in the Session's layout (`session-layout.ts` → `activityExpanded`).

import type { GraphAgent, TodoTask } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Bot, ChevronUp, ListChecks, PanelRightOpen } from "lucide-react";
import { type Ref, useEffect, useRef } from "react";
import { cn } from "../lib/utils.ts";
import { mdScreenAtom } from "../media-query.ts";
import { SUBAGENTS_PANE } from "../panes.ts";
import { panesAtom } from "../panes-state.ts";
import { sessionStatusAtom, taskGraphAtom, todosAtom } from "../session/atoms.ts";
import { todoProgress } from "../session/todos.ts";
import { activityExpanded, todoItemsOf } from "../session-layout.ts";
import { sessionLayoutAtom } from "../session-layout-state.ts";
import { useShownSessionId } from "./conversation.ts";
import { AgentStatus } from "./subagent-card.tsx";
import { showAgentAtom } from "./subagents-state.ts";
import { TodoList } from "./todo-list.tsx";

/** The Todo Item the pill names: the one in progress, else the next one to do; undefined when all are done. */
const currentItem = (items: readonly TodoTask[]): TodoTask | undefined =>
  Option.getOrUndefined(
    Option.orElse(
      Arr.findFirst(items, (item) => item.status === "active"),
      () => Arr.findFirst(items, (item) => item.status === "pending"),
    ),
  );

/** The paper the card and the pill are drawn on. */
const PAPER = "pointer-events-auto rounded-lg border bg-background/95 shadow-lg backdrop-blur-sm";

/** What the card says while the socket is not live: what it shows may be behind. */
const STALE = "Reconnecting: this may be out of date.";

const Pill = ({
  items,
  agents,
  live,
  onExpand,
  ref,
}: {
  items: readonly TodoTask[];
  agents: readonly GraphAgent[];
  live: boolean;
  onExpand: () => void;
  ref: Ref<HTMLButtonElement>;
}) => {
  const { total, completed } = todoProgress(items);
  const current = currentItem(items);
  const working = Arr.filter(agents, (agent) => agent.status === "working").length;

  return (
    <button
      ref={ref}
      type="button"
      aria-expanded={false}
      aria-label="Show the todo list and subagents"
      title={live ? "Show the todo list and subagents" : STALE}
      onClick={onExpand}
      className={cn(
        PAPER,
        "flex max-w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent",
      )}
    >
      {!live && <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground" aria-hidden />}
      {total > 0 && (
        <span className="flex min-w-0 items-center gap-1.5">
          <ListChecks className="size-3.5 shrink-0" aria-hidden />
          <span className="font-medium text-foreground tabular-nums">
            {completed}/{total}
          </span>
          <span className="max-w-48 truncate">{current?.title ?? "All done"}</span>
        </span>
      )}
      {total > 0 && agents.length > 0 && <span aria-hidden>·</span>}
      {agents.length > 0 && (
        <span className="flex shrink-0 items-center gap-1.5">
          <Bot className="size-3.5" aria-hidden />
          <span className="tabular-nums">
            {working > 0
              ? `${working} working`
              : `${agents.length} ${agents.length === 1 ? "subagent" : "subagents"}`}
          </span>
        </span>
      )}
    </button>
  );
};

/** A subagent on the card: opens the Subagents Pane with its row open and in sight. */
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

const Card = ({
  items,
  agents,
  live,
  onCollapse,
  ref,
}: {
  items: readonly TodoTask[];
  agents: readonly GraphAgent[];
  live: boolean;
  onCollapse: () => void;
  ref: Ref<HTMLButtonElement>;
}) => {
  const actOnPanes = useAtomSet(panesAtom);

  return (
    <section aria-label="Activity" className={cn(PAPER, "flex w-80 max-w-full flex-col")}>
      <header className="flex items-center gap-2 border-b py-1 pr-1 pl-3">
        <h3 className="flex-1 text-xs font-medium text-muted-foreground">Activity</h3>
        <button
          ref={ref}
          type="button"
          aria-expanded
          aria-label="Collapse the todo list and subagents"
          title="Collapse"
          onClick={onCollapse}
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent [&_svg]:size-4"
        >
          <ChevronUp />
        </button>
      </header>
      <div className="flex max-h-[min(28rem,60vh)] flex-col gap-3 overflow-y-auto px-3 py-2">
        {!live && (
          <p role="status" className="text-xs text-muted-foreground">
            {STALE}
          </p>
        )}
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
      </div>
    </section>
  );
};

/** The card over `items` and `agents`, expanded or not as the Session's layout says. */
const Activity = ({
  items,
  agents,
  live,
}: {
  items: readonly TodoTask[];
  agents: readonly GraphAgent[];
  /** Whether the socket is live; else what the card shows may be behind. */
  live: boolean;
}) => {
  const sessionId = useShownSessionId();
  const wide = useAtomValue(mdScreenAtom);
  const [layout, setLayout] = useAtom(sessionLayoutAtom(sessionId));
  const pill = useRef<HTMLButtonElement>(null);
  const collapse = useRef<HTMLButtonElement>(null);
  // Set when the owner expands or collapses the card, so the focus follows to the button now in place of theirs.
  const toggled = useRef(false);

  const { total, completed } = todoProgress(items);
  const listed = todoItemsOf(items);
  const settled = completed === total && !Arr.some(agents, (agent) => agent.status === "working");
  const expanded = activityExpanded({ choice: layout.activity, items: listed, wide, settled });

  useEffect(() => {
    if (!toggled.current) return;

    toggled.current = false;
    (expanded ? collapse : pill).current?.focus();
  }, [expanded]);

  const setExpanded = (next: boolean) => {
    toggled.current = true;
    setLayout({ activity: { expanded: next, items: listed, settled } });
  };

  return (
    <div className="pointer-events-none absolute top-3 right-3 z-10 flex max-w-[calc(100%-1.5rem)] justify-end">
      {expanded ? (
        <Card
          ref={collapse}
          items={items}
          agents={agents}
          live={live}
          onCollapse={() => {
            setExpanded(false);
          }}
        />
      ) : (
        <Pill
          ref={pill}
          items={items}
          agents={agents}
          live={live}
          onExpand={() => {
            setExpanded(true);
          }}
        />
      )}
    </div>
  );
};

/** The Activity card of the Session shown; nothing while it has neither a Todo List nor a subagent. */
export const ActivityCard = () => {
  const sessionId = useShownSessionId();
  const items = useAtomValue(todosAtom(sessionId));
  const graph = useAtomValue(taskGraphAtom(sessionId));
  const live = useAtomValue(sessionStatusAtom(sessionId), (status) => status === "live");
  const agents = graph?.agents ?? [];

  if (items.length === 0 && agents.length === 0) return null;

  return <Activity items={items} agents={agents} live={live} />;
};
