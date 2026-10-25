import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { ReactNode } from "react";
import { drainFirstMessageAtom } from "../draft-state.ts";
import { PaneArea, PaneAreaToggle } from "../pane-area.tsx";
import { canStopAllBelow } from "../session/agents.ts";
import {
  abortAtom,
  sessionClientAtom,
  sessionStatusAtom,
  sessionViewAtom,
  submitAtom,
  taskGraphAtom,
  usageAtom,
} from "../session/atoms.ts";
import type { ConnectionStatus } from "../session/state.ts";
import { conversationKey, ShownSession } from "./conversation.ts";
import { textOf } from "./queue-adapter.ts";
import { leaveWhenDeletedAtom } from "./session-gone.ts";
import { TreeBarScope, useForkNotice } from "./tree-actions.ts";
import { TreeDialogs } from "./tree-dialogs.tsx";
import { threadMessagesAtom, threadQueueAtom } from "./thread-state.ts";
import { type Archived, type SessionCommandActions, Thread } from "./thread.tsx";
import type { Rename } from "./title-state.ts";
import { UsageBadge } from "./usage-badge.tsx";

const identity = (message: ThreadMessageLike): ThreadMessageLike => message;

const CONNECTION_NOTICE: Partial<Record<ConnectionStatus, ReactNode>> = {
  connecting: "Connecting…",
  reconnecting: "Connection lost. Reconnecting…",
  "signed-out": (
    <>
      Your sign-in has expired.{" "}
      <button
        type="button"
        className="font-medium text-foreground underline underline-offset-2"
        onClick={() => {
          window.location.reload();
        }}
      >
        Reload
      </button>{" "}
      to sign in again.
    </>
  ),
  missing: "This session no longer exists.",
  deleted: "This session was deleted.",
};

/** What the Session page shows besides the chat: the archived banner and the header's menu. */
type SessionPageProps = {
  /** Set while the Session is archived: the composer gives way to a banner that unarchives it. */
  archived?: Archived | undefined;
  /** The Session's "⋯" menu, in the header. */
  menu?: ReactNode;
  /** Why a new Session, an archive or an unarchive asked on this page failed, or null. */
  problem?: string | null | undefined;
  /** What the composer's Session-wide Slash commands do. */
  commandActions?: SessionCommandActions | undefined;
  /** Under the title: the Session this one is a Fork or Clone of. */
  origin?: ReactNode;
};

const LiveSession = ({
  sessionId,
  title,
  rename,
  archived,
  menu,
  problem,
  commandActions,
  origin,
}: {
  sessionId: string;
  title: string | undefined;
  rename: Rename | undefined;
} & SessionPageProps) => {
  const status = useAtomValue(sessionStatusAtom(sessionId));
  const forkNotice = useForkNotice(sessionId);
  const view = useAtomValue(sessionViewAtom(sessionId));
  const root = conversationKey(sessionId, undefined);
  const messages = useAtomValue(threadMessagesAtom(root));
  const queue = useAtomValue(threadQueueAtom(root));
  // The cards and the Tasks Pane read the task graph, and the header what the Session has spent: their atoms watch them
  // for as long as the Session is shown.
  const taskGraph = useAtomValue(taskGraphAtom(sessionId));

  useAtomMount(usageAtom(sessionId));
  // Deleted (here or elsewhere): its socket closed saying so, and the page leaves it.
  useAtomMount(leaveWhenDeletedAtom(sessionId));
  // A first message written in the draft is sent now that the Session's client is built.
  useAtomMount(drainFirstMessageAtom(sessionId));

  const submit = useAtomSet(submitAtom(sessionId));
  const abort = useAtomSet(abortAtom(sessionId));
  const stoppable = canStopAllBelow(taskGraph, "root", view.running);

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: identity,
    isRunning: view.running,
    queue,
    // With a queue, sends go through its lanes; this is the fallback for a send that bypasses them.
    onNew: (message) => {
      submit({ message: textOf(message), whenBusy: "followUp" });

      return Promise.resolve();
    },
    onCancel: () => {
      abort({});

      return Promise.resolve();
    },
  });

  return (
    <ShownSession.Provider value={sessionId}>
      <TreeBarScope.Provider value={{ archived: archived !== undefined }}>
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <AssistantRuntimeProvider runtime={runtime}>
              <Thread
                title={title}
                subtitle={origin}
                rename={rename}
                archived={archived}
                notice={
                  CONNECTION_NOTICE[status] ??
                  (problem === null || problem === undefined ? (
                    forkNotice
                  ) : (
                    <span role="alert" className="whitespace-pre-wrap text-destructive">
                      {problem}
                    </span>
                  ))
                }
                commandActions={commandActions}
                onStopAll={
                  stoppable
                    ? () => {
                        abort({ subagents: true });
                      }
                    : undefined
                }
                actions={
                  <>
                    <UsageBadge />
                    {menu}
                    <PaneAreaToggle />
                  </>
                }
              />
            </AssistantRuntimeProvider>
          </div>
          <PaneArea />
          <TreeDialogs />
        </div>
      </TreeBarScope.Provider>
    </ShownSession.Provider>
  );
};

/** One Session's chat: its socket, and the thread assistant-ui renders from the Session's events. */
export const SessionChat = ({
  sessionId,
  title,
  rename,
  ...page
}: {
  sessionId: string;
  title: string | undefined;
  rename?: Rename | undefined;
} & SessionPageProps) => {
  // Read while the chat is shown, so the Session's socket is open while it is, and closes when it goes.
  const built = useAtomValue(sessionClientAtom(sessionId), AsyncResult.isSuccess);

  return built ? (
    // Another Session starts over, as its page's own state (an agent's open row in the Tasks Pane) belongs to the one before.
    <LiveSession key={sessionId} sessionId={sessionId} title={title} rename={rename} {...page} />
  ) : null;
};
