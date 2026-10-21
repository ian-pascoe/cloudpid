import { useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Match from "effect/Match";
import { pageProblemAtom, sessionGoneAtom } from "./app-state.ts";
import { SessionChat } from "./chat/session-chat.tsx";
import { cn } from "./lib/utils.ts";
import { pushSyncAtom } from "./push-state.ts";
import { pageAtom } from "./router.ts";
import { useSessionActions } from "./session-actions.ts";
import { SessionMenu } from "./session-menu.tsx";
import { currentSessionAtom } from "./sessions.ts";
import { SettingsPage } from "./settings-page.tsx";
import { Sidebar, sessionTitle } from "./sidebar.tsx";
import { WorkspacesPage } from "./workspaces-page.tsx";
import { workspaceNamesAtom } from "./workspaces-state.ts";

/** The Session page's actions: a failure is shown on the page. */
const usePageActions = () => {
  const actions = useSessionActions();
  const setProblem = useAtomSet(pageProblemAtom);

  const shown = (action: (id: string) => Promise<string | null>) => (id: string) => {
    setProblem(null);

    return action(id).then((failure) => {
      setProblem(failure);

      return failure;
    });
  };

  return {
    ...actions,
    archive: shown(actions.archive),
    unarchive: shown(actions.unarchive),
  };
};

/** Session `sessionId`'s page: its chat, with what the list knows of it. */
const SessionPage = ({ sessionId }: { sessionId: string }) => {
  const session = useAtomValue(currentSessionAtom);
  const names = useAtomValue(workspaceNamesAtom);
  const problem = useAtomValue(pageProblemAtom);
  const setProblem = useAtomSet(pageProblemAtom);
  const gone = useAtomSet(sessionGoneAtom);
  const actions = usePageActions();

  const workspaceName =
    session === undefined ? undefined : (names[session.workspace] ?? session.workspace);

  return (
    <SessionChat
      sessionId={sessionId}
      title={session === undefined ? undefined : sessionTitle(session)}
      rename={
        session === undefined
          ? undefined
          : {
              current: session.title ?? "",
              save: (title) => actions.rename(session.id, title),
            }
      }
      archived={
        session?.archivedAt === null || session === undefined
          ? undefined
          : { unarchive: () => actions.unarchive(session.id) }
      }
      problem={problem}
      // The composer's `/new` and `/archive`, for the Session shown.
      commandActions={
        session === undefined
          ? undefined
          : {
              newSession: () =>
                actions
                  .create(
                    session.repo === null
                      ? { workspace: session.workspace }
                      : { workspace: session.workspace, repo: session.repo },
                  )
                  .then((created) =>
                    created === undefined ? "The session could not be created." : null,
                  ),
              archive: () => actions.archive(session.id),
            }
      }
      menu={
        session === undefined || workspaceName === undefined ? undefined : (
          <SessionMenu
            session={session}
            workspaceName={workspaceName}
            actions={actions}
            onFailure={setProblem}
          />
        )
      }
      onDeleted={() => {
        gone(sessionId);
      }}
    />
  );
};

export const App = () => {
  // At startup, a device that already gets notifications is re-told to the Registry.
  useAtomMount(pushSyncAtom);

  const page = useAtomValue(pageAtom);
  const { archive, unarchive, delete: deleteSession } = useSessionActions();
  // On a narrow screen the list is shown alone; any other page takes its place.
  const listOnly = page.kind === "empty";

  return (
    <div className="flex h-dvh">
      {/* On a narrow screen the list and the chat take turns. */}
      <Sidebar
        actions={{ archive, unarchive, delete: deleteSession }}
        activeId={page.kind === "session" ? page.sessionId : undefined}
        settingsActive={page.kind === "settings"}
        workspacesActive={page.kind === "workspaces"}
        className={cn(listOnly ? "flex" : "hidden md:flex")}
      />
      <main className={cn("min-w-0 flex-1 flex-col", listOnly ? "hidden md:flex" : "flex")}>
        {Match.value(page).pipe(
          Match.discriminatorsExhaustive("kind")({
            settings: () => <SettingsPage />,
            workspaces: () => <WorkspacesPage />,
            empty: () => (
              <div className="m-auto max-w-sm px-6 text-center">
                <h2 className="text-lg font-semibold">Pick a session, or start a new one</h2>
                <p className="mt-2 text-sm text-muted-foreground">
                  A session keeps its conversation and keeps working when this page is closed.
                </p>
              </div>
            ),
            session: ({ sessionId }) => <SessionPage key={sessionId} sessionId={sessionId} />,
          }),
        )}
      </main>
    </div>
  );
};
