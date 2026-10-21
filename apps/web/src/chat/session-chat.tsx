import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { sessionSocketPath } from "@cloudpid/protocol";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { canStopAllBelow } from "../session/agents.ts";
import { SessionConnection, type ConnectionStatus } from "../session/connection.ts";
import { toThreadMessages } from "../session/thread-messages.ts";
import { queueAdapter, textOf } from "./queue-adapter.ts";
import { SessionProvider } from "./session-context.tsx";
import { TaskPanel, TaskPanelToggle } from "./task-panel.tsx";
import { type Archived, type Rename, Thread } from "./thread.tsx";
import { UsageBadge } from "./usage-badge.tsx";

const socketUrl = (sessionId: string): string => {
  const url = new URL(sessionSocketPath(sessionId), window.location.href);

  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

  return url.href;
};

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

/** What the Session page shows besides the chat: the archived banner, the header's menu, and leaving once deleted. */
type SessionPageProps = {
  /** Set while the Session is archived: the composer gives way to a banner that unarchives it. */
  archived?: Archived | undefined;
  /** The Session's "⋯" menu, in the header. */
  menu?: ReactNode;
  /** The Session was deleted (here or elsewhere): its socket closed saying so. */
  onDeleted?: (() => void) | undefined;
  /** Why an archive or unarchive asked on this page failed, or null. */
  problem?: string | null | undefined;
};

const LiveSession = ({
  connection,
  title,
  rename,
  archived,
  menu,
  onDeleted,
  problem,
}: {
  connection: SessionConnection;
  title: string | undefined;
  rename: Rename | undefined;
} & SessionPageProps) => {
  const state = useSyncExternalStore(connection.subscribe, connection.getState);
  const [panelOpen, setPanelOpen] = useState(false);
  const stoppable = canStopAllBelow(state.taskGraph, "root", state.view.running);

  useEffect(() => {
    if (state.status === "deleted") onDeleted?.();
  }, [state.status, onDeleted]);

  // The cards and the panel read the task graph, and the header what the Session has spent, so both are watched for as
  // long as the Session is shown.
  useEffect(() => {
    connection.watchTaskGraph();
    connection.watchUsage();
  }, [connection]);

  const messages = useMemo(() => toThreadMessages(state.view), [state.view]);
  const queue = useMemo(() => queueAdapter(connection, state.queue), [connection, state.queue]);

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: identity,
    isRunning: state.view.running,
    queue,
    // With a queue, sends go through its lanes; this is the fallback for a send that bypasses them.
    onNew: (message) => {
      connection.submit(textOf(message), "followUp");

      return Promise.resolve();
    },
    onCancel: () => {
      connection.abort();

      return Promise.resolve();
    },
  });

  return (
    <SessionProvider value={connection}>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <AssistantRuntimeProvider runtime={runtime}>
            <Thread
              title={title}
              rename={rename}
              archived={archived}
              state={state}
              notice={
                CONNECTION_NOTICE[state.status] ??
                (problem === null || problem === undefined ? undefined : (
                  <span role="alert" className="whitespace-pre-wrap text-destructive">
                    {problem}
                  </span>
                ))
              }
              steerLane={state.queue.steer}
              followUpLane={state.queue.followUp}
              onConfigure={(change) => {
                connection.configure(change);
              }}
              onAnswerSecrets={(request, values) => {
                connection.answerSecrets(request, values);
              }}
              onStopAll={
                stoppable
                  ? () => {
                      connection.abort({ subagents: true });
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
    </SessionProvider>
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
  const [connection, setConnection] = useState<SessionConnection | null>(null);

  useEffect(() => {
    const next = new SessionConnection(socketUrl(sessionId));

    setConnection(next);

    return () => {
      next.dispose();
      setConnection(null);
    };
  }, [sessionId]);

  return connection === null ? null : (
    <LiveSession connection={connection} title={title} rename={rename} {...page} />
  );
};
