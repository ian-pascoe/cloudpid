import { ThreadPrimitive } from "@assistant-ui/react";
import { ArrowLeft, Pencil } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Input } from "../components/ui/input.tsx";
import { navigate } from "../router.ts";
import type { ConfigureChange, QueuedEntry, SessionState } from "../session/connection.ts";
import { Composer } from "./composer.tsx";
import { ModelPicker } from "./model-picker.tsx";
import { Messages } from "./messages.tsx";
import { BrowserHandoffRequests } from "./handoff-prompt.tsx";
import { SecretRequests } from "./secret-form.tsx";

/** Naming the Session: its title now ("" while it has none), and how to save a new one. */
export type Rename = {
  readonly current: string;
  /** Resolves to whether the title was saved. */
  readonly save: (title: string) => Promise<boolean>;
};

/** The title, which the owner renames in place: Enter saves, Escape or leaving the field cancels. */
const EditableTitle = ({ title, rename }: { title: string | undefined; rename: Rename }) => {
  const [draft, setDraft] = useState<string | null>(null);

  if (draft === null) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(rename.current);
        }}
        aria-label="Rename session"
        title="Rename session"
        className="group flex min-w-0 flex-1 items-center gap-2 rounded-md text-left hover:text-foreground"
      >
        <h2 className="min-w-0 truncate text-sm font-semibold">{title ?? "Session"}</h2>
        <Pencil className="size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
      </button>
    );
  }

  const save = () => {
    const next = draft.trim();

    setDraft(null);

    if (next !== "" && next !== rename.current) void rename.save(next);
  };

  return (
    <Input
      autoFocus
      aria-label="Session title"
      value={draft}
      maxLength={200}
      className="h-8 flex-1 font-semibold"
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onBlur={() => {
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") save();
        else if (event.key === "Escape") setDraft(null);
      }}
    />
  );
};

const Header = ({
  title,
  rename,
  picker,
  actions,
}: {
  title: string | undefined;
  rename: Rename | undefined;
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
    {rename === undefined ? (
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{title ?? "Session"}</h2>
    ) : (
      <EditableTitle title={title} rename={rename} />
    )}
    {picker}
    {actions}
  </header>
);

/** The chat of one Session: its transcript with live progress, a notice when disconnected, and the composer. */
export const Thread = ({
  title,
  rename,
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
  /** Lets the owner rename the Session from its header. */
  rename?: Rename | undefined;
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
        rename={rename}
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
        <BrowserHandoffRequests requests={state.browserHandoffRequests} graph={state.taskGraph} />
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
