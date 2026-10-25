// The Tasks Pane: the Session's live work, its Todo List, its subagents (each openable into its thread, its header with
// its Subagent Workspace's branch when it has one) and the background tasks running, from the task graph the Session
// streams.

import * as Arr from "effect/Array";
import type { GraphAgent, GraphBackgroundTask } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Atom from "effect/reactivity/Atom";
import { Square } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import { canStopAllBelow, depthOf, workingBelow } from "../session/agents.ts";
import {
  abortAtom,
  sessionStatusAtom,
  sessionViewAtom,
  taskGraphAtom,
  todosAtom,
} from "../session/atoms.ts";
import { ChildThread } from "./child-thread.tsx";
import { useShownSessionId } from "./conversation.ts";
import { Messages } from "./messages.tsx";
import { AgentBranch, AgentStatus, shortModel } from "./subagent-card.tsx";
import { TodoList } from "./todo-list.tsx";
import { todoProgress } from "../session/todos.ts";

/** How a background task's kind reads; one the page does not know shows as it is. */
const kindLabel = (kind: string): string =>
  kind === "pi.compaction" ? "Compacting context" : kind;

type RowProps = { agent: GraphAgent; depth: number };

/** Whether one agent's row is open into its thread. */
const RowOpen = ScopedAtom.make(() => Atom.make(false));

const Row = ({ agent, depth }: RowProps) => {
  const abort = useAtomSet(abortAtom(useShownSessionId()));
  const [open, setOpen] = useAtom(RowOpen.use());

  return (
    <li>
      <div className="flex items-center gap-2 py-1" style={{ paddingLeft: `${depth * 0.75}rem` }}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
          }}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-accent"
        >
          <span className="font-mono text-[0.8125rem]">{agent.id}</span>
          {agent.role !== null && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{agent.role}</span>
          )}
          <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
            {shortModel(agent.model)}
          </span>
          <span className="min-w-0 text-muted-foreground">
            <AgentBranch agent={agent} />
          </span>
        </button>
        <AgentStatus agent={agent} />
        {agent.status === "working" && (
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
        )}
      </div>
      {open && (
        <div className="mb-2 rounded-md border px-3 py-2">
          <ChildThread conversationId={agent.conversationId} messages={<Messages />} />
        </div>
      )}
    </li>
  );
};

const AgentRow = (props: RowProps) => (
  <RowOpen.Provider>
    <Row {...props} />
  </RowOpen.Provider>
);

const BackgroundRow = ({ task }: { task: GraphBackgroundTask }) => (
  <li className="flex items-center gap-2 py-1 text-sm">
    <span className="min-w-0 flex-1 truncate">{kindLabel(task.kind)}</span>
    <span className="font-mono text-xs text-muted-foreground">{task.agent}</span>
    <span className="text-xs text-muted-foreground">
      {task.aborting ? "Stopping" : task.state === "waiting" ? "Waiting" : "Running"}
    </span>
  </li>
);

/** What the Session shown has going: agents working below the root, and the Todo List's tasks done of all. */
export interface TasksSummary {
  readonly working: number;
  readonly completed: number;
  readonly total: number;
}

/** The Session shown's `TasksSummary`, for the Pane area's button and the New pane. */
export const useTasksSummary = (): TasksSummary => {
  const sessionId = useShownSessionId();

  const working = useAtomValue(
    taskGraphAtom(sessionId),
    (graph) => workingBelow(graph, "root").length,
  );

  const todos = useAtomValue(todosAtom(sessionId));
  const { total, completed } = todoProgress(todos);

  return { working, completed, total };
};

/** The Tasks Pane: the Todo List, then the task graph, with Stop all while something below the root can be stopped. */
export const TasksPane = () => {
  const sessionId = useShownSessionId();
  const abort = useAtomSet(abortAtom(sessionId));
  const graph = useAtomValue(taskGraphAtom(sessionId));
  const todos = useAtomValue(todosAtom(sessionId));
  const live = useAtomValue(sessionStatusAtom(sessionId), (status) => status === "live");
  const running = useAtomValue(sessionViewAtom(sessionId), (view) => view.running);
  const stoppable = canStopAllBelow(graph, "root", running);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {stoppable && (
        <div className="mb-3 flex justify-end">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            title="Stop every subagent"
            onClick={() => {
              abort({ subagents: true });
            }}
          >
            <Square />
            Stop all
          </Button>
        </div>
      )}
      <TodoList tasks={todos} stale={!live} className="mb-4" />
      {graph === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : graph.agents.length === 0 && graph.background.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing is running. Subagents and background work show here.
        </p>
      ) : (
        <>
          {graph.agents.length > 0 && (
            <section aria-label="Subagents">
              <h4 className="text-xs font-medium text-muted-foreground">Subagents</h4>
              <ul className="mt-1">
                {Arr.map(graph.agents, (agent) => (
                  <AgentRow key={agent.id} agent={agent} depth={depthOf(graph, agent)} />
                ))}
              </ul>
            </section>
          )}
          {graph.background.length > 0 && (
            <section aria-label="Background work" className="mt-4">
              <h4 className="text-xs font-medium text-muted-foreground">Background work</h4>
              <ul className="mt-1">
                {Arr.map(graph.background, (task) => (
                  <BackgroundRow key={task.id} task={task} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
};
