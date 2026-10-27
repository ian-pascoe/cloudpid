// A Session's subagents in the Session list (ADR-0024): the chevron at the left of the Session's row that shows and
// hides them, and their rows, a tree by parent, each opening its Subagent page, with a Stop while it works.

import { type SessionRecord, UNTITLED_SESSION } from "@cloudpid/protocol";
import { useAtomSet } from "@effect/atom-react";
import * as Arr from "effect/Array";
import { ChevronRight, Square } from "lucide-react";
import type { CSSProperties } from "react";
import { InAppLink } from "./in-app-link.tsx";
import { cn } from "./lib/utils.ts";
import { indentOf, type SubagentRow } from "./list-subagents.ts";
import { subagentPath } from "./router.ts";
import { stopAgentAtom } from "./session/atoms.ts";

/**
 * Stops one subagent's conversation from the list (its subagents keep working), through the Session's socket, which it
 * opens for as long as the button is shown if the Session's page does not have it open: the list knows the agent by
 * its ID alone (`stopAgentAtom`). Shown on hover or keyboard focus, always on a touch screen.
 */
const SubagentStopButton = ({ sessionId, agentId }: { sessionId: string; agentId: string }) => {
  const stop = useAtomSet(stopAgentAtom(sessionId));

  return (
    <button
      type="button"
      aria-label={`Stop ${agentId}`}
      title={`Stop ${agentId}`}
      onClick={() => {
        stop(agentId);
      }}
      className="absolute top-1/2 right-1.5 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors group-focus-within/agent:opacity-100 group-hover/agent:opacity-100 hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 pointer-coarse:opacity-100 [&_svg]:size-3.5"
    >
      <Square aria-hidden />
    </button>
  );
};

/**
 * A subagent under its Session: its ID and role, then its branch and whether it works, linking to its Subagent page;
 * indented one step per level below the root, at most `MAX_INDENT`. While it works, and its Session is not archived,
 * a Stop at the right.
 */
const SubagentItem = ({
  session,
  row,
  current,
}: {
  session: SessionRecord;
  row: SubagentRow;
  current: boolean;
}) => {
  const { agent } = row;
  const working = agent.status === "working";
  const stoppable = working && session.archivedAt === null;
  // One step is 0.75rem past the Session's own text, which starts at 1.5rem, after the chevron's gutter.
  const indent: CSSProperties = { paddingLeft: `${2.25 + indentOf(row.depth) * 0.75}rem` };

  return (
    <li className="group/agent relative">
      <InAppLink
        href={subagentPath(session.id, agent.id)}
        aria-current={current ? "page" : undefined}
        style={indent}
        className={cn(
          "flex flex-col gap-0.5 rounded-md py-1.5 pr-3 text-sm transition-colors hover:bg-accent",
          stoppable && "pr-10",
          current && "bg-accent text-accent-foreground",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-mono text-[0.8125rem]">{agent.id}</span>
          {agent.role !== null && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
              {agent.role}
            </span>
          )}
        </span>
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          {agent.branch !== undefined && (
            <span className="min-w-0 truncate font-mono">{agent.branch}</span>
          )}
          {working ? (
            <span className="flex shrink-0 items-center gap-1.5">
              <span className="pulse-dot size-1.5 rounded-full bg-success" aria-hidden />
              Working
            </span>
          ) : (
            <span className="shrink-0">Idle</span>
          )}
        </span>
      </InAppLink>
      {stoppable && <SubagentStopButton sessionId={session.id} agentId={agent.id} />}
    </li>
  );
};

/** A Session's subagents under its row, as a tree by parent; `currentAgent` is the one whose Subagent page is shown. */
export const SubagentList = ({
  id,
  session,
  rows,
  currentAgent,
}: {
  id: string;
  session: SessionRecord;
  rows: readonly SubagentRow[];
  currentAgent: string | undefined;
}) => (
  <ul
    id={id}
    aria-label={`Subagents of ${session.title ?? UNTITLED_SESSION}`}
    className="flex flex-col gap-0.5 pt-0.5"
  >
    {Arr.map(rows, (row) => (
      <SubagentItem
        key={row.agent.id}
        session={session}
        row={row}
        current={currentAgent === row.agent.id}
      />
    ))}
  </ul>
);

/**
 * The chevron that shows and hides a Session's subagents under its row, in the gutter every Session row keeps at its
 * left, beside the title and the line under it. Apart from the row's link, so a click on the row still opens the Session.
 * While one of the Session's Subagent pages is shown, the tree stays shown (`locked`), so the page's row is in view.
 */
export const SubagentsToggle = ({
  session,
  expanded,
  locked,
  controls,
  onToggle,
}: {
  session: SessionRecord;
  expanded: boolean;
  locked: boolean;
  controls: string;
  onToggle: () => void;
}) => {
  const count = session.agents?.length ?? 0;
  const label = `${count} ${count === 1 ? "subagent" : "subagents"}`;
  const action = locked ? "Shown while a subagent's page is open" : expanded ? "Hide" : "Show";

  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      aria-disabled={locked || undefined}
      aria-label={`${locked ? "Subagents" : `${action} subagents`}: ${label}`}
      title={locked ? action : `${action} subagents`}
      onClick={locked ? undefined : onToggle}
      className={cn(
        "absolute top-1/2 left-1 flex size-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors",
        locked ? "cursor-default" : "hover:bg-accent hover:text-foreground",
      )}
    >
      <ChevronRight
        className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")}
        aria-hidden
      />
    </button>
  );
};
