// @effect-diagnostics asyncFunction:off globalDate:off preferEffectArray:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import type { SessionRecord } from "@cloudpid/protocol";
import { ChevronRight, FolderGit2, Plus, Settings as SettingsIcon, X } from "lucide-react";
import { useState } from "react";
import { Button } from "./components/ui/button.tsx";
import { relativeTime } from "./format.ts";
import { cn } from "./lib/utils.ts";
import { navigate, SETTINGS_PATH, sessionPath, WORKSPACES_PATH } from "./router.ts";
import type { Sessions } from "./use-sessions.ts";
import { type SessionActions, SessionMenu } from "./session-menu.tsx";
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
  menu,
}: {
  session: SessionRecord;
  active: boolean;
  workspaceName: string;
  menu: ItemMenu;
}) => (
  <li className="group relative">
    <SessionLink session={session} active={active} className="pr-10" />
    <SessionMenu
      session={session}
      workspaceName={workspaceName}
      actions={menu.actions}
      onFailure={menu.onFailure}
      onDeleted={() => {
        menu.onDeleted(session.id);
      }}
      className="absolute top-1.5 right-1.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 group-has-[:popover-open]:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
    />
  </li>
);

/** What every item's menu does in the list: the actions, and where a deletion and a failure go. */
type ItemMenu = {
  readonly actions: SessionActions;
  readonly onDeleted: (id: string) => void;
  readonly onFailure: (message: string) => void;
};

/** Sessions grouped under their Workspace's name. */
const SessionGroups = ({
  groups,
  activeId,
  menu,
}: {
  groups: readonly WorkspaceGroup[];
  activeId: string | undefined;
  menu: ItemMenu;
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
              menu={menu}
            />
          ))}
        </ul>
      </section>
    ))}
  </div>
);

export const Sidebar = ({
  sessions,
  names,
  activeId,
  settingsActive,
  workspacesActive,
  notice,
  onDismissNotice,
  onDeleted,
  className,
}: {
  sessions: Sessions;
  /** Each Workspace's name, by slug. */
  names: Readonly<Record<string, string>>;
  activeId: string | undefined;
  settingsActive: boolean;
  workspacesActive: boolean;
  /** Something the owner should know that happened elsewhere, such as a Session deleted from another device. */
  notice: string | null;
  onDismissNotice: () => void;
  /** A Session was deleted from its menu. */
  onDeleted: (id: string) => void;
  className?: string;
}) => {
  const [creating, setCreating] = useState(false);
  // An archive or unarchive from an item's menu that failed: shown with the list's own error.
  const [problem, setProblem] = useState<string | null>(null);

  const menu: ItemMenu = {
    actions: {
      archive: (id) => {
        setProblem(null);

        return sessions.archive(id);
      },
      unarchive: (id) => {
        setProblem(null);

        return sessions.unarchive(id);
      },
      delete: sessions.delete,
    },
    onDeleted,
    onFailure: setProblem,
  };

  const create = async () => {
    setCreating(true);

    const session = await sessions.create();

    setCreating(false);

    if (session !== undefined) navigate(sessionPath(session.id));
  };

  const { active, archived } = splitArchived(sessions.sessions ?? []);

  return (
    <nav aria-label="Sessions" className={cn("flex w-full flex-col border-r md:w-72", className)}>
      <div className="flex items-center justify-between gap-2 p-3">
        <h1 className="text-sm font-semibold">Sessions</h1>
        <Button size="sm" variant="outline" disabled={creating} onClick={() => void create()}>
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
            onClick={onDismissNotice}
            aria-label="Dismiss"
            className="-m-1 shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      )}
      {(problem ?? sessions.error) !== null && (
        <p role="alert" className="mx-3 mb-2 text-sm whitespace-pre-wrap text-destructive">
          {problem ?? sessions.error}
        </p>
      )}
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {sessions.sessions === null ? (
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
                menu={menu}
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
                    menu={menu}
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
