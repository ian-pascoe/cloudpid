// The Subagents Pane: the Session's subagents (each row with its Subagent Workspace's branch when it has one, and
// opening the agent's conversation in a Subagent Pane of its own, `subagent-pane.tsx`) and the background tasks
// running, from the task graph the Session streams. On a Subagent page it lists that subagent's subtree, and the
// background work of it and below it. The Todo List is in the Session details, over the chat (`session-details.tsx`).

import * as Arr from "effect/Array";
import type { GraphAgent, GraphBackgroundTask } from "@cloudpid/protocol";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Square } from "lucide-react";
import { Button } from "../components/ui/button.tsx";
import { subagentPaneKey } from "../panes.ts";
import { panesAtom } from "../panes-state.ts";
import { canStopAllBelow, depthOf, subtreeGraph, workingBelow } from "../session/agents.ts";
import { abortAtom, conversationRunningAtom, taskGraphAtom } from "../session/atoms.ts";
import {
  conversationKey,
  useShownAgentId,
  useShownSessionId,
  useShownSubagent,
} from "./conversation.ts";
import { AgentStatus, AgentStopButton, AgentSummary } from "./subagent-card.tsx";

/** How a background task's kind reads; one the page does not know shows as it is. */
const kindLabel = (kind: string): string =>
  kind === "pi.compaction" ? "Compacting context" : kind;

type RowProps = { agent: GraphAgent; depth: number };

const AgentRow = ({ agent, depth }: RowProps) => {
  const actOnPanes = useAtomSet(panesAtom);

  return (
    <li>
      <div className="flex items-center gap-2 py-1" style={{ paddingLeft: `${depth * 0.75}rem` }}>
        <button
          type="button"
          title={`Open ${agent.id}`}
          onClick={() => {
            actOnPanes({ type: "open", key: subagentPaneKey(agent.conversationId) });
          }}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-accent"
        >
          <AgentSummary agent={agent} />
        </button>
        <AgentStatus agent={agent} />
        <AgentStopButton agent={agent} />
      </div>
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

/**
 * How many agents below the one the page shows (the root, or a Subagent page's subagent) are working, for the Pane
 * area's button and the New pane.
 */
export const useSubagentsWorking = (): number => {
  const agentId = useShownAgentId();

  return useAtomValue(
    taskGraphAtom(useShownSessionId()),
    (graph) => workingBelow(graph, agentId).length,
  );
};

/**
 * The Subagents Pane: the task graph (below the subagent, on a Subagent page), with Stop all while something below can
 * be stopped.
 */
export const SubagentsPane = () => {
  const sessionId = useShownSessionId();
  const subagent = useShownSubagent();
  const agentId = useShownAgentId();
  const abort = useAtomSet(abortAtom(sessionId));
  const whole = useAtomValue(taskGraphAtom(sessionId));

  const running = useAtomValue(
    conversationRunningAtom(conversationKey(sessionId, subagent?.conversationId)),
  );

  const stoppable = canStopAllBelow(whole, agentId, running);
  const graph = subtreeGraph(whole, agentId);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 py-3">
      {stoppable && (
        <div className="mb-3 flex justify-end">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            title={
              subagent === undefined
                ? "Stop every subagent"
                : `Stop ${subagent.agentId} and every subagent below it`
            }
            onClick={() => {
              abort(
                subagent === undefined
                  ? { subagents: true }
                  : { conversationId: subagent.conversationId, subagents: true },
              );
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
                  <AgentRow
                    key={agent.id}
                    agent={agent}
                    // On a Subagent page, depth counts from its subagent: its children are the first level.
                    depth={depthOf(whole ?? graph, agent, agentId)}
                  />
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
