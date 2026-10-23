// @effect-diagnostics globalDate:off preferEffectArray:off -- a list's relative times are read against the wall clock as it renders, and its rows are JSX lists over native arrays.

import type { SessionRecord } from "@cloudpid/protocol";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { ChevronRight, FolderGit2, Plus, Settings as SettingsIcon, X } from "lucide-react";
import { useId } from "react";
import { Button } from "./components/ui/button.tsx";
import { relativeTime } from "./format.ts";
import { cn } from "./lib/utils.ts";
import { DRAFT_PATH, ENVIRONMENTS_PATH, navigate, SETTINGS_PATH, sessionPath } from "./router.ts";
import { listProblemAtom, noticeAtom } from "./app-state.ts";
import { groupCollapsedAtom, groupKey, type ListSection } from "./collapsed-groups.ts";
import { useSessionActions } from "./session-actions.ts";
import { type SessionActions, SessionMenu } from "./session-menu.tsx";
import { sessionListAtom, sessionsErrorAtom } from "./sessions.ts";
import { environmentNamesAtom, workspaceBranchesAtom } from "./environments-state.ts";
import { groupByEnvironment, splitArchived, type EnvironmentGroup } from "./environments.ts";

export const sessionTitle = (session: SessionRecord): string => session.title ?? "Untitled session";

/** Where a Session works, as its list item says: its Workspace's branch, once the Workspaces are listed. */
const SessionPlaceNote = ({ session }: { session: SessionRecord }) => {
  const branch = useAtomValue(workspaceBranchesAtom)[session.workspace];

  return branch === undefined ? null : <span className="truncate font-mono">{branch}</span>;
};

export const SessionLink = ({
  session,
  active,
  className,
}: {
  session: SessionRecord;
  active: boolean;
  className?: string;
}) => (
  <a
    href={sessionPath(session.id)}
    aria-current={active ? "page" : undefined}
    onClick={(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

      event.preventDefault();
      navigate(sessionPath(session.id));
    }}
    className={cn(
      "flex flex-col gap-0.5 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent",
      active && "bg-accent text-accent-foreground",
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

/**
 * A Session in the list, with its "⋯" menu at the right. On a screen with a pointer the button shows on hover or keyboard
 * focus (and while its menu is open); on a touch screen it always shows.
 */
const SessionItem = ({
  session,
  active,
  environmentName,
  actions,
}: {
  session: SessionRecord;
  active: boolean;
  environmentName: string;
  actions: SessionActions;
}) => (
  <li className="group relative">
    <SessionLink session={session} active={active} className="pr-10" />
    <SessionMenu
      session={session}
      environmentName={environmentName}
      actions={actions}
      className="absolute top-1.5 right-1.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 group-has-[:popover-open]:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
    />
  </li>
);

/**
 * An Environment's Sessions under a header that collapses them, kept per device. The header counts them and, collapsed,
 * shows whether one is running.
 */
const SessionGroup = ({
  group,
  section,
  activeId,
  actions,
}: {
  group: EnvironmentGroup;
  section: ListSection;
  activeId: string | undefined;
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
              active={session.id === activeId}
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
  activeId,
  actions,
}: {
  groups: readonly EnvironmentGroup[];
  section: ListSection;
  activeId: string | undefined;
  actions: SessionActions;
}) => (
  <div className="flex flex-col gap-3">
    {groups.map((group) => (
      <SessionGroup
        key={group.environment}
        group={group}
        section={section}
        activeId={activeId}
        actions={actions}
      />
    ))}
  </div>
);

/** The New session button: it opens the draft, where the owner chooses the Environment and the Workspace. */
const NewSessionButton = () => (
  <Button
    size="sm"
    variant="outline"
    onClick={() => {
      navigate(DRAFT_PATH);
    }}
  >
    <Plus />
    New session
  </Button>
);

export const Sidebar = ({
  activeId,
  settingsActive,
  environmentsActive,
  className,
}: {
  activeId: string | undefined;
  settingsActive: boolean;
  environmentsActive: boolean;
  className?: string;
}) => {
  const sessions = useAtomValue(sessionListAtom);
  const [notice, setNotice] = useAtom(noticeAtom);
  const listError = useAtomValue(sessionsErrorAtom);
  const names = useAtomValue(environmentNamesAtom);
  // A new Session, an archive or an unarchive from an item's menu that failed: shown with the list's own error.
  const problem = useAtomValue(listProblemAtom);
  const actions = useSessionActions(listProblemAtom);

  const { active, archived } = splitArchived(sessions ?? []);
  const error = problem ?? listError;

  return (
    <nav aria-label="Sessions" className={cn("flex w-full flex-col border-r md:w-72", className)}>
      <div className="flex items-center justify-between gap-2 p-3">
        <h1 className="text-sm font-semibold">Sessions</h1>
        <NewSessionButton />
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
      <div className="flex-1 overflow-y-auto px-2 pb-3">
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
                activeId={activeId}
                actions={actions}
              />
            )}
            {archived.length > 0 && (
              <details
                className="group/archived"
                open={archived.some((session) => session.id === activeId) ? true : undefined}
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
                    activeId={activeId}
                    actions={actions}
                  />
                </div>
              </details>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-0.5 border-t p-2">
        <a
          href={ENVIRONMENTS_PATH}
          aria-current={environmentsActive ? "page" : undefined}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

            event.preventDefault();
            navigate(ENVIRONMENTS_PATH);
          }}
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent",
            environmentsActive && "bg-accent text-accent-foreground",
          )}
        >
          <FolderGit2 className="size-4" aria-hidden />
          Environments
        </a>
        <a
          href={SETTINGS_PATH}
          aria-current={settingsActive ? "page" : undefined}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

            event.preventDefault();
            navigate(SETTINGS_PATH);
          }}
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent",
            settingsActive && "bg-accent text-accent-foreground",
          )}
        >
          <SettingsIcon className="size-4" aria-hidden />
          Settings
        </a>
      </div>
    </nav>
  );
};
