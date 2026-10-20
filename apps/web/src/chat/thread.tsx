import { MessagePrimitive, ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { navigate } from "../router.ts";
import type { ConfigureChange, QueuedEntry, SessionState } from "../session/connection.ts";
import { Composer } from "./composer.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { MarkdownText, ReasoningPart, ToolCallCard } from "./parts.tsx";

const UserMessage = () => (
  <MessagePrimitive.Root className="flex justify-end">
    <div className="max-w-[85%] rounded-lg bg-muted px-4 py-2 break-words whitespace-pre-wrap">
      <MessagePrimitive.Parts />
    </div>
  </MessagePrimitive.Root>
);

/** Why the model's answer ended in an error, if it did. */
const FailureNotice = () => {
  const error = useAuiState((state) => {
    const status = state.message.status;

    return status?.type === "incomplete" && status.reason === "error" ? status.error : undefined;
  });

  return error === undefined ? null : (
    <p role="alert" className="mt-2 text-sm text-destructive">
      {Predicate.isString(error) ? error : "The model failed."}
    </p>
  );
};

const AssistantMessage = () => (
  <MessagePrimitive.Root className="min-w-0 break-words">
    <MessagePrimitive.Parts
      components={{
        Text: MarkdownText,
        Reasoning: ReasoningPart,
        tools: { Fallback: ToolCallCard },
      }}
    />
    <FailureNotice />
  </MessagePrimitive.Root>
);

/**
 * A notice between turns: a Handoff, a compaction summary, or a Rollover request. Its title shows; the text it carried
 * (the Handoff the next context starts from) opens on demand.
 */
const NoticeMessage = () => {
  const title = useAuiState((state) => {
    const custom = state.message.metadata.custom.title;

    return Predicate.isString(custom) ? custom : "Notice";
  });

  const text = useAuiState((state) =>
    Arr.join(
      Arr.map(state.message.content, (part) => (part.type === "text" ? part.text : "")),
      "",
    ),
  );

  return (
    <MessagePrimitive.Root className="flex items-center gap-3 text-xs text-muted-foreground">
      <span className="h-px flex-1 bg-border" aria-hidden />
      {text === "" ? (
        <span>{title}</span>
      ) : (
        <details className="max-w-[85%] min-w-0">
          <summary className="cursor-pointer text-center select-none">{title}</summary>
          <p className="mt-2 rounded-md bg-muted px-3 py-2 text-left text-sm break-words whitespace-pre-wrap text-foreground">
            {text}
          </p>
        </details>
      )}
      <span className="h-px flex-1 bg-border" aria-hidden />
    </MessagePrimitive.Root>
  );
};

/** What renders a message of each role. */
const BY_ROLE = { user: UserMessage, assistant: AssistantMessage, system: NoticeMessage } as const;

const Header = ({ title, picker }: { title: string | undefined; picker: ReactNode }) => (
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
    <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title ?? "Session"}</h2>
    {picker}
  </header>
);

/** The chat of one Session: its transcript with live progress, a notice when disconnected, and the composer. */
export const Thread = ({
  title,
  state,
  notice,
  steerLane,
  followUpLane,
  onConfigure,
}: {
  title: string | undefined;
  state: SessionState;
  onConfigure: (change: ConfigureChange) => void;
  notice: ReactNode;
  steerLane: readonly QueuedEntry[];
  followUpLane: readonly QueuedEntry[];
}) => {
  const { view } = state;
  const problem = state.failure ?? view.error;

  // assistant-ui shows its own placeholder while the answer to the last user message has not started.
  const working =
    view.running &&
    view.live === null &&
    view.tools.length === 0 &&
    view.messages.at(-1)?.role !== "user";

  return (
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <Header
        title={title}
        picker={
          <ModelPicker
            view={view}
            picked={state.picked}
            disabled={state.status !== "live"}
            onConfigure={onConfigure}
          />
        }
      />
      {notice !== null && notice !== undefined && (
        <p
          role="status"
          className="border-b bg-muted px-4 py-1.5 text-center text-sm text-muted-foreground"
        >
          {notice}
        </p>
      )}
      <ThreadPrimitive.Viewport className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
          <ThreadPrimitive.Empty>
            <p className="py-16 text-center text-muted-foreground">
              {state.status === "live" ? "Send a message to start the conversation." : null}
            </p>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages>
            {({ message }) => {
              const Message = BY_ROLE[message.role];

              return <Message />;
            }}
          </ThreadPrimitive.Messages>
          {view.retry !== null && (
            <p role="status" className="text-sm text-muted-foreground">
              The model failed ({view.retry.error}). Retrying…
            </p>
          )}
          {working && (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <span className="pulse-dot size-1.5 rounded-full bg-success" aria-hidden />
              Working…
            </p>
          )}
        </div>
      </ThreadPrimitive.Viewport>
      {problem !== null && (
        <p role="alert" className="mx-auto w-full max-w-3xl px-4 pb-2 text-sm text-destructive">
          {problem}
        </p>
      )}
      <Composer steerLane={steerLane} followUpLane={followUpLane} sending={state.sending} />
    </ThreadPrimitive.Root>
  );
};
