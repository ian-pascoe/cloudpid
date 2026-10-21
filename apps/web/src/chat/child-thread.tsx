// A subagent's live thread: its conversation, watched on the Session's socket, with a composer to steer or queue input
// and to stop it. It is a nested assistant-ui runtime of its own, so it has its own messages, running state and queue.

// @effect-diagnostics preferEffectArray:off -- browser code in a React app with no Effect runtime.

import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { type ThreadState } from "../session/state.ts";
import { toThreadMessages } from "../session/thread-messages.ts";
import { agentOfConversation, canStopAllBelow } from "../session/agents.ts";
import { Composer } from "./composer.tsx";
import { queueAdapter, textOf } from "./queue-adapter.ts";
import { useConnection, useSession } from "./session-context.tsx";
import { TodoList } from "./todo-list.tsx";

const identity = (message: ThreadMessageLike): ThreadMessageLike => message;

const LiveChildThread = ({
  conversationId,
  thread,
  messages,
}: {
  conversationId: number;
  thread: ThreadState;
  /** The transcript's messages, rendered inside this thread's own runtime. */
  messages: ReactNode;
}) => {
  const connection = useConnection();
  const agent = useSession((state) => agentOfConversation(state.taskGraph, conversationId));

  const stopAll = useSession((state) =>
    canStopAllBelow(state.taskGraph, agent?.id ?? "", thread.view.running),
  );

  const live = useSession((state) => state.status === "live");

  const threadMessages = useMemo(() => toThreadMessages(thread.view), [thread.view]);

  const queue = useMemo(
    () =>
      queueAdapter(
        { submit: (text, whenBusy) => connection.submit(text, whenBusy, conversationId) },
        thread.queue,
      ),
    [connection, conversationId, thread.queue],
  );

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: threadMessages,
    convertMessage: identity,
    isRunning: thread.view.running,
    queue,
    onNew: (message) => {
      connection.submit(textOf(message), "followUp", conversationId);

      return Promise.resolve();
    },
    onCancel: () => {
      connection.abort({ conversationId });

      return Promise.resolve();
    },
  });

  const problem = thread.failure ?? thread.view.error;
  // A file dropped on the subagent's thread attaches to its composer, not the Session's.
  const dropZone = useRef<HTMLDivElement>(null);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root ref={dropZone} className="flex flex-col">
        <ThreadPrimitive.Viewport className="max-h-96 min-h-16 overflow-y-auto">
          <div className="flex flex-col gap-4 py-2">
            <ThreadPrimitive.Empty>
              <p className="py-4 text-center text-sm text-muted-foreground">Nothing yet.</p>
            </ThreadPrimitive.Empty>
            {messages}
          </div>
        </ThreadPrimitive.Viewport>
        {problem !== null && (
          <p role="alert" className="pb-2 text-sm text-destructive">
            {problem}
          </p>
        )}
        <TodoList tasks={thread.todos} stale={!live} className="border-t pt-2" />
        <Composer
          compact
          who={agent?.id ?? "the agent"}
          conversationId={conversationId}
          dropZone={dropZone}
          steerLane={thread.queue.steer}
          followUpLane={thread.queue.followUp}
          sending={thread.sending}
          onStopAll={
            stopAll
              ? () => {
                  connection.abort({ conversationId, subagents: true });
                }
              : undefined
          }
        />
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
};

/** The live thread of the subagent that runs conversation `conversationId`; watched while this is shown. */
export const ChildThread = ({
  conversationId,
  messages,
}: {
  conversationId: number;
  messages: ReactNode;
}) => {
  const connection = useConnection();
  const thread = useSession((state) => state.threads[String(conversationId)]);

  useEffect(() => connection.watchThread(conversationId), [connection, conversationId]);

  if (thread === undefined || thread.status === "loading") {
    return <p className="py-2 text-sm text-muted-foreground">Loading…</p>;
  }

  if (thread.status === "failed") {
    return (
      <p role="alert" className="py-2 text-sm text-destructive">
        {thread.failure ?? "The thread could not be opened."}
      </p>
    );
  }

  return <LiveChildThread conversationId={conversationId} thread={thread} messages={messages} />;
};
