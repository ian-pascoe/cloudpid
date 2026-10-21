// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import { useAtomMount, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionChat } from "./chat/session-chat.tsx";
import { cn } from "./lib/utils.ts";
import {
  isSettingsPath,
  isWorkspacesPath,
  navigate,
  sessionIdOf,
  sessionPath,
  usePath,
} from "./router.ts";
import { SessionMenu } from "./session-menu.tsx";
import { SettingsPage } from "./settings-page.tsx";
import { pushSyncAtom } from "./push-state.ts";
import { Sidebar, sessionTitle } from "./sidebar.tsx";
import { useSessionActions } from "./session-actions.ts";
import { sessionListAtom, sessionsAtom } from "./sessions.ts";
import { workspaceNamesAtom } from "./workspaces-state.ts";
import { WorkspacesPage } from "./workspaces-page.tsx";

export const App = () => {
  // At startup, a device that already gets notifications is re-told to the Registry.
  useAtomMount(pushSyncAtom);

  const path = usePath();
  const sessionId = sessionIdOf(path);
  const settingsOpen = isSettingsPath(path);
  const workspacesOpen = isWorkspacesPath(path);
  // On a narrow screen the list is shown alone; any other page takes its place.
  const listOnly = sessionId === undefined && !settingsOpen && !workspacesOpen;
  const sessions = useAtomValue(sessionListAtom);
  const names = useAtomValue(workspaceNamesAtom);
  const refresh = useAtomRefresh(sessionsAtom);
  const actions = useSessionActions();
  const session = sessions?.find((known) => known.id === sessionId);
  const [notice, setNotice] = useState<string | null>(null);
  // An archive or unarchive asked on the Session's page that failed, shown there: the list may be hidden (a phone).
  const [problem, setProblem] = useState<string | null>(null);
  // Sessions this page asked to delete: their socket's close can come before the answer, and is then no news.
  const deletedHere = useRef(new Set<string>());
  const { archive, unarchive, delete: deleteSession, create, rename } = actions;

  // A notice is about what happened before the owner moved on: opening a Session clears it, and its page's problem.
  useEffect(() => {
    if (sessionId !== undefined) setNotice(null);

    setProblem(null);
  }, [sessionId]);

  /** A Session is gone: leave its page if it is the one shown, and say why. */
  const left = useCallback(
    (id: string, message: string) => {
      refresh();

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

  // The composer's `/new` and `/archive`, for the Session shown.
  const commandActions = useMemo(() => {
    if (session === undefined) return undefined;

    return {
      newSession: async () => {
        const created = await create(
          session.repo === null
            ? { workspace: session.workspace }
            : { workspace: session.workspace, repo: session.repo },
        );

        if (created === undefined) return "The session could not be created.";

        navigate(sessionPath(created.id));

        return null;
      },
      archive: () => pageActions.archive(session.id),
    };
  }, [session, create, pageActions]);

  return (
    <div className="flex h-dvh">
      {/* On a narrow screen the list and the chat take turns. */}
      <Sidebar
        actions={{ archive, unarchive, delete: deleteHere }}
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
          <WorkspacesPage />
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
                    save: (title) => rename(session.id, title),
                  }
            }
            archived={
              session?.archivedAt === null || session === undefined
                ? undefined
                : { unarchive: () => pageActions.unarchive(session.id) }
            }
            problem={problem}
            commandActions={commandActions}
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
