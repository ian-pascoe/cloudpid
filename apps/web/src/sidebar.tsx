// @effect-diagnostics globalDate:off preferEffectArray:off -- a list's relative times are read against the wall clock as it renders, and its rows are JSX lists over native arrays.

import { type SessionRecord, UNTITLED_SESSION } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  ChevronRight,
  FolderGit2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings as SettingsIcon,
  Square,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "./components/ui/button.tsx";
import { relativeTime } from "./format.ts";
import { cn } from "./lib/utils.ts";
import {
  DRAFT_PATH,
  ENVIRONMENTS_PATH,
  navigate,
  SETTINGS_PATH,
  sessionPath,
  subagentPath,
} from "./router.ts";
import { listProblemAtom, noticeAtom } from "./app-state.ts";
import { groupCollapsedAtom, groupKey, type ListSection } from "./collapsed-groups.ts";
import {
  indentOf,
  subagentRows,
  subagentsExpandedAtom,
  workingCount,
  type SubagentRow,
} from "./list-subagents.ts";
import { stopAgentAtom } from "./session/atoms.ts";
import { useSessionActions } from "./session-actions.ts";
import { type SessionActions, SessionMenu } from "./session-menu.tsx";
import { sessionListAtom, sessionsErrorAtom } from "./sessions.ts";
import { environmentNamesAtom, workspaceBranchesAtom } from "./environments-state.ts";
import { groupByEnvironment, splitArchived, type EnvironmentGroup } from "./environments.ts";
import {
  COLLAPSE_BELOW,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  sidebarCollapsedAtom,
  sidebarWidthAtom,
  sidebarWidthForKey,
} from "./sidebar-state.ts";

export const sessionTitle = (session: SessionRecord): string => session.title ?? UNTITLED_SESSION;

/** Where a Session works, as its list item says: its Workspace's branch, once the Workspaces are listed. */
const SessionPlaceNote = ({ session }: { session: SessionRecord }) => {
  const branch = useAtomValue(workspaceBranchesAtom)[session.workspace];

  return branch === undefined ? null : <span className="truncate font-mono">{branch}</span>;
};

/** A link that opens `href` in the app, or as the browser does with a modifier or another button (a new tab). */
const openInApp = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

  event.preventDefault();
  navigate(href);
};

export const SessionLink = ({
  session,
  active,
  contains = false,
  className,
}: {
  session: SessionRecord;
  active: boolean;
  /** The page shown is one of its Subagent pages: a lighter tint than the page's own. */
  contains?: boolean;
  className?: string;
}) => (
  <a
    href={sessionPath(session.id)}
    aria-current={active ? "page" : undefined}
    onClick={openInApp(sessionPath(session.id))}
    className={cn(
      "flex flex-col gap-0.5 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent",
      active && "bg-accent text-accent-foreground",
      !active && contains && "bg-accent/50",
      className,
    )}
  >
    <span className="truncate font-medium">{sessionTitle(session)}</span>
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      <SessionPlaceNote session={session} />
      {session.status === "running" ? (
        <>
          <span className="pulse-dot size-1.5 rounded-full bg-success" aria-hidden />
          Running
        </>
      ) : (
        <span className="tabular shrink-0 whitespace-nowrap">
          {relativeTime(session.updatedAt, Date.now())}
        </span>
      )}
    </span>
  </a>
);

/** The page shown, as the list marks it: a Session's page, or one of its Subagent pages. */
export interface ShownPage {
  readonly sessionId: string;
  readonly agentId?: string | undefined;
}

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
  const href = subagentPath(session.id, agent.id);
  const working = agent.status === "working";
  const stoppable = working && session.archivedAt === null;
  // One step is 0.75rem past the Session's own text, which starts at 0.75rem.
  const indent: CSSProperties = { paddingLeft: `${1.5 + indentOf(row.depth) * 0.75}rem` };

  return (
    <li className="group/agent relative">
      <a
        href={href}
        aria-current={current ? "page" : undefined}
        onClick={openInApp(href)}
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
      </a>
      {stoppable && <SubagentStopButton sessionId={session.id} agentId={agent.id} />}
    </li>
  );
};

/**
 * The button that shows and hides a Session's subagents under its row, with how many it has; collapsed, a pulse dot
 * while one works. Apart from the row's link, so a click on the row still opens the Session.
 */
const SubagentsToggle = ({
  session,
  expanded,
  controls,
  onToggle,
}: {
  session: SessionRecord;
  expanded: boolean;
  controls: string;
  onToggle: () => void;
}) => {
  const count = session.agents?.length ?? 0;
  const working = workingCount(session);
  const showsWorking = !expanded && working > 0;
  const label = `${count} ${count === 1 ? "subagent" : "subagents"}${working > 0 ? `, ${working} working` : ""}`;

  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      aria-label={`${expanded ? "Hide" : "Show"} subagents: ${label}`}
      title={`${expanded ? "Hide" : "Show"} subagents`}
      onClick={onToggle}
      className="absolute right-1.5 bottom-1 flex h-[1.125rem] items-center gap-1 rounded px-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <ChevronRight
        className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
        aria-hidden
      />
      <span className="tabular" aria-hidden>
        {count}
      </span>
      {showsWorking && (
        <span className="pulse-dot size-1.5 shrink-0 rounded-full bg-success" aria-hidden />
      )}
    </button>
  );
};

/**
 * A Session in the list, with its "⋯" menu at the right. On a screen with a pointer the button shows on hover or keyboard
 * focus (and while its menu is open); on a touch screen it always shows. A Session with subagents has a button that
 * shows them under it, as a tree by parent (ADR-0024), each opening its Subagent page.
 */
const SessionItem = ({
  session,
  shown,
  environmentName,
  actions,
}: {
  session: SessionRecord;
  shown: ShownPage | undefined;
  environmentName: string;
  actions: SessionActions;
}) => {
  const [expanded, setExpanded] = useAtom(subagentsExpandedAtom(session.id));
  const listId = useId();
  const rows = subagentRows(session.agents);
  const here = shown?.sessionId === session.id;
  const active = here && shown.agentId === undefined;
  const hasAgents = rows.length > 0;

  return (
    <li>
      <div className="group relative">
        <SessionLink
          session={session}
          active={active}
          contains={here && !active}
          className={hasAgents ? "pr-12" : "pr-10"}
        />
        <SessionMenu
          session={session}
          environmentName={environmentName}
          actions={actions}
          className={cn(
            "absolute right-1.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 group-has-[:popover-open]:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100",
            // Above the subagents' button, which sits under it.
            hasAgents ? "top-1 size-7" : "top-1.5",
          )}
        />
        {hasAgents && (
          <SubagentsToggle
            session={session}
            expanded={expanded}
            controls={listId}
            onToggle={() => {
              setExpanded(!expanded);
            }}
          />
        )}
      </div>
      {hasAgents && expanded && (
        <ul
          id={listId}
          aria-label={`Subagents of ${sessionTitle(session)}`}
          className="flex flex-col gap-0.5 pt-0.5"
        >
          {rows.map((row) => (
            <SubagentItem
              key={row.agent.id}
              session={session}
              row={row}
              current={here && shown.agentId === row.agent.id}
            />
          ))}
        </ul>
      )}
    </li>
  );
};

/**
 * An Environment's Sessions under a header that collapses them, kept per device. The header counts them and, collapsed,
 * shows whether one is running.
 */
const SessionGroup = ({
  group,
  section,
  shown,
  actions,
}: {
  group: EnvironmentGroup;
  section: ListSection;
  shown: ShownPage | undefined;
  actions: SessionActions;
}) => {
  const [collapsed, setCollapsed] = useAtom(
    groupCollapsedAtom(groupKey(section, group.environment)),
  );

  const listId = useId();
  const count = group.sessions.length;
  const showsRunning = collapsed && group.running;

  return (
    <section aria-label={group.name}>
      <h2>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={listId}
          aria-label={`${group.name}, ${count} ${count === 1 ? "session" : "sessions"}${showsRunning ? ", at least one running" : ""}`}
          onClick={() => {
            setCollapsed(!collapsed);
          }}
          className="flex w-full items-center gap-1.5 rounded-md px-3 py-1 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronRight
            className={cn("size-3.5 shrink-0 transition-transform", !collapsed && "rotate-90")}
            aria-hidden
          />
          <span className="truncate">{group.name}</span>
          <span className="tabular shrink-0 font-normal" aria-hidden>
            {count}
          </span>
          {showsRunning && (
            <span
              className="pulse-dot size-1.5 shrink-0 rounded-full bg-success"
              title="A session is running"
              aria-hidden
            />
          )}
        </button>
      </h2>
      {!collapsed && (
        <ul id={listId} className="flex flex-col gap-0.5">
          {group.sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              shown={shown}
              environmentName={group.name}
              actions={actions}
            />
          ))}
        </ul>
      )}
    </section>
  );
};

/** Sessions grouped under their Environment's name, each group collapsible. */
const SessionGroups = ({
  groups,
  section,
  shown,
  actions,
}: {
  groups: readonly EnvironmentGroup[];
  section: ListSection;
  shown: ShownPage | undefined;
  actions: SessionActions;
}) => (
  <div className="flex flex-col gap-3">
    {groups.map((group) => (
      <SessionGroup
        key={group.environment}
        group={group}
        section={section}
        shown={shown}
        actions={actions}
      />
    ))}
  </div>
);

/** Open the draft, where the owner chooses the Environment and the Workspace of a new Session. */
const openDraft = () => {
  navigate(DRAFT_PATH);
};

/** The New session button: it opens the draft, where the owner chooses the Environment and the Workspace. */
const NewSessionButton = () => (
  <Button size="sm" variant="outline" aria-label="New session" onClick={openDraft}>
    <Plus />
    {/* A narrow list keeps the icon alone; the label still names it. */}
    <span className="hidden @[18.5rem]:inline">New session</span>
  </Button>
);

/** A link to a page at the foot of the list (Environments, Settings): with its name, or as an icon alone on the rail. */
const PageLink = ({
  href,
  active,
  icon,
  label,
  iconOnly = false,
}: {
  href: string;
  active: boolean;
  icon: ReactNode;
  label: string;
  iconOnly?: boolean;
}) => (
  <a
    href={href}
    aria-current={active ? "page" : undefined}
    aria-label={iconOnly ? label : undefined}
    title={iconOnly ? label : undefined}
    onClick={(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

      event.preventDefault();
      navigate(href);
    }}
    className={cn(
      "flex items-center rounded-md text-sm transition-colors hover:bg-accent [&_svg]:size-4",
      iconOnly ? "size-9 justify-center" : "gap-2 px-3 py-2",
      active && "bg-accent text-accent-foreground",
    )}
  >
    {icon}
    {!iconOnly && label}
  </a>
);

/**
 * The strip between the list and the page beside it on a wide screen: drag it, or focus it and use the arrow keys, Home
 * and End; a double click puts back the default width. Dragged far enough to the left, it collapses the list.
 */
const SidebarResizeHandle = ({
  column,
  controls,
  collapse,
}: {
  column: RefObject<HTMLElement | null>;
  controls: string;
  collapse: () => void;
}) => {
  const [width, setWidth] = useAtom(sidebarWidthAtom);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const next = sidebarWidthForKey(width, event.key, event.shiftKey);

    if (next === undefined) return;

    event.preventDefault();
    setWidth(next);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;

    const left = column.current?.getBoundingClientRect().left;

    if (left === undefined) return;

    const next = event.clientX - left;

    if (next < COLLAPSE_BELOW) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      collapse();

      return;
    }

    setWidth(next);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-controls={controls}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuenow={width}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={onPointerMove}
      onDoubleClick={() => {
        setWidth(DEFAULT_SIDEBAR_WIDTH);
      }}
      className="group absolute inset-y-0 -right-1.5 z-10 hidden w-3 cursor-col-resize touch-none select-none outline-none md:block"
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors group-hover:bg-ring group-focus-visible:bg-ring group-active:bg-ring" />
    </div>
  );
};

/** The list collapsed on a wide screen: a rail with the button that expands it, New session, and the pages' links. */
const SidebarRail = ({
  expand,
  expandButton,
  controls,
  settingsActive,
  environmentsActive,
}: {
  expand: () => void;
  expandButton: RefObject<HTMLButtonElement | null>;
  controls: string;
  settingsActive: boolean;
  environmentsActive: boolean;
}) => (
  <nav
    aria-label="Sessions"
    className="hidden w-14 shrink-0 flex-col items-center gap-2 border-r pt-3 pb-2 md:flex"
  >
    <Button
      ref={expandButton}
      variant="ghost"
      size="icon"
      aria-label="Expand sidebar"
      aria-expanded={false}
      aria-controls={controls}
      title="Expand sidebar"
      onClick={expand}
      className="size-8"
    >
      <PanelLeftOpen />
    </Button>
    <Button
      variant="outline"
      size="icon"
      aria-label="New session"
      title="New session"
      onClick={openDraft}
      className="size-8"
    >
      <Plus />
    </Button>
    <div className="mt-auto flex w-full flex-col items-center gap-0.5 border-t pt-2">
      <PageLink
        href={ENVIRONMENTS_PATH}
        active={environmentsActive}
        icon={<FolderGit2 aria-hidden />}
        label="Environments"
        iconOnly
      />
      <PageLink
        href={SETTINGS_PATH}
        active={settingsActive}
        icon={<SettingsIcon aria-hidden />}
        label="Settings"
        iconOnly
      />
    </div>
  </nav>
);

/**
 * The Session list. On a wide screen it is a column beside the page whose width is dragged and kept on this device, and
 * it collapses to a rail of icons (kept too); on a phone it is the whole screen, in turns with the page.
 */
export const Sidebar = ({
  shown,
  settingsActive,
  environmentsActive,
  className,
}: {
  /** The Session page or Subagent page shown, if one is. */
  shown: ShownPage | undefined;
  settingsActive: boolean;
  environmentsActive: boolean;
  className?: string;
}) => {
  const [collapsed, setCollapsed] = useAtom(sidebarCollapsedAtom);
  const width = useAtomValue(sidebarWidthAtom);
  const column = useRef<HTMLElement>(null);
  const expandButton = useRef<HTMLButtonElement>(null);
  const collapseButton = useRef<HTMLButtonElement>(null);
  // Set as the owner collapses or expands the list, so the focus moves to the button that undoes it.
  const refocus = useRef(false);
  const columnId = useId();

  useEffect(() => {
    if (!refocus.current) return;

    refocus.current = false;
    (collapsed ? expandButton : collapseButton).current?.focus();
  }, [collapsed]);

  const toggle = (next: boolean) => {
    refocus.current = true;
    setCollapsed(next);
  };

  const sessions = useAtomValue(sessionListAtom);
  const [notice, setNotice] = useAtom(noticeAtom);
  const listError = useAtomValue(sessionsErrorAtom);
  const names = useAtomValue(environmentNamesAtom);
  // A new Session, an archive or an unarchive from an item's menu that failed: shown with the list's own error.
  const problem = useAtomValue(listProblemAtom);
  const actions = useSessionActions(listProblemAtom);

  const { active, archived } = splitArchived(sessions ?? []);
  const error = problem ?? listError;

  const style: CSSProperties & Record<`--${string}`, string> = { "--sidebar-width": `${width}px` };

  return (
    <>
      {collapsed && (
        <SidebarRail
          expand={() => {
            toggle(false);
          }}
          expandButton={expandButton}
          controls={columnId}
          settingsActive={settingsActive}
          environmentsActive={environmentsActive}
        />
      )}
      <nav
        ref={column}
        id={columnId}
        aria-label="Sessions"
        style={style}
        className={cn(
          "@container relative flex w-full flex-col border-r md:w-(--sidebar-width) md:max-w-[calc(100%-20rem)] md:shrink-0",
          className,
          // Collapsed, the rail stands in for it on a wide screen; a phone still shows it whole.
          collapsed && "md:hidden",
        )}
      >
        <SidebarResizeHandle
          column={column}
          controls={columnId}
          collapse={() => {
            toggle(true);
          }}
        />
        <div className="flex items-center gap-2 p-3">
          <h1 className="mr-auto truncate text-sm font-semibold">Sessions</h1>
          <NewSessionButton />
          <Button
            ref={collapseButton}
            variant="ghost"
            size="icon"
            aria-label="Collapse sidebar"
            aria-expanded
            aria-controls={columnId}
            title="Collapse sidebar"
            onClick={() => {
              toggle(true);
            }}
            className="hidden size-8 md:inline-flex"
          >
            <PanelLeftClose />
          </Button>
        </div>
        {notice !== null && (
          <div
            role="status"
            className="mx-3 mb-2 flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm"
          >
            <span className="min-w-0 flex-1">{notice}</span>
            <button
              type="button"
              onClick={() => {
                setNotice(null);
              }}
              aria-label="Dismiss"
              className="-m-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        )}
        {error !== null && (
          <p role="alert" className="mx-3 mb-2 text-sm whitespace-pre-wrap text-destructive">
            {error}
          </p>
        )}
        <div className="flex-1 overflow-y-auto overscroll-y-contain px-2 pb-3">
          {sessions === null ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="flex flex-col gap-4">
              {active.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  {archived.length === 0 ? "No sessions yet." : "No sessions outside the archive."}
                </p>
              ) : (
                <SessionGroups
                  groups={groupByEnvironment(active, names)}
                  section="active"
                  shown={shown}
                  actions={actions}
                />
              )}
              {archived.length > 0 && (
                <details
                  className="group/archived"
                  open={
                    archived.some((session) => session.id === shown?.sessionId) ? true : undefined
                  }
                >
                  <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-muted-foreground select-none hover:bg-accent hover:text-foreground [&::-webkit-details-marker]:hidden">
                    <ChevronRight
                      className="size-3.5 transition-transform group-open/archived:rotate-90"
                      aria-hidden
                    />
                    Archived ({archived.length})
                  </summary>
                  <div className="mt-2">
                    <SessionGroups
                      groups={groupByEnvironment(archived, names)}
                      section="archived"
                      shown={shown}
                      actions={actions}
                    />
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-0.5 border-t p-2">
          <PageLink
            href={ENVIRONMENTS_PATH}
            active={environmentsActive}
            icon={<FolderGit2 aria-hidden />}
            label="Environments"
          />
          <PageLink
            href={SETTINGS_PATH}
            active={settingsActive}
            icon={<SettingsIcon aria-hidden />}
            label="Settings"
          />
        </div>
      </nav>
    </>
  );
};
