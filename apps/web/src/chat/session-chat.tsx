import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { type ReactNode, useMemo, useState } from "react";
import { canStopAllBelow } from "../session/agents.ts";
import {
  abortAtom,
  sessionClientAtom,
  sessionQueueAtom,
  sessionStatusAtom,
  sessionViewAtom,
  submitAtom,
  taskGraphAtom,
  usageAtom,
} from "../session/atoms.ts";
import type { ConnectionStatus } from "../session/state.ts";
import { toThreadMessages } from "../session/thread-messages.ts";
import { ShownSession } from "./conversation.ts";
import { queueAdapter, textOf } from "./queue-adapter.ts";
import { leaveWhenDeletedAtom } from "./session-gone.ts";
import { TaskPanel, TaskPanelToggle } from "./task-panel.tsx";
import { type Archived, type Rename, type SessionCommandActions, Thread } from "./thread.tsx";
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
  /** Why an archive or unarchive asked on this page failed, or null. */
  problem?: string | null | undefined;
  /** What the composer's Session-wide Slash commands do. */
  commandActions?: SessionCommandActions | undefined;
};

const LiveSession = ({
  sessionId,
  title,
  rename,
  archived,
  menu,
  problem,
  commandActions,
}: {
  sessionId: string;
  title: string | undefined;
  rename: Rename | undefined;
} & SessionPageProps) => {
  const status = useAtomValue(sessionStatusAtom(sessionId));
  const view = useAtomValue(sessionViewAtom(sessionId));
  const lanes = useAtomValue(sessionQueueAtom(sessionId));
  // The cards and the panel read the task graph, and the header what the Session has spent: their atoms watch them
  // for as long as the Session is shown.
  const taskGraph = useAtomValue(taskGraphAtom(sessionId));

  useAtomMount(usageAtom(sessionId));
  // Deleted (here or elsewhere): its socket closed saying so, and the page leaves it.
  useAtomMount(leaveWhenDeletedAtom(sessionId));

  const submit = useAtomSet(submitAtom(sessionId));
  const abort = useAtomSet(abortAtom(sessionId));
  const [panelOpen, setPanelOpen] = useState(false);
  const stoppable = canStopAllBelow(taskGraph, "root", view.running);

  const messages = useMemo(() => toThreadMessages(view), [view]);

  const queue = useMemo(
    () =>
      queueAdapter(
        {
          submit: (text, whenBusy) => {
            submit({ message: text, whenBusy });
          },
        },
        lanes,
      ),
    [submit, lanes],
  );

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
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <AssistantRuntimeProvider runtime={runtime}>
            <Thread
              title={title}
              rename={rename}
              archived={archived}
              notice={
                CONNECTION_NOTICE[status] ??
                (problem === null || problem === undefined ? undefined : (
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
                  <TaskPanelToggle
                    open={panelOpen}
                    onToggle={() => {
                      setPanelOpen(!panelOpen);
                    }}
                  />
                  {menu}
                </>
              }
            />
          </AssistantRuntimeProvider>
        </div>
        {panelOpen && (
          <TaskPanel
            className="fixed inset-0 z-20 md:static md:inset-auto md:z-auto md:w-96 md:shrink-0"
            onClose={() => {
              setPanelOpen(false);
            }}
          />
        )}
      </div>
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
    // Another Session starts over, as its page's own state (the task panel) belongs to the one before.
    <LiveSession key={sessionId} sessionId={sessionId} title={title} rename={rename} {...page} />
  ) : null;
};
