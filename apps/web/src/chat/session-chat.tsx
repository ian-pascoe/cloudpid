import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { canStopAllBelow } from "../session/agents.ts";
import {
  abortAtom,
  answerSecretsAtom,
  configureAtom,
  sessionClientAtom,
  sessionQueueAtom,
  sessionStateAtom,
  sessionStatusAtom,
  sessionViewAtom,
  submitAtom,
  taskGraphAtom,
  usageAtom,
} from "../session/atoms.ts";
import type { SessionClient } from "../session/client.ts";
import type { ConnectionStatus } from "../session/state.ts";
import { toThreadMessages } from "../session/thread-messages.ts";
import { queueAdapter, textOf } from "./queue-adapter.ts";
import {
  type Connection,
  connectionOf,
  SessionIdProvider,
  SessionProvider,
} from "./session-context.tsx";
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
  /** What the composer's Session-wide Slash commands do. */
  commandActions?: SessionCommandActions | undefined;
};

const LiveSession = ({
  sessionId,
  connection,
  title,
  rename,
  archived,
  menu,
  onDeleted,
  problem,
  commandActions,
}: {
  sessionId: string;
  connection: Connection;
  title: string | undefined;
  rename: Rename | undefined;
} & SessionPageProps) => {
  // The whole state is the thread's until step 6 gives it slices of its own; the rest here reads only its slices.
  const state = useAtomValue(sessionStateAtom(sessionId));
  const status = useAtomValue(sessionStatusAtom(sessionId));
  const view = useAtomValue(sessionViewAtom(sessionId));
  const lanes = useAtomValue(sessionQueueAtom(sessionId));
  // The cards and the panel read the task graph, and the header what the Session has spent: their atoms watch them
  // for as long as the Session is shown.
  const taskGraph = useAtomValue(taskGraphAtom(sessionId));

  useAtomMount(usageAtom(sessionId));

  const submit = useAtomSet(submitAtom(sessionId));
  const configure = useAtomSet(configureAtom(sessionId));
  const abort = useAtomSet(abortAtom(sessionId));
  const answerSecrets = useAtomSet(answerSecretsAtom(sessionId));
  const [panelOpen, setPanelOpen] = useState(false);
  const stoppable = canStopAllBelow(taskGraph, "root", view.running);

  useEffect(() => {
    if (status === "deleted") onDeleted?.();
  }, [status, onDeleted]);

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
    <SessionProvider value={connection}>
      <SessionIdProvider value={sessionId}>
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <AssistantRuntimeProvider runtime={runtime}>
              <Thread
                title={title}
                rename={rename}
                archived={archived}
                state={state}
                notice={
                  CONNECTION_NOTICE[status] ??
                  (problem === null || problem === undefined ? undefined : (
                    <span role="alert" className="whitespace-pre-wrap text-destructive">
                      {problem}
                    </span>
                  ))
                }
                steerLane={lanes.steer}
                followUpLane={lanes.followUp}
                onConfigure={configure}
                commandActions={commandActions}
                onAnswerSecrets={(request, values) => {
                  answerSecrets({ request, values });
                }}
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
      </SessionIdProvider>
    </SessionProvider>
  );
};

/** The client in `result`, once it is built. */
const builtClient = (result: AsyncResult.AsyncResult<SessionClient>): SessionClient | null =>
  result.pipe(AsyncResult.value, Option.getOrNull);

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
  const client = useAtomValue(sessionClientAtom(sessionId), builtClient);
  const connection = useMemo(() => (client === null ? null : connectionOf(client)), [client]);

  return connection === null ? null : (
    // Another Session starts over, as its page's own state (the task panel) belongs to the one before.
    <LiveSession
      key={sessionId}
      sessionId={sessionId}
      connection={connection}
      title={title}
      rename={rename}
      {...page}
    />
  );
};
