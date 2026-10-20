import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { sessionSocketPath } from "@cloudpid/protocol";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { SessionConnection, type ConnectionStatus } from "../session/connection.ts";
import { toThreadMessages } from "../session/thread-messages.ts";
import { queueAdapter, textOf } from "./queue-adapter.ts";
import { Thread } from "./thread.tsx";

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
}: {
  connection: SessionConnection;
  title: string | undefined;
}) => {
  const state = useSyncExternalStore(connection.subscribe, connection.getState);
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
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread
        title={title}
        state={state}
        notice={CONNECTION_NOTICE[state.status]}
        steerLane={state.queue.steer}
        followUpLane={state.queue.followUp}
      />
    </AssistantRuntimeProvider>
  );
};

/** One Session's chat: its socket, and the thread assistant-ui renders from the Session's events. */
export const SessionChat = ({
  sessionId,
  title,
}: {
  sessionId: string;
  title: string | undefined;
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

  return connection === null ? null : <LiveSession connection={connection} title={title} />;
};
