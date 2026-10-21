// A subagent's live thread: its conversation, watched on the Session's socket, with a composer to steer or queue input
// and to stop it. It is a nested assistant-ui runtime of its own, so it has its own messages, running state and queue.

import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useRef, type ReactNode } from "react";
import { agentOfConversation, canStopAllBelow } from "../session/agents.ts";
import {
  abortAtom,
  sessionStatusAtom,
  submitAtom,
  taskGraphAtom,
  threadAtom,
} from "../session/atoms.ts";
import { type ThreadState } from "../session/state.ts";
import { Composer } from "./composer.tsx";
import { conversationKey, useShownSessionId } from "./conversation.ts";
import { textOf } from "./queue-adapter.ts";
import { threadMessagesAtom, threadQueueAtom } from "./thread-state.ts";
import { TodoList } from "./todo-list.tsx";

const identity = (message: ThreadMessageLike): ThreadMessageLike => message;

const LiveChildThread = ({
  sessionId,
  conversationId,
  thread,
  messages,
}: {
  sessionId: string;
  conversationId: number;
  thread: ThreadState;
  /** The transcript's messages, rendered inside this thread's own runtime. */
  messages: ReactNode;
}) => {
  const submit = useAtomSet(submitAtom(sessionId));
  const abort = useAtomSet(abortAtom(sessionId));
  const graph = useAtomValue(taskGraphAtom(sessionId));
  const agent = agentOfConversation(graph, conversationId);
  const stopAll = canStopAllBelow(graph, agent?.id ?? "", thread.view.running);
  const live = useAtomValue(sessionStatusAtom(sessionId), (status) => status === "live");

  const key = conversationKey(sessionId, conversationId);
  const threadMessages = useAtomValue(threadMessagesAtom(key));
  const queue = useAtomValue(threadQueueAtom(key));

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: threadMessages,
    convertMessage: identity,
    isRunning: thread.view.running,
    queue,
    onNew: (message) => {
      submit({ message: textOf(message), whenBusy: "followUp", conversationId });

      return Promise.resolve();
    },
    onCancel: () => {
      abort({ conversationId });

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
                  abort({ conversationId, subagents: true });
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
  const sessionId = useShownSessionId();
  // Reading the thread watches it on the Session's socket, for as long as this is shown.
  const thread = useAtomValue(threadAtom({ sessionId, conversationId }));

  if (thread === null || thread.status === "loading") {
    return <p className="py-2 text-sm text-muted-foreground">Loading…</p>;
  }

  if (thread.status === "failed") {
    return (
      <p role="alert" className="py-2 text-sm text-destructive">
        {thread.failure ?? "The thread could not be opened."}
      </p>
    );
  }

  return (
    <LiveChildThread
      sessionId={sessionId}
      conversationId={conversationId}
      thread={thread}
      messages={messages}
    />
  );
};
