// Session details (GLOSSARY.md → Session details): a small panel over the top right of the chat with what the owner
// follows of the Session while reading, in sections: the root agent's Todo List, the Session's subagents, each
// subagent opening its Subagent Pane (or its Subagent page), and the Changes in its Workspace, each file opening the
// Diff pane at it, the Session's grants for MCP servers' Sampling requests, and the Resource watches its agent holds. On a Subagent page they are the subagent's: its Todo List, the subagents below it, and the Changes
// of its Workspace. An icon button in the page's header opens and closes it, whatever there is to show; whether it is
// open is kept in the page's layout.

import type {
  GraphAgent,
  McpSamplingSessionGrant,
  McpWatchEntry,
  TodoTask,
} from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { PanelRightOpen, SquareMenu, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import { Button } from "../components/ui/button.tsx";
import { ChangesSection } from "../diff-pane/changes-summary.tsx";
import { changesTotalsAtom } from "../diff-pane/watch.ts";
import { cn } from "../lib/utils.ts";
import { SUBAGENTS_PANE, subagentPaneKey } from "../panes.ts";
import { panesAtom } from "../panes-state.ts";
import { childrenOf } from "../session/agents.ts";
import {
  conversationTodosAtom,
  endMcpWatchAtom,
  mcpSamplingGrantsAtom,
  mcpTasksAtom,
  mcpWatchesAtom,
  revokeMcpSamplingAtom,
  sessionStatusAtom,
  taskGraphAtom,
} from "../session/atoms.ts";
import { detailsOpenAtom } from "../session-layout-state.ts";
import {
  conversationKey,
  useShownChanges,
  useShownLayoutKey,
  useShownSessionId,
  useShownSubagent,
} from "./conversation.ts";
import { followedTasks, followingLabel, liveTasks } from "./mcp-task.ts";
import { McpTaskStrip } from "./mcp-task-strip.tsx";
import { AgentStatus, OpenPageLink } from "./subagent-card.tsx";
import { TodoList } from "./todo-list.tsx";
import { WatchedResources } from "./watched-resources.tsx";

/** The panel's element, which the header's button controls: a Session page has one. */
const PANEL_ID = "session-details";

/** The header's button, which takes the focus back when the panel closes from inside. */
const BUTTON_ID = "session-details-button";

/**
 * What the page shown has to follow: the root's Todo List and every subagent on the Session page; on a Subagent page,
 * the subagent's Todo List (from the page's watch of its conversation) and the subagents it started (its Subagents Pane
 * lists the whole subtree).
 */
const useDetails = () => {
  const sessionId = useShownSessionId();
  const subagent = useShownSubagent();

  const items = useAtomValue(
    conversationTodosAtom(conversationKey(sessionId, subagent?.conversationId)),
  );

  const graph = useAtomValue(taskGraphAtom(sessionId));
  const following = useAtomValue(mcpTasksAtom(sessionId), (tasks) => followedTasks(tasks).length);

  return {
    following,
    items,
    agents: subagent === undefined ? (graph?.agents ?? []) : childrenOf(graph, subagent.agentId),
  };
};

/** Whether anything is going on: a Todo Item not done, a subagent working, or an MCP task followed. */
const busy = (
  items: readonly TodoTask[],
  agents: readonly GraphAgent[],
  following: number,
): boolean =>
  Arr.some(items, (item) => item.status !== "completed") ||
  Arr.some(agents, (agent) => agent.status === "working") ||
  following > 0;

/**
 * The header's button for Session details: it opens and closes them (Escape on it closes them too), and, while they are
 * closed, carries a dot when something is going on. Changes are not something going on: they light no dot.
 */
export const SessionDetailsButton = () => {
  const [open, setOpen] = useAtom(detailsOpenAtom(useShownLayoutKey()));
  const { items, agents, following } = useDetails();
  const dot = !open && busy(items, agents, following);
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

/**
 * A subagent in Session details: opens its Subagent Pane, or shows it where it is open; the icon beside it opens its
 * Subagent page.
 */
const AgentButton = ({ agent }: { agent: GraphAgent }) => {
  const actOnPanes = useAtomSet(panesAtom);

  return (
    <li className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => {
          actOnPanes({ type: "open", key: subagentPaneKey(agent.conversationId) });
        }}
        title={`Open ${agent.id} in a pane`}
        className="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-accent"
      >
        <span className="min-w-0 truncate font-mono text-[0.8125rem]">{agent.id}</span>
        {agent.role !== null && (
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs">{agent.role}</span>
        )}
        <span className="ml-auto shrink-0">
          <AgentStatus agent={agent} />
        </span>
      </button>
      <OpenPageLink agentId={agent.id} className="rounded" />
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

/** What a Session grant says; an action a later build adds reads neutrally, since this build cannot tell what it does. */
const grantText = (grant: McpSamplingSessionGrant): string => {
  switch (grant.action) {
    case "allow":
      return `${grant.server} may use your models in this Session`;
    case "refuse":
      return `${grant.server} is refused your models in this Session`;
    default:
      return `${grant.server} has a choice for models in this Session`;
  }
};

/**
 * The Session's grants for MCP servers' Sampling requests (`docs/architecture/mcp-server-requests.md` → Sampling requests,
 * The card): "Allow in this Session" and "Refuse in this Session", each with a ✕ that takes it back, so the server's next
 * request asks again.
 */
const SamplingGrantsSection = () => {
  const sessionId = useShownSessionId();
  const grants = useAtomValue(mcpSamplingGrantsAtom(sessionId));
  const live = useAtomValue(sessionStatusAtom(sessionId), (status) => status === "live");
  const revoke = useAtomSet(revokeMcpSamplingAtom(sessionId));

  if (grants.length === 0) return null;

  return (
    <section aria-label="Model use">
      <h4 className="text-xs font-medium text-muted-foreground">Model use</h4>
      <ul className="mt-1 text-sm">
        {Arr.map(grants, (grant) => (
          <li key={grant.server} className="flex items-center justify-between gap-2">
            <span className="min-w-0 break-words">{grantText(grant)}</span>
            <button
              type="button"
              disabled={!live}
              aria-label={`Take back this Session's choice for ${grant.server}`}
              title="Take it back: the next request asks again"
              onClick={() => {
                revoke(grant.server);
              }}
              className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3.5"
            >
              <X aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
};

/** The tasks listed of an ended one: the newest few, which the Session keeps 50 of. */
const ENDED_SHOWN = 5;

/**
 * The Session's MCP tasks (`docs/architecture/mcp-server-requests.md` → MCP tasks, The owner's UI): each live one with its
 * status, how long it has gone on and Cancel, and the newest few that ended with how. A subagent's or a script's task is
 * the Session's too: its agent is named.
 */
const McpTasksSection = () => {
  const sessionId = useShownSessionId();
  const tasks = useAtomValue(mcpTasksAtom(sessionId));

  if (tasks.length === 0) return null;

  const shown = [
    ...liveTasks(tasks),
    ...Arr.take(Arr.reverse(Arr.filter(tasks, (task) => task.endedAt !== undefined)), ENDED_SHOWN),
  ];

  return (
    <section aria-label="MCP tasks">
      <h4 className="text-xs font-medium text-muted-foreground">MCP tasks</h4>
      <ul className="mt-1 text-sm">
        {Arr.map(shown, (task) => (
          <li key={task.task} className="py-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate font-mono text-[0.8125rem]" title={task.tool}>
                {task.tool}
              </span>
              {task.agent !== undefined && (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs">
                  {task.agent}
                </span>
              )}
            </div>
            <McpTaskStrip task={task} />
          </li>
        ))}
      </ul>
    </section>
  );
};

/**
 * The header's chip "Following n MCP tasks" while the Session follows some in the background or waits for them: it opens
 * the Session details, which list them. Nothing while it follows none.
 */
export const McpTasksChip = () => {
  const sessionId = useShownSessionId();
  const [open, setOpen] = useAtom(detailsOpenAtom(useShownLayoutKey()));
  const count = useAtomValue(mcpTasksAtom(sessionId), (tasks) => followedTasks(tasks).length);

  if (count === 0) return null;

  return (
    <button
      type="button"
      aria-expanded={open}
      title="Show the MCP tasks"
      onClick={() => {
        setOpen(true);
      }}
      className="hidden shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground sm:flex"
    >
      <span aria-hidden className="pulse-dot size-1.5 rounded-full bg-success" />
      {followingLabel(count)}
    </button>
  );
};

/** The Resource watches the agent holds, as the Session lists them (`./watched-resources.tsx`). */
const WatchedResourcesSection = () => {
  const sessionId = useShownSessionId();
  const watches = useAtomValue(mcpWatchesAtom(sessionId));
  const graph = useAtomValue(taskGraphAtom(sessionId));
  const live = useAtomValue(sessionStatusAtom(sessionId), (status) => status === "live");
  const end = useAtomSet(endMcpWatchAtom(sessionId));

  const holder = (watch: McpWatchEntry): string | undefined =>
    Arr.findFirst(
      graph?.agents ?? [],
      (agent) => agent.conversationId === watch.conversationId,
    ).pipe(
      Option.map((agent) => agent.id),
      Option.getOrUndefined,
    );

  return <WatchedResources watches={watches} holder={holder} live={live} onEnd={end} />;
};

/**
 * The Session details of the Session shown, while the owner has them open: one section per thing to follow, each
 * headed by what it is, with no title of their own. Escape closes them and gives the focus back to the header's button.
 */
export const SessionDetails = () => {
  const sessionId = useShownSessionId();
  const [open, setOpen] = useAtom(detailsOpenAtom(useShownLayoutKey()));
  const { items, agents } = useDetails();
  const live = useAtomValue(sessionStatusAtom(sessionId), (status) => status === "live");
  const changed = useAtomValue(changesTotalsAtom(useShownChanges()), (totals) => totals.files > 0);
  const granted = useAtomValue(mcpSamplingGrantsAtom(sessionId), (grants) => grants.length > 0);
  const tasked = useAtomValue(mcpTasksAtom(sessionId), (tasks) => tasks.length > 0);
  const watched = useAtomValue(mcpWatchesAtom(sessionId), (watches) => watches.length > 0);

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
      className="absolute top-3 right-3 z-10 flex max-h-[min(28rem,60vh)] w-80 max-w-[calc(100%-1.5rem)] flex-col divide-y overflow-y-auto overscroll-y-contain rounded-lg border bg-background/95 shadow-lg backdrop-blur-sm *:px-3 *:py-2.5"
    >
      {!live && (
        <p role="status" className="text-xs text-muted-foreground">
          Reconnecting: this may be out of date.
        </p>
      )}
      {items.length === 0 && agents.length === 0 && !changed && !granted && !tasked && !watched && (
        <p className="text-sm text-muted-foreground">Nothing to show yet.</p>
      )}
      {items.length > 0 && <TodoList tasks={items} />}
      {agents.length > 0 && <SubagentsSection agents={agents} />}
      {changed && <ChangesSection />}
      <McpTasksSection />
      <SamplingGrantsSection />
      <WatchedResourcesSection />
    </aside>
  );
};
