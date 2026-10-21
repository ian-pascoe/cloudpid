// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionChat } from "./chat/session-chat.tsx";
import { cn } from "./lib/utils.ts";
import { isSettingsPath, isWorkspacesPath, navigate, sessionIdOf, usePath } from "./router.ts";
import { SessionMenu } from "./session-menu.tsx";
import { SettingsPage } from "./settings-page.tsx";
import { Sidebar, sessionTitle } from "./sidebar.tsx";
import { useSessions } from "./use-sessions.ts";
import { useWorkspaces } from "./use-workspaces.ts";
import { WorkspacesPage } from "./workspaces-page.tsx";

export const App = () => {
  const path = usePath();
  const sessionId = sessionIdOf(path);
  const settingsOpen = isSettingsPath(path);
  const workspacesOpen = isWorkspacesPath(path);
  // On a narrow screen the list is shown alone; any other page takes its place.
  const listOnly = sessionId === undefined && !settingsOpen && !workspacesOpen;
  const sessions = useSessions();
  const workspaces = useWorkspaces();
  const session = sessions.sessions?.find((known) => known.id === sessionId);
  const [notice, setNotice] = useState<string | null>(null);
  // An archive or unarchive asked on the Session's page that failed, shown there: the list may be hidden (a phone).
  const [problem, setProblem] = useState<string | null>(null);
  // Sessions this page asked to delete: their socket's close can come before the answer, and is then no news.
  const deletedHere = useRef(new Set<string>());
  const { refresh, archive, unarchive, delete: deleteSession } = sessions;

  const names = useMemo(
    () =>
      Object.fromEntries((workspaces.workspaces ?? []).map((known) => [known.slug, known.name])),
    [workspaces.workspaces],
  );

  // A notice is about what happened before the owner moved on: opening a Session clears it, and its page's problem.
  useEffect(() => {
    if (sessionId !== undefined) setNotice(null);

    setProblem(null);
  }, [sessionId]);

  /** A Session is gone: leave its page if it is the one shown, and say why. */
  const left = useCallback(
    (id: string, message: string) => {
      void refresh();

      if (id !== sessionId) return;

      setNotice(message);
      navigate("/");
    },
    [refresh, sessionId],
  );

  const deleteHere = useCallback(
    async (id: string) => {
      deletedHere.current.add(id);

      const failure = await deleteSession(id);

      if (failure !== null) deletedHere.current.delete(id);

      return failure;
    },
    [deleteSession],
  );

  /** The shown Session's socket closed saying it was deleted: here, or on another device. */
  const deletedShown = useCallback(() => {
    if (sessionId === undefined) return;

    left(
      sessionId,
      deletedHere.current.has(sessionId) ? "Session deleted." : "That session was deleted.",
    );
  }, [left, sessionId]);

  /** The Session page's actions: a failure is shown on the page. */
  const pageActions = useMemo(() => {
    const shown = (action: (id: string) => Promise<string | null>) => async (id: string) => {
      setProblem(null);

      const failure = await action(id);

      setProblem(failure);

      return failure;
    };

    return { archive: shown(archive), unarchive: shown(unarchive), delete: deleteHere };
  }, [archive, unarchive, deleteHere]);

  const workspaceName =
    session === undefined ? undefined : (names[session.workspace] ?? session.workspace);

  return (
    <div className="flex h-dvh">
      {/* On a narrow screen the list and the chat take turns. */}
      <Sidebar
        sessions={{ ...sessions, delete: deleteHere }}
        names={names}
        activeId={sessionId}
        settingsActive={settingsOpen}
        workspacesActive={workspacesOpen}
        notice={notice}
        onDismissNotice={() => {
          setNotice(null);
        }}
        onDeleted={(id) => {
          left(id, "Session deleted.");
        }}
        className={cn(listOnly ? "flex" : "hidden md:flex")}
      />
      <main className={cn("min-w-0 flex-1 flex-col", listOnly ? "hidden md:flex" : "flex")}>
        {settingsOpen ? (
          <SettingsPage />
        ) : workspacesOpen ? (
          <WorkspacesPage sessions={sessions} workspaces={workspaces} />
        ) : sessionId === undefined ? (
          <div className="m-auto max-w-sm px-6 text-center">
            <h2 className="text-lg font-semibold">Pick a session, or start a new one</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              A session keeps its conversation and keeps working when this page is closed.
            </p>
          </div>
        ) : (
          <SessionChat
            key={sessionId}
            sessionId={sessionId}
            title={session === undefined ? undefined : sessionTitle(session)}
            rename={
              session === undefined
                ? undefined
                : {
                    current: session.title ?? "",
                    save: (title) => sessions.rename(session.id, title),
                  }
            }
            archived={
              session?.archivedAt === null || session === undefined
                ? undefined
                : { unarchive: () => pageActions.unarchive(session.id) }
            }
            problem={problem}
            menu={
              session === undefined || workspaceName === undefined ? undefined : (
                <SessionMenu
                  session={session}
                  workspaceName={workspaceName}
                  actions={pageActions}
                  onDeleted={() => {
                    left(session.id, "Session deleted.");
                  }}
                  onFailure={setProblem}
                />
              )
            }
            onDeleted={deletedShown}
          />
        )}
      </main>
    </div>
  );
};
