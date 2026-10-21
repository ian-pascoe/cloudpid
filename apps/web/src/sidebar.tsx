// @effect-diagnostics globalDate:off preferEffectArray:off -- a list's relative times are read against the wall clock as it renders, and its rows are JSX lists over native arrays.

import type { SessionRecord } from "@cloudpid/protocol";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import { ChevronRight, FolderGit2, Plus, Settings as SettingsIcon, X } from "lucide-react";
import { Button } from "./components/ui/button.tsx";
import { relativeTime } from "./format.ts";
import { cn } from "./lib/utils.ts";
import { navigate, SETTINGS_PATH, sessionPath, WORKSPACES_PATH } from "./router.ts";
import { listProblemAtom, noticeAtom } from "./app-state.ts";
import { failureOf } from "./registry.ts";
import { useSessionActions } from "./session-actions.ts";
import { type SessionActions, SessionMenu } from "./session-menu.tsx";
import { createSessionAtom, sessionListAtom, sessionsErrorAtom } from "./sessions.ts";
import { workspaceNamesAtom } from "./workspaces-state.ts";
import { groupByWorkspace, splitArchived, type WorkspaceGroup } from "./workspaces.ts";

export const sessionTitle = (session: SessionRecord): string => session.title ?? "Untitled session";

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
      {session.repo !== null && <span className="truncate font-mono">{session.repo}</span>}
      {session.status === "running" ? (
        <>
          <span className="pulse-dot size-1.5 rounded-full bg-success" aria-hidden />
          Running
        </>
      ) : (
        <span className="tabular">{relativeTime(session.updatedAt, Date.now())}</span>
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
  workspaceName,
  actions,
}: {
  session: SessionRecord;
  active: boolean;
  workspaceName: string;
  actions: SessionActions;
}) => (
  <li className="group relative">
    <SessionLink session={session} active={active} className="pr-10" />
    <SessionMenu
      session={session}
      workspaceName={workspaceName}
      actions={actions}
      className="absolute top-1.5 right-1.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 group-has-[:popover-open]:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
    />
  </li>
);

/** Sessions grouped under their Workspace's name. */
const SessionGroups = ({
  groups,
  activeId,
  actions,
}: {
  groups: readonly WorkspaceGroup[];
  activeId: string | undefined;
  actions: SessionActions;
}) => (
  <div className="flex flex-col gap-3">
    {groups.map((group) => (
      <section key={group.workspace} aria-label={group.name}>
        <h2 className="truncate px-3 py-1 text-xs font-medium text-muted-foreground">
          {group.name}
        </h2>
        <ul className="flex flex-col gap-0.5">
          {group.sessions.map((session) => (
            <SessionItem
              key={session.id}
              session={session}
              active={session.id === activeId}
              workspaceName={group.name}
              actions={actions}
            />
          ))}
        </ul>
      </section>
    ))}
  </div>
);

export const Sidebar = ({
  activeId,
  settingsActive,
  workspacesActive,
  className,
}: {
  activeId: string | undefined;
  settingsActive: boolean;
  workspacesActive: boolean;
  className?: string;
}) => {
  const sessions = useAtomValue(sessionListAtom);
  const [notice, setNotice] = useAtom(noticeAtom);
  const listError = useAtomValue(sessionsErrorAtom);
  const names = useAtomValue(workspaceNamesAtom);
  // Why the last new Session could not be created, here or by the composer's `/new`.
  const created = useAtomValue(createSessionAtom);
  const createError = failureOf(created);
  const createSession = useAtomSet(createSessionAtom);
  // An archive or unarchive from an item's menu that failed: shown with the list's own error.
  const problem = useAtomValue(listProblemAtom);
  const actions = useSessionActions(listProblemAtom);

  const { active, archived } = splitArchived(sessions ?? []);
  const error = problem ?? createError ?? listError;

  return (
    <nav aria-label="Sessions" className={cn("flex w-full flex-col border-r md:w-72", className)}>
      <div className="flex items-center justify-between gap-2 p-3">
        <h1 className="text-sm font-semibold">Sessions</h1>
        <Button
          size="sm"
          variant="outline"
          disabled={created.waiting}
          onClick={() => {
            createSession({});
          }}
        >
          <Plus />
          New session
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
                groups={groupByWorkspace(active, names)}
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
                    groups={groupByWorkspace(archived, names)}
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
          href={WORKSPACES_PATH}
          aria-current={workspacesActive ? "page" : undefined}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;

            event.preventDefault();
            navigate(WORKSPACES_PATH);
          }}
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent",
            workspacesActive && "bg-accent text-accent-foreground",
          )}
        >
          <FolderGit2 className="size-4" aria-hidden />
          Workspaces
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
