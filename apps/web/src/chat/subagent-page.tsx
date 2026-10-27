// A Subagent page (GLOSSARY.md → Subagent page; ADR-0024): the Session page scoped to one subagent. Its chat is the
// subagent's conversation (its thread, with its composer); its Session details hold its Todo List, the subagents it
// started and the Changes of its conversation's Workspace; its Pane area is its own (its Diff pane on those Changes, its
// subtree in the Subagents Pane, no Session tree Pane; the Session's shared browser and Live Views as on the Session
// page), kept in a Session layout of its own. It stays a part of its Session: Usage, the Spend limit and the Session's
// menu are the Session page's, and its header offers only the subagent's own Stop. The page names the subagent by its
// canonical ID; the Session's task graph, watched on its socket, gives the conversation.

import type { GraphAgent } from "@cloudpid/protocol";
import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { ReactNode } from "react";
import { useChangesWatch } from "../diff-pane/changes-summary.tsx";
import { InAppLink } from "../in-app-link.tsx";
import { PaneArea, PaneAreaToggle } from "../pane-area.tsx";
import { navigate, sessionPath } from "../router.ts";
import { sessionClientAtom, sessionStatusAtom, taskGraphAtom } from "../session/atoms.ts";
import { conversationKey } from "../session/conversation-key.ts";
import { layoutKey } from "../session-layout.ts";
import { showLayoutAtom } from "../session-layout-state.ts";
import { ApprovalRequests } from "./approval-card.tsx";
import { ChildThread } from "./child-thread.tsx";
import { ShownSession, ShownSubagentContext } from "./conversation.ts";
import { BrowserHandoffRequests } from "./handoff-prompt.tsx";
import { Messages } from "./messages.tsx";
import { SecretRequests } from "./secret-form.tsx";
import { CONNECTION_NOTICE } from "./session-chat.tsx";
import { SessionDetails, SessionDetailsButton } from "./session-details.tsx";
import { leaveWhenDeletedAtom } from "./session-gone.ts";
import { AgentStatus, AgentStopButton, AgentSummary } from "./subagent-card.tsx";
import { subagentOnPage } from "./subagent-page-state.ts";
import { type Archived, ArchivedBanner } from "./thread.tsx";
import { TreeBarScope } from "./tree-actions.ts";

/** The link back to the Session's page, as the breadcrumb's first step. */
const SessionCrumb = ({ sessionId, title }: { sessionId: string; title: string | undefined }) => (
  <InAppLink
    href={sessionPath(sessionId)}
    className="min-w-0 truncate text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
  >
    {title ?? "Session"}
  </InAppLink>
);

/**
 * The page's header: on a phone, the way back to the list; the breadcrumb (the Session's title, linking back to its
 * page, then the agent's ID); what the agent is (role, model, branch) under it; and the actions.
 */
const Header = ({
  sessionId,
  agentId,
  title,
  agent,
  actions,
}: {
  sessionId: string;
  agentId: string;
  title: string | undefined;
  agent: GraphAgent | undefined;
  actions?: ReactNode;
}) => (
  <header className="flex items-center gap-2 border-b px-4 py-2.5">
    <button
      type="button"
      onClick={() => {
        navigate("/");
      }}
      aria-label="Back to sessions"
      className="-ml-2 rounded-md p-2 hover:bg-accent md:hidden"
    >
      <ArrowLeft className="size-4" />
    </button>
    <div className="flex min-w-0 flex-1 flex-col">
      <nav aria-label="Breadcrumb" className="min-w-0">
        <ol className="flex min-w-0 items-center gap-1 text-sm">
          <li className="flex min-w-0 shrink items-center">
            <SessionCrumb sessionId={sessionId} title={title} />
          </li>
          <li aria-hidden className="shrink-0 text-muted-foreground">
            <ChevronRight className="size-3.5" />
          </li>
          <li aria-current="page" className="min-w-0 shrink-0 truncate">
            <h2 className="truncate font-mono text-[0.8125rem] font-semibold">{agentId}</h2>
          </li>
        </ol>
      </nav>
      {agent !== undefined && (
        <p className="flex min-w-0 items-center gap-x-2 text-xs text-muted-foreground">
          <AgentSummary agent={agent} named />
        </p>
      )}
    </div>
    <div className="flex shrink-0 items-center gap-2">{actions}</div>
  </header>
);

/** A notice over the chat: the connection's, else nothing. */
const Notice = ({ sessionId }: { sessionId: string }) => {
  const status = useAtomValue(sessionStatusAtom(sessionId));
  const notice = CONNECTION_NOTICE[status];

  return notice === undefined ? null : (
    <p
      role="status"
      className="border-b bg-muted px-4 py-1.5 text-center text-sm text-muted-foreground"
    >
      {notice}
    </p>
  );
};

/** What the page shows of a subagent the task graph does not list (any more): it was deleted. */
const Gone = ({ sessionId, title }: { sessionId: string; title: string | undefined }) => (
  <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-16 text-center">
    <p role="status" className="text-sm text-muted-foreground">
      This subagent was deleted.
    </p>
    <p className="text-sm">
      Back to <SessionCrumb sessionId={sessionId} title={title} />
    </p>
  </div>
);

/** The page of a subagent the task graph lists: its chat and its Pane area. */
const LiveSubagent = ({
  sessionId,
  agent,
  title,
  archived,
}: {
  sessionId: string;
  agent: GraphAgent;
  title: string | undefined;
  archived: Archived | undefined;
}) => {
  // The subagent's Changes, for the Session details and the Diff pane: asked again as the owner comes back to the page.
  useChangesWatch(conversationKey(sessionId, agent.conversationId));

  return (
    <ShownSubagentContext value={{ agentId: agent.id, conversationId: agent.conversationId }}>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Header
            sessionId={sessionId}
            agentId={agent.id}
            title={title}
            agent={agent}
            actions={
              <>
                <AgentStatus agent={agent} />
                {/* An archived Session's subagents are not running, and the page is read-only. */}
                {archived === undefined && <AgentStopButton agent={agent} />}
                <SessionDetailsButton />
                <PaneAreaToggle />
              </>
            }
          />
          <Notice sessionId={sessionId} />
          {/* Session details float over the chat's top right, outside its scroller so they stay put as it scrolls. */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <SessionDetails />
            <ChildThread
              conversationId={agent.conversationId}
              messages={<Messages />}
              page={{
                requests: (
                  <div className="px-4">
                    <BrowserHandoffRequests />
                    <SecretRequests />
                    <ApprovalRequests />
                  </div>
                ),
                archived:
                  archived === undefined ? undefined : <ArchivedBanner archived={archived} />,
              }}
            />
          </div>
        </div>
        <PaneArea />
      </div>
    </ShownSubagentContext>
  );
};

/** The page while its subagent is not shown: loading the task graph, or gone from it. */
const Waiting = ({
  sessionId,
  agentId,
  title,
  children,
}: {
  sessionId: string;
  agentId: string;
  title: string | undefined;
  children: ReactNode;
}) => (
  <div className="flex min-w-0 flex-1 flex-col">
    <Header sessionId={sessionId} agentId={agentId} title={title} agent={undefined} />
    <Notice sessionId={sessionId} />
    {children}
  </div>
);

/** What the Session page passes on to one of its Subagent pages, from the Session list's record. */
export interface SubagentPageProps {
  readonly sessionId: string;
  /** The subagent's canonical ID, from the page's path. */
  readonly agentId: string;
  /** The Session's title, for the breadcrumb; undefined while the list has not answered. */
  readonly title: string | undefined;
  /** Set while the Session is archived: the page is read-only. */
  readonly archived: Archived | undefined;
}

const LiveSubagentPage = ({ sessionId, agentId, title, archived }: SubagentPageProps) => {
  // The page's own layout, kept as the one shown last.
  useAtomMount(showLayoutAtom(layoutKey(sessionId, agentId)));
  // The Session deleted (here or elsewhere): its socket closed saying so, and the page leaves it.
  useAtomMount(leaveWhenDeletedAtom(sessionId));

  const shown = useAtomValue(taskGraphAtom(sessionId), (graph) => subagentOnPage(graph, agentId));

  return (
    <ShownSession.Provider value={sessionId}>
      <TreeBarScope.Provider value={{ archived: archived !== undefined }}>
        {shown.kind === "shown" ? (
          <LiveSubagent
            sessionId={sessionId}
            agent={shown.agent}
            title={title}
            archived={archived}
          />
        ) : (
          <Waiting sessionId={sessionId} agentId={agentId} title={title}>
            {shown.kind === "gone" ? (
              <Gone sessionId={sessionId} title={title} />
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground">Loading…</p>
            )}
          </Waiting>
        )}
      </TreeBarScope.Provider>
    </ShownSession.Provider>
  );
};

/** A Subagent page: its Session's socket, and the subagent's conversation once the task graph names it. */
export const SubagentPage = (props: SubagentPageProps) => {
  // Read while the page is shown, so the Session's socket is open while it is, and closes when it goes.
  const built = useAtomValue(sessionClientAtom(props.sessionId), AsyncResult.isSuccess);

  return built ? <LiveSubagentPage key={`${props.sessionId}/${props.agentId}`} {...props} /> : null;
};
