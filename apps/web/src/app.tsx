import { SessionChat } from "./chat/session-chat.tsx";
import { cn } from "./lib/utils.ts";
import { sessionIdOf, usePath } from "./router.ts";
import { Sidebar, sessionTitle } from "./sidebar.tsx";
import { useSessions } from "./use-sessions.ts";

export const App = () => {
  const sessionId = sessionIdOf(usePath());
  const sessions = useSessions();
  const session = sessions.sessions?.find((known) => known.id === sessionId);

  return (
    <div className="flex h-dvh">
      {/* On a narrow screen the list and the chat take turns. */}
      <Sidebar
        sessions={sessions}
        activeId={sessionId}
        className={cn(sessionId === undefined ? "flex" : "hidden md:flex")}
      />
      <main
        className={cn(
          "min-w-0 flex-1 flex-col",
          sessionId === undefined ? "hidden md:flex" : "flex",
        )}
      >
        {sessionId === undefined ? (
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
          />
        )}
      </main>
    </div>
  );
};
