import type { SessionRecord } from "@cloudpid/protocol";
import { useAtomMount, useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { pageProblemAtom } from "./app-state.ts";
import { revealShownAtom } from "./collapsed-groups.ts";
import { forgetDismissedAtom } from "./list-subagents.ts";
import { SessionChat } from "./chat/session-chat.tsx";
import { SubagentPage } from "./chat/subagent-page.tsx";
import { cn } from "./lib/utils.ts";
import { pushSyncAtom } from "./push-state.ts";
import { navigate, pageAtom, sessionPath, type Page } from "./router.ts";
import { useSessionActions } from "./session-actions.ts";
import { SessionMenu } from "./session-menu.tsx";
import { currentSessionAtom, newSessionPlace, sessionListAtom } from "./sessions.ts";
import { SettingsPage } from "./settings-page.tsx";
import { Sidebar, sessionTitle, type ShownPage } from "./sidebar.tsx";
import { DraftComposer } from "./draft-composer.tsx";
import { EnvironmentsPage } from "./environments-page.tsx";
import { SkillDirectoryPage, SkillsPage } from "./skills-page.tsx";
import { SkillOwnerPage } from "./skills-owner.tsx";
import { SkillRepoPage } from "./skills-repo.tsx";
import { SkillPage } from "./skills-skill.tsx";
import { environmentNamesAtom } from "./environments-state.ts";

/**
 * The line under a Fork's or a Clone's title: "Forked from" or "Cloned from" the Session it was made from, a link to it
 * while it is there.
 */
const Origin = ({ origin }: { origin: NonNullable<SessionRecord["origin"]> }) => {
  const source = useAtomValue(sessionListAtom, (list) =>
    Option.getOrUndefined(Arr.findFirst(list ?? [], (known) => known.id === origin.session)),
  );

  const made = origin.kind === "fork" ? "Forked from" : "Cloned from";

  return source === undefined ? (
    <>{made} a deleted session</>
  ) : (
    <>
      {made}{" "}
      <button
        type="button"
        onClick={() => {
          navigate(sessionPath(source.id));
        }}
        className="underline underline-offset-2 hover:text-foreground"
      >
        {sessionTitle(source)}
      </button>
    </>
  );
};

/** Session `sessionId`'s page: its chat, with what the list knows of it. */
const SessionPage = ({ sessionId }: { sessionId: string }) => {
  const session = useAtomValue(currentSessionAtom);
  const names = useAtomValue(environmentNamesAtom);
  const problem = useAtomValue(pageProblemAtom);
  // The page shows the failure of a new Session, an archive or an unarchive, the menu's or the composer's.
  const actions = useSessionActions(pageProblemAtom);

  const environmentName =
    session === undefined ? undefined : (names[session.environment] ?? session.environment);

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
      origin={session?.origin === undefined ? undefined : <Origin origin={session.origin} />}
      // The composer's `/new` and `/archive`, for the Session shown.
      commandActions={
        session === undefined
          ? undefined
          : {
              newSession: () => actions.create(newSessionPlace(session)),
              archive: () => actions.archive(session.id),
            }
      }
      menu={
        session === undefined || environmentName === undefined ? undefined : (
          <SessionMenu session={session} environmentName={environmentName} actions={actions} />
        )
      }
    />
  );
};

/**
 * The Subagent page of agent `agentId` in Session `sessionId`: the Session page scoped to that subagent, with what the
 * list knows of the Session (its title for the breadcrumb, whether it is archived).
 */
const SubagentPageOf = ({ sessionId, agentId }: { sessionId: string; agentId: string }) => {
  const session = useAtomValue(currentSessionAtom);
  const actions = useSessionActions(pageProblemAtom);

  return (
    <SubagentPage
      sessionId={sessionId}
      agentId={agentId}
      title={session === undefined ? undefined : sessionTitle(session)}
      archived={
        session?.archivedAt === null || session === undefined
          ? undefined
          : { unarchive: () => actions.unarchive(session.id) }
      }
    />
  );
};

/** The Session page or Subagent page `page` is, as the list marks it; undefined for any other page. */
const shownOf = (page: Page): ShownPage | undefined => {
  if (page.kind === "session") return { sessionId: page.sessionId };

  if (page.kind === "subagent") return { sessionId: page.sessionId, agentId: page.agentId };

  return undefined;
};

export const App = () => {
  // At startup, a device that already gets notifications is re-told to the Registry.
  useAtomMount(pushSyncAtom);
  // The shown Session's group in the list expands as it is shown, even while the list is hidden (a phone).
  useAtomMount(revealShownAtom);
  // A Session's subagents, collapsed in the list on its page, reveal again the next time it is shown.
  useAtomMount(forgetDismissedAtom);

  const page = useAtomValue(pageAtom);
  // On a narrow screen the list is shown alone; any other page takes its place.
  const listOnly = page.kind === "empty";

  return (
    // The document never scrolls: each page scrolls inside itself. An element absolutely placed without a positioned
    // scroller around it (an `sr-only` label, say) would otherwise be placed against the document and make it scrollable
    // under the app, and focus or a scroll past a modal's end would then move the whole app up, leaving a blank strip
    // below. `relative` makes the shell their containing block, and `overflow-clip` (unlike `hidden`, not scrollable
    // even by focus) keeps them from growing the document.
    <div className="relative flex h-dvh overflow-clip">
      {/* On a narrow screen the list and the chat take turns. */}
      <Sidebar
        shown={shownOf(page)}
        settingsActive={page.kind === "settings"}
        environmentsActive={page.kind === "environments"}
        skillsActive={
          page.kind === "skills" ||
          page.kind === "skillOwner" ||
          page.kind === "skillRepo" ||
          page.kind === "skill"
        }
        className={cn(listOnly ? "flex" : "hidden md:flex")}
      />
      <main className={cn("min-w-0 flex-1 flex-col", listOnly ? "hidden md:flex" : "flex")}>
        {Match.value(page).pipe(
          Match.discriminatorsExhaustive("kind")({
            settings: () => <SettingsPage />,
            environments: () => <EnvironmentsPage />,
            skills: () => <SkillsPage />,
            skillOwner: ({ owner }) => <SkillOwnerPage owner={owner} />,
            skillRepo: ({ owner, repo }) => <SkillRepoPage owner={owner} repo={repo} />,
            skill: ({ owner, repo, skill }) => (
              <SkillPage owner={owner} repo={repo} skill={skill} />
            ),
            draft: () => <DraftComposer />,
            // On a wide screen the start page is the draft; a narrow one shows the list alone (`listOnly`).
            empty: () => <DraftComposer />,
            session: ({ sessionId }) => <SessionPage key={sessionId} sessionId={sessionId} />,
            subagent: ({ sessionId, agentId }) => (
              <SubagentPageOf
                key={`${sessionId}/${agentId}`}
                sessionId={sessionId}
                agentId={agentId}
              />
            ),
          }),
        )}
      </main>
    </div>
  );
};
