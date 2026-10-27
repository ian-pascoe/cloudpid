// A subagent's live thread: its conversation, watched on the Session's socket, with a composer to steer or queue input
// and to stop it. It is a nested assistant-ui runtime of its own, so it has its own messages, running state and queue.
// A transcript's card shows it in a box of its own height; a Subagent Pane, filling the Pane (`fill`); a Subagent page,
// as the page's chat (`page`): as wide as the Session's, its Todo List in the Session details, read-only in an archived
// Session.

import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useRef, type ReactNode } from "react";
import { cn } from "../lib/utils.ts";
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
import { conversationKey, ThreadConversation, useShownSessionId } from "./conversation.ts";
import { EarlierHistory } from "./earlier-history.tsx";
import { TreeBarScope } from "./tree-actions.ts";
import { textOf } from "./queue-adapter.ts";
import { threadMessagesAtom, threadQueueAtom } from "./thread-state.ts";
import { TodoList } from "./todo-list.tsx";

const identity = (message: ThreadMessageLike): ThreadMessageLike => message;

/** How a subagent's thread shows: in a card's box, filling a Subagent Pane, or as a Subagent page's chat. */
export type ChildThreadLayout = "card" | "pane" | "page";

/** What a Subagent page puts in its chat besides the thread: the Session's requests, and whether it is read-only. */
export interface ChildThreadPage {
  /** Over the composer: the Browser Handoffs, Secret requests and Approval requests waiting for the owner. */
  readonly requests?: ReactNode;
  /** In place of the composer, for an archived Session: the thread is read-only. */
  readonly archived?: ReactNode;
}

const LiveChildThread = ({
  sessionId,
  conversationId,
  thread,
  messages,
  layout,
  page,
}: {
  sessionId: string;
  conversationId: number;
  thread: ThreadState;
  /** The transcript's messages, rendered inside this thread's own runtime. */
  messages: ReactNode;
  layout: ChildThreadLayout;
  page: ChildThreadPage | undefined;
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
  const fill = layout !== "card";
  const wide = layout === "page";
  const archived = page?.archived;

  return (
    // A subagent's thread is not the Session tree's: its messages have no bar.
    <TreeBarScope.Provider value={null}>
      {/* Its disclosures are kept apart from the root thread's, whose messages' IDs it may share. */}
      <ThreadConversation value={conversationId}>
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadPrimitive.Root
            ref={dropZone}
            className={cn("flex flex-col", fill && "min-h-0 flex-1")}
          >
            <ThreadPrimitive.Viewport
              className={cn(
                "min-h-16 overflow-y-auto",
                fill ? "flex-1 overscroll-y-contain" : "max-h-96",
                wide && "relative",
              )}
            >
              <div
                className={cn(
                  "flex flex-col",
                  wide ? "mx-auto w-full max-w-3xl gap-6 px-4 py-6" : "gap-4 py-2",
                )}
              >
                <ThreadPrimitive.Empty>
                  <p className="py-4 text-center text-sm text-muted-foreground">Nothing yet.</p>
                </ThreadPrimitive.Empty>
                <EarlierHistory conversation={key} before={thread.view.before} />
                {messages}
              </div>
            </ThreadPrimitive.Viewport>
            {problem !== null && (
              <p
                role="alert"
                className={cn(
                  "text-sm text-destructive",
                  wide ? "mx-auto w-full max-w-3xl px-4 pb-2" : "pb-2",
                )}
              >
                {problem}
              </p>
            )}
            {/* A Subagent page shows the Todo List in its Session details, as the Session page does the root's. */}
            {!wide && <TodoList tasks={thread.todos} stale={!live} className="border-t pt-2" />}
            {page?.requests}
            {archived === undefined ? (
              <Composer
                compact={!wide}
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
            ) : (
              archived
            )}
          </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
      </ThreadConversation>
    </TreeBarScope.Provider>
  );
};

/**
 * The live thread of the subagent that runs conversation `conversationId`; watched while this is shown. With `fill`, it
 * takes the height of the column it is in, its composer at the bottom; with `page`, it is a Subagent page's chat.
 */
export const ChildThread = ({
  conversationId,
  messages,
  fill = false,
  page,
}: {
  conversationId: number;
  messages: ReactNode;
  fill?: boolean;
  /** Set on a Subagent page, where the thread is the page's chat. */
  page?: ChildThreadPage | undefined;
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
      layout={page !== undefined ? "page" : fill ? "pane" : "card"}
      page={page}
    />
  );
};
