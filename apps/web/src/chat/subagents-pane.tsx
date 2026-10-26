// The Subagents Pane: the Session's subagents (each openable into its thread, its header with its Subagent Workspace's
// branch when it has one) and the background tasks running, from the task graph the Session streams. The Todo List is
// in the Session details, over the chat (`session-details.tsx`).

import * as Arr from "effect/Array";
import type { GraphAgent, GraphBackgroundTask } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Square } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "../components/ui/button.tsx";
import { canStopAllBelow, depthOf, workingBelow } from "../session/agents.ts";
import { abortAtom, sessionViewAtom, taskGraphAtom } from "../session/atoms.ts";
import { agentRowOpenAtom } from "../session-layout-state.ts";
import { ChildThread } from "./child-thread.tsx";
import { useShownSessionId } from "./conversation.ts";
import { Messages } from "./messages.tsx";
import { AgentBranch, AgentStatus, shortModel } from "./subagent-card.tsx";
import { revealedAgentAtom } from "./subagents-state.ts";

/** How a background task's kind reads; one the page does not know shows as it is. */
const kindLabel = (kind: string): string =>
  kind === "pi.compaction" ? "Compacting context" : kind;

type RowProps = { agent: GraphAgent; depth: number };

const AgentRow = ({ agent, depth }: RowProps) => {
  const sessionId = useShownSessionId();
  const abort = useAtomSet(abortAtom(sessionId));
  const [open, setOpen] = useAtom(agentRowOpenAtom(sessionId, agent.conversationId));
  const [revealed, setRevealed] = useAtom(revealedAgentAtom(sessionId));
  const row = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (revealed !== agent.conversationId) return;

    row.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    setRevealed(null);
  }, [revealed, agent.conversationId, setRevealed]);

  return (
    <li ref={row} className="scroll-mt-3">
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

const BackgroundRow = ({ task }: { task: GraphBackgroundTask }) => (
  <li className="flex items-center gap-2 py-1 text-sm">
    <span className="min-w-0 flex-1 truncate">{kindLabel(task.kind)}</span>
    <span className="font-mono text-xs text-muted-foreground">{task.agent}</span>
    <span className="text-xs text-muted-foreground">
      {task.aborting ? "Stopping" : task.state === "waiting" ? "Waiting" : "Running"}
    </span>
  </li>
);

/** How many agents below the root of the Session shown are working, for the Pane area's button and the New pane. */
export const useSubagentsWorking = (): number =>
  useAtomValue(taskGraphAtom(useShownSessionId()), (graph) => workingBelow(graph, "root").length);

/** The Subagents Pane: the task graph, with Stop all while something below the root can be stopped. */
export const SubagentsPane = () => {
  const sessionId = useShownSessionId();
  const abort = useAtomSet(abortAtom(sessionId));
  const graph = useAtomValue(taskGraphAtom(sessionId));
  const running = useAtomValue(sessionViewAtom(sessionId), (view) => view.running);
  const stoppable = canStopAllBelow(graph, "root", running);
  const [revealed, setRevealed] = useAtom(revealedAgentAtom(sessionId));

  // An agent asked to be brought into sight that has no row (it is gone) is forgotten, so its row, if it comes back,
  // does not scroll to itself unasked.
  useEffect(() => {
    if (
      revealed !== null &&
      graph !== null &&
      !Arr.some(graph.agents, (agent) => agent.conversationId === revealed)
    ) {
      setRevealed(null);
    }
  }, [revealed, graph, setRevealed]);

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
      {graph === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : graph.agents.length === 0 && graph.background.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No subagents yet. Subagents and background work show here.
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
