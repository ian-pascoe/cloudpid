// @effect-diagnostics globalDate:off preferEffectArray:off -- a list's relative times are read against the wall clock as it renders, and its rows are JSX lists over native arrays.

import { type SessionRecord, UNTITLED_SESSION } from "@cloudpid/protocol";
import { useAtom, useAtomValue } from "@effect/atom-react";
import {
  ArrowLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Settings as SettingsIcon,
  Settings2,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "./components/ui/button.tsx";
import { relativeTime } from "./format.ts";
import { InAppLink } from "./in-app-link.tsx";
import { cn } from "./lib/utils.ts";
import {
  DRAFT_PATH,
  navigate,
  SETTINGS_PATH,
  sessionPath,
  settingsPath,
  type SettingsView,
} from "./router.ts";
import { SettingsNav, SettingsRailLinks } from "./settings/nav.tsx";
import { listProblemAtom, noticeAtom } from "./app-state.ts";
import { groupCollapsedAtom, groupKey, type ListSection } from "./collapsed-groups.ts";
import { subagentRows, subagentsExpandedAtom } from "./list-subagents.ts";
import { SubagentList, SubagentsToggle } from "./sidebar-subagents.tsx";
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
  <InAppLink
    href={sessionPath(session.id)}
    aria-current={active ? "page" : undefined}
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
  </InAppLink>
);

/** The page shown, as the list marks it: a Session's page, or one of its Subagent pages. */
export interface ShownPage {
  readonly sessionId: string;
  readonly agentId?: string | undefined;
}

/**
 * A Session in the list, with its "⋯" menu at the right. On a screen with a pointer the button shows on hover or keyboard
 * focus (and while its menu is open); on a touch screen it always shows. A Session with subagents has a chevron at its
 * left that shows them under it, as a tree by parent (ADR-0024), each opening its Subagent page; every row keeps room
 * for it, so the titles line up.
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
          className="pr-10 pl-6"
        />
        <SessionMenu
          session={session}
          environmentName={environmentName}
          actions={actions}
          className="absolute top-1.5 right-1.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 group-has-[:popover-open]:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        />
        {hasAgents && (
          <SubagentsToggle
            session={session}
            expanded={expanded}
            locked={here && !active}
            controls={listId}
            onToggle={() => {
              setExpanded(!expanded);
            }}
          />
        )}
      </div>
      {hasAgents && expanded && (
        <SubagentList
          id={listId}
          session={session}
          rows={rows}
          currentAgent={here ? shown.agentId : undefined}
        />
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
      <h2 className="group/header relative">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={listId}
          aria-label={`${group.name}, ${count} ${count === 1 ? "session" : "sessions"}${showsRunning ? ", at least one running" : ""}`}
          onClick={() => {
            setCollapsed(!collapsed);
          }}
          className="flex w-full items-center gap-1.5 rounded-md py-1 pr-9 pl-3 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
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
        <InAppLink
          href={settingsPath(group.environment, "environments")}
          aria-label={`Settings of the ${group.name} environment`}
          title="Environment settings"
          className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-colors group-focus-within/header:opacity-100 group-hover/header:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100 pointer-coarse:opacity-100 [&_svg]:size-3.5"
        >
          <Settings2 aria-hidden />
        </InAppLink>
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

/** A link to a page at the foot of the list (Settings), or back to the Sessions: with its name, or as an icon alone on the rail. */
const PageLink = ({
  href,
  icon,
  label,
  iconOnly = false,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  iconOnly?: boolean;
}) => (
  <InAppLink
    href={href}
    aria-label={iconOnly ? label : undefined}
    title={iconOnly ? label : undefined}
    className={cn(
      "flex items-center rounded-md text-sm transition-colors hover:bg-accent [&_svg]:size-4",
      iconOnly ? "size-9 justify-center" : "gap-2 px-3 py-2",
    )}
  >
    {icon}
    {!iconOnly && label}
  </InAppLink>
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

/** The Settings page the sidebar shows the navigation of: its Scope and what it shows. */
export interface SettingsShown {
  readonly scope: string;
  readonly view: SettingsView;
}

/** The link back to the Sessions from the Settings page. */
const BACK_TO_SESSIONS = "Back to sessions";

/**
 * The list collapsed on a wide screen: a rail with the button that expands it, then New session and the Settings link,
 * or on the Settings page the way back to the Sessions and the sections' icons.
 */
const SidebarRail = ({
  expand,
  expandButton,
  controls,
  settings,
}: {
  expand: () => void;
  expandButton: RefObject<HTMLButtonElement | null>;
  controls: string;
  settings: SettingsShown | undefined;
}) => (
  <nav
    aria-label={settings === undefined ? "Sessions" : "Settings"}
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
    {settings === undefined ? (
      <>
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
            href={SETTINGS_PATH}
            icon={<SettingsIcon aria-hidden />}
            label="Settings"
            iconOnly
          />
        </div>
      </>
    ) : (
      <>
        <PageLink href="/" icon={<ArrowLeft aria-hidden />} label={BACK_TO_SESSIONS} iconOnly />
        <div className="flex w-full flex-col items-center border-t pt-2">
          <SettingsRailLinks scope={settings.scope} view={settings.view} />
        </div>
      </>
    )}
  </nav>
);

/**
 * The Session list, or on the Settings page its navigation. On a wide screen it is a column beside the page whose width
 * is dragged and kept on this device, and it collapses to a rail of icons (kept too); on a phone it is the whole
 * screen, in turns with the page.
 */
export const Sidebar = ({
  shown,
  settings,
  className,
}: {
  /** The Session page or Subagent page shown, if one is. */
  shown: ShownPage | undefined;
  /** The Settings page shown, if it is: the sidebar is its navigation. */
  settings: SettingsShown | undefined;
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

  const [notice, setNotice] = useAtom(noticeAtom);

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
          settings={settings}
        />
      )}
      <nav
        ref={column}
        id={columnId}
        aria-label={settings === undefined ? "Sessions" : "Settings"}
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
          {settings === undefined ? (
            <>
              <h1 className="mr-auto truncate text-sm font-semibold">Sessions</h1>
              <NewSessionButton />
            </>
          ) : (
            <InAppLink
              href="/"
              className="-ml-1 mr-auto flex h-8 min-w-0 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{BACK_TO_SESSIONS}</span>
            </InAppLink>
          )}
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
        {settings === undefined ? (
          <SessionColumn shown={shown} />
        ) : (
          <SettingsNav scope={settings.scope} view={settings.view} />
        )}
      </nav>
    </>
  );
};

/** The Session list's body: the active Sessions by Environment, the archived ones, and the Settings link at the foot. */
const SessionColumn = ({ shown }: { shown: ShownPage | undefined }) => {
  const sessions = useAtomValue(sessionListAtom);
  const listError = useAtomValue(sessionsErrorAtom);
  const names = useAtomValue(environmentNamesAtom);
  // A new Session, an archive or an unarchive from an item's menu that failed: shown with the list's own error.
  const problem = useAtomValue(listProblemAtom);
  const actions = useSessionActions(listProblemAtom);
  const { active, archived } = splitArchived(sessions ?? []);
  const error = problem ?? listError;

  return (
    <>
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
        <PageLink href={SETTINGS_PATH} icon={<SettingsIcon aria-hidden />} label="Settings" />
      </div>
    </>
  );
};
