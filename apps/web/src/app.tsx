// @effect-diagnostics preferEffectArray:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import { SessionChat } from "./chat/session-chat.tsx";
import { cn } from "./lib/utils.ts";
import { isSettingsPath, isWorkspacesPath, sessionIdOf, usePath } from "./router.ts";
import { SettingsPage } from "./settings-page.tsx";
import { Sidebar, sessionTitle } from "./sidebar.tsx";
import { useSessions } from "./use-sessions.ts";
import { WorkspacesPage } from "./workspaces-page.tsx";

export const App = () => {
  const path = usePath();
  const sessionId = sessionIdOf(path);
  const settingsOpen = isSettingsPath(path);
  const workspacesOpen = isWorkspacesPath(path);
  // On a narrow screen the list is shown alone; any other page takes its place.
  const listOnly = sessionId === undefined && !settingsOpen && !workspacesOpen;
  const sessions = useSessions();
  const session = sessions.sessions?.find((known) => known.id === sessionId);

  return (
    <div className="flex h-dvh">
      {/* On a narrow screen the list and the chat take turns. */}
      <Sidebar
        sessions={sessions}
        activeId={sessionId}
        settingsActive={settingsOpen}
        workspacesActive={workspacesOpen}
        className={cn(listOnly ? "flex" : "hidden md:flex")}
      />
      <main className={cn("min-w-0 flex-1 flex-col", listOnly ? "hidden md:flex" : "flex")}>
        {settingsOpen ? (
          <SettingsPage />
        ) : workspacesOpen ? (
          <WorkspacesPage sessions={sessions} />
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
          />
        )}
      </main>
    </div>
  );
};
