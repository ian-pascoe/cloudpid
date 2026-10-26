// The Activity card: a small card over the top right of the chat that follows the root agent's Todo List and the
// Session's subagents while the owner reads. Collapsed, it is a pill with the progress and the Task in progress;
// expanded, the list and the subagents, each opening the Subagents Pane at that agent. Whether it is expanded is kept in
// the Session's layout (`session-layout.ts` → `activityExpanded`).

import type { GraphAgent, TodoTask } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Bot, ChevronUp, ListChecks, PanelRightOpen } from "lucide-react";
import { cn } from "../lib/utils.ts";
import { SUBAGENTS_PANE } from "../panes.ts";
import { panesAtom } from "../panes-state.ts";
import { sessionStatusAtom, taskGraphAtom, todosAtom } from "../session/atoms.ts";
import { todoProgress } from "../session/todos.ts";
import { activityExpanded, todoListOf, withOpen } from "../session-layout.ts";
import { mdScreenAtom, sessionLayoutAtom } from "../session-layout-state.ts";
import { useShownSessionId } from "./conversation.ts";
import { AgentStatus } from "./subagent-card.tsx";
import { revealedAgentAtom } from "./subagents-pane.tsx";
import { TodoList } from "./todo-list.tsx";

/** The Task the pill names: the one in progress, else the next one to do; undefined when all are done. */
const currentTask = (tasks: readonly TodoTask[]): TodoTask | undefined =>
  Option.getOrUndefined(
    Option.orElse(
      Arr.findFirst(tasks, (task) => task.status === "active"),
      () => Arr.findFirst(tasks, (task) => task.status === "pending"),
    ),
  );

/** The paper the card and the pill are drawn on. */
const PAPER = "pointer-events-auto rounded-lg border bg-background/95 shadow-lg backdrop-blur-sm";

const Pill = ({
  tasks,
  working,
  agents,
  onExpand,
}: {
  tasks: readonly TodoTask[];
  working: number;
  agents: number;
  onExpand: () => void;
}) => {
  const { total, completed } = todoProgress(tasks);
  const current = currentTask(tasks);

  return (
    <button
      type="button"
      aria-expanded={false}
      aria-label="Show the todo list and subagents"
      title="Show the todo list and subagents"
      onClick={onExpand}
      className={cn(
        PAPER,
        "flex max-w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent",
      )}
    >
      {total > 0 && (
        <span className="flex min-w-0 items-center gap-1.5">
          <ListChecks className="size-3.5 shrink-0" aria-hidden />
          <span className="font-medium text-foreground tabular-nums">
            {completed}/{total}
          </span>
          <span className="max-w-48 truncate">{current?.title ?? "All done"}</span>
        </span>
      )}
      {total > 0 && agents > 0 && <span aria-hidden>·</span>}
      {agents > 0 && (
        <span className="flex shrink-0 items-center gap-1.5">
          <Bot className="size-3.5" aria-hidden />
          <span className="tabular-nums">
            {working > 0 ? `${working} working` : `${agents} idle`}
          </span>
        </span>
      )}
    </button>
  );
};

const AgentButton = ({ agent, onOpen }: { agent: GraphAgent; onOpen: () => void }) => (
  <li>
    <button
      type="button"
      onClick={onOpen}
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

/** The Activity card of the Session shown; nothing while it has neither a Todo List nor a subagent. */
export const ActivityCard = () => {
  const sessionId = useShownSessionId();
  const tasks = useAtomValue(todosAtom(sessionId));
  const graph = useAtomValue(taskGraphAtom(sessionId));
  const live = useAtomValue(sessionStatusAtom(sessionId), (status) => status === "live");
  const agents = graph?.agents ?? [];

  if (tasks.length === 0 && agents.length === 0) return null;

  return <Activity tasks={tasks} agents={agents} live={live} />;
};

/** The card over `tasks` and `agents`, expanded or not as the Session's layout says. */
const Activity = ({
  tasks,
  agents,
  live,
}: {
  tasks: readonly TodoTask[];
  agents: readonly GraphAgent[];
  /** Whether the socket is live; else the list may be behind. */
  live: boolean;
}) => {
  const sessionId = useShownSessionId();
  const wide = useAtomValue(mdScreenAtom);
  const [layout, setLayout] = useAtom(sessionLayoutAtom(sessionId));
  const actOnPanes = useAtomSet(panesAtom);
  const reveal = useAtomSet(revealedAgentAtom(sessionId));

  const { total, completed } = todoProgress(tasks);
  const working = Arr.filter(agents, (agent) => agent.status === "working").length;
  const list = todoListOf(tasks);

  const expanded = activityExpanded({
    choice: layout.activity,
    list,
    wide,
    settled: completed === total && working === 0,
  });

  const setExpanded = (next: boolean) => {
    setLayout((current) => ({ ...current, activity: { expanded: next, list } }));
  };

  // Opens the agent's row in the Subagents Pane, shows the Pane and brings the row into sight.
  const openAgent = (agent: GraphAgent) => {
    setLayout((current) => ({
      ...current,
      openAgents: withOpen(current.openAgents, agent.conversationId, true),
    }));
    reveal(agent.conversationId);
    actOnPanes({ type: "open", key: SUBAGENTS_PANE });
  };

  return (
    <div className="pointer-events-none absolute top-3 right-3 z-10 flex max-w-[calc(100%-1.5rem)] justify-end">
      {expanded ? (
        <section aria-label="Activity" className={cn(PAPER, "flex w-80 max-w-full flex-col")}>
          <header className="flex items-center gap-2 border-b py-1 pr-1 pl-3">
            <h3 className="flex-1 text-xs font-medium text-muted-foreground">Activity</h3>
            <button
              type="button"
              aria-expanded
              aria-label="Collapse the todo list and subagents"
              title="Collapse"
              onClick={() => {
                setExpanded(false);
              }}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent [&_svg]:size-4"
            >
              <ChevronUp />
            </button>
          </header>
          <div className="flex max-h-[min(28rem,60vh)] flex-col gap-3 overflow-y-auto px-3 py-2">
            <TodoList tasks={tasks} stale={!live} />
            {agents.length > 0 && (
              <section aria-label="Subagents">
                <h4 className="flex items-center justify-between text-xs font-medium text-muted-foreground">
                  <span>Subagents</span>
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
                </h4>
                <ul className="mt-1 -mx-1.5">
                  {Arr.map(agents, (agent) => (
                    <AgentButton
                      key={agent.id}
                      agent={agent}
                      onOpen={() => {
                        openAgent(agent);
                      }}
                    />
                  ))}
                </ul>
              </section>
            )}
          </div>
        </section>
      ) : (
        <Pill
          tasks={tasks}
          working={working}
          agents={agents.length}
          onExpand={() => {
            setExpanded(true);
          }}
        />
      )}
    </div>
  );
};
