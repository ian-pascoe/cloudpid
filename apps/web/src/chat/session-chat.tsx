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
import { type Rename, Thread } from "./thread.tsx";

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
};

const LiveSession = ({
  connection,
  title,
  rename,
}: {
  connection: SessionConnection;
  title: string | undefined;
  rename: Rename | undefined;
}) => {
  const state = useSyncExternalStore(connection.subscribe, connection.getState);
  const [panelOpen, setPanelOpen] = useState(false);
  const stoppable = canStopAllBelow(state.taskGraph, "root", state.view.running);

  // The cards and the panel read the task graph, so it is watched for as long as the Session is shown.
  useEffect(() => {
    connection.watchTaskGraph();
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
              state={state}
              notice={CONNECTION_NOTICE[state.status]}
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
                <TaskPanelToggle
                  open={panelOpen}
                  onToggle={() => {
                    setPanelOpen(!panelOpen);
                  }}
                />
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
}: {
  sessionId: string;
  title: string | undefined;
  rename?: Rename | undefined;
}) => {
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
    <LiveSession connection={connection} title={title} rename={rename} />
  );
};
