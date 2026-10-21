// @effect-diagnostics asyncFunction:off -- browser code in a React app with no Effect runtime: promises are the platform here.

import { ThreadPrimitive } from "@assistant-ui/react";
import { ArrowLeft, Pencil } from "lucide-react";
import { MAX_TITLE_LENGTH } from "@cloudpid/protocol";
import { type ReactNode, useRef, useState } from "react";
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
  /** Resolves to null when the title was saved, or to why it was not. */
  readonly save: (title: string) => Promise<string | null>;
};

/**
 * The title and a button that turns it into a field to rename it in place. Enter (outside an IME composition) or
 * leaving the field saves, Escape cancels; the field stays, with the reason inline, while a save fails.
 */
const EditableTitle = ({ title, rename }: { title: string | undefined; rename: Rename }) => {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Escape and a finished save close the field, which blurs it: that blur is not a save.
  const closing = useRef(false);

  const close = () => {
    closing.current = true;
    setDraft(null);
    setProblem(null);
  };

  const save = async () => {
    if (draft === null || saving || closing.current) return;

    const next = draft.trim();

    if (next === "" || next === rename.current) {
      close();

      return;
    }

    setSaving(true);

    const failure = await rename.save(next);

    setSaving(false);

    if (failure === null) close();
    else setProblem(failure);
  };

  if (draft === null) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <h2 className="min-w-0 truncate text-sm font-semibold">{title ?? "Session"}</h2>
        <button
          type="button"
          onClick={() => {
            closing.current = false;
            setDraft(rename.current);
          }}
          aria-label={`Rename ${title ?? "session"}`}
          className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Pencil className="size-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="min-w-0 flex-1">
      <Input
        autoFocus
        aria-label="Session title"
        aria-invalid={problem !== null}
        value={draft}
        maxLength={MAX_TITLE_LENGTH}
        disabled={saving}
        className="h-8 w-full font-semibold"
        onChange={(event) => {
          setDraft(event.target.value);
          setProblem(null);
        }}
        onBlur={() => {
          // A field that could not save is left as it was, rather than tried again by the blur.
          if (problem === null) void save();
          else close();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) void save();
          else if (event.key === "Escape") close();
        }}
      />
      {problem !== null && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {problem}
        </p>
      )}
    </div>
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
