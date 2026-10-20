import { ThreadPrimitive } from "@assistant-ui/react";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import { navigate } from "../router.ts";
import type { ConfigureChange, QueuedEntry, SessionState } from "../session/connection.ts";
import { Composer } from "./composer.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { Messages } from "./messages.tsx";
import { SecretRequests } from "./secret-form.tsx";

const Header = ({
  title,
  picker,
  actions,
}: {
  title: string | undefined;
  picker: ReactNode;
  actions: ReactNode;
}) => (
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
    {actions}
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
  onAnswerSecrets,
  onStopAll,
  actions,
}: {
  title: string | undefined;
  state: SessionState;
  /** Stop the run and every subagent; given while a subagent is working. */
  onStopAll?: (() => void) | undefined;
  /** Buttons in the header, after the model picker. */
  actions?: ReactNode;
  onConfigure: (change: ConfigureChange) => void;
  onAnswerSecrets: (request: string, values: Readonly<Record<string, string>> | null) => void;
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
        actions={actions}
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
          <Messages />
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
      <div className="px-4">
        <SecretRequests
          requests={state.secretRequests}
          lifetimeMinutes={state.secretLifetimeMinutes}
          disabled={state.status !== "live"}
          onAnswer={onAnswerSecrets}
        />
      </div>
      <Composer
        steerLane={steerLane}
        followUpLane={followUpLane}
        sending={state.sending}
        onStopAll={onStopAll}
      />
    </ThreadPrimitive.Root>
  );
};
