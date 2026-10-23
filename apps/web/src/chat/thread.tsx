import { ThreadPrimitive } from "@assistant-ui/react";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { isModelId, THINKING_LEVELS } from "@cloudpid/config";
import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Atom from "effect/reactivity/Atom";
import { Archive, ArchiveRestore, ArrowLeft, Pencil } from "lucide-react";
import { MAX_TITLE_LENGTH, type SessionView } from "@cloudpid/protocol";
import { type ReactNode, type RefObject, useRef } from "react";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import { modelChoices, modelName } from "../models.ts";
import { settledFailureOf } from "../registry.ts";
import { navigate, SETTINGS_PATH } from "../router.ts";
import {
  configureAtom,
  sessionFailureAtom,
  sessionPickedAtom,
  sessionQueueAtom,
  sessionSendingAtom,
  sessionStatusAtom,
  sessionViewAtom,
} from "../session/atoms.ts";
import type { ConfigureChange } from "../session/state.ts";
import type { ComposerCommand } from "./commands.ts";
import { Composer } from "./composer.tsx";
import { useShownSessionId } from "./conversation.ts";
import { isLevel, ModelPicker, type PickerHandle } from "./model-picker.tsx";
import { Messages } from "./messages.tsx";
import { BrowserHandoffRequests } from "./handoff-prompt.tsx";
import { SecretRequests } from "./secret-form.tsx";
import { type Rename, saveTitleAtom, titleDraftAtom } from "./title-state.ts";

/** An archived Session: read-only until the owner unarchives it, which resolves to null or why it failed. */
export type Archived = { readonly unarchive: () => Promise<string | null> };

/** Whether the banner's unarchive is in progress. */
const Unarchiving = ScopedAtom.make(() => Atom.make(false));

const Banner = ({ archived }: { archived: Archived }) => {
  const [busy, setBusy] = useAtom(Unarchiving.use());

  return (
    <div className="px-4 pb-4">
      <div
        role="status"
        className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3"
      >
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Archive className="size-4 shrink-0" aria-hidden />
          This session is archived. Unarchive it to send messages.
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void archived.unarchive().finally(() => {
              setBusy(false);
            });
          }}
        >
          <ArchiveRestore />
          {busy ? "Unarchiving…" : "Unarchive"}
        </Button>
      </div>
    </div>
  );
};

/** In place of the composer while the Session is archived: say so, and offer to unarchive it. */
const ArchivedBanner = ({ archived }: { archived: Archived }) => (
  <Unarchiving.Provider>
    <Banner archived={archived} />
  </Unarchiving.Provider>
);

/**
 * The title and a button that turns it into a field to rename it in place. Enter (outside an IME composition) or
 * leaving the field saves, Escape cancels; the field stays, with the reason inline, while a save fails.
 */
const EditableTitle = ({ title, rename }: { title: string | undefined; rename: Rename }) => {
  const sessionId = useShownSessionId();
  const [draft, setDraft] = useAtom(titleDraftAtom(sessionId));
  const [saved, save] = useAtom(saveTitleAtom(sessionId));
  const saving = saved.waiting;
  const problem = settledFailureOf(saved);

  const close = () => {
    setDraft(null);
    save(Atom.Reset);
  };

  const submit = () => {
    if (!saving) save(rename);
  };

  if (draft === null) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <h2 className="min-w-0 truncate text-sm font-semibold">{title ?? "Session"}</h2>
        <button
          type="button"
          onClick={() => {
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
          save(Atom.Reset);
        }}
        onBlur={() => {
          // A field that could not save is left as it was, rather than tried again by the blur.
          if (problem === null) submit();
          else close();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) submit();
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
  actions,
}: {
  title: string | undefined;
  rename: Rename | undefined;
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
    <div className="flex shrink-0 items-center gap-2">{actions}</div>
  </header>
);

/** What the Session page does for the Slash commands about the Session as a whole; each resolves to null or why not. */
export type SessionCommandActions = {
  /** Start a Session in the same Environment, in a new Workspace, and open it. */
  readonly newSession?: (() => Promise<string | null>) | undefined;
  /** Archive the Session. */
  readonly archive?: (() => Promise<string | null>) | undefined;
};

const NO_ACTIONS: SessionCommandActions = {};

const NOT_LIVE = "The session is not connected; try again once it is.";

/**
 * The Slash commands about the Session as a whole: its model and thinking level (set with an argument, or the picker
 * opened without one), its title, a new Session beside it, archiving it, and the Settings.
 */
const sessionCommands = ({
  live,
  view,
  picker,
  rename,
  actions,
  onConfigure,
}: {
  live: boolean;
  view: SessionView;
  picker: RefObject<PickerHandle | null>;
  rename: Rename | undefined;
  actions: SessionCommandActions;
  onConfigure: (change: ConfigureChange) => void;
}): ComposerCommand[] => {
  const model = view.model === null ? null : `${view.model.provider}/${view.model.modelId}`;
  const models = modelChoices(model);

  const commands: ComposerCommand[] = [
    {
      name: "model",
      description: "Pick the model for this session",
      argumentHint: "[model]",
      argument: "optional",
      choices: [
        { value: "default", description: "Follow the settings" },
        ...Arr.map(models, (id) => ({
          value: modelName(id),
          description: id === model ? "In use" : undefined,
        })),
      ],
      run: (args) => {
        if (!live) return NOT_LIVE;

        if (args === "") {
          picker.current?.openModel();

          return null;
        }

        if (args === "default") {
          onConfigure({ model: null });

          return null;
        }

        const id = Option.getOrUndefined(
          Arr.findFirst(models, (choice) => choice === args || modelName(choice) === args),
        );

        if (id === undefined || !isModelId(id)) return `There is no model named ${args}.`;

        onConfigure({ model: id });

        return null;
      },
    },
    {
      name: "thinking",
      description: "Pick the thinking level for this session",
      argumentHint: "[level]",
      argument: "optional",
      choices: [
        { value: "default", description: "Follow the settings" },
        ...Arr.map(THINKING_LEVELS, (level) => ({
          value: level,
          description: level === view.thinkingLevel ? "In use" : undefined,
        })),
      ],
      run: (args) => {
        if (!live) return NOT_LIVE;

        if (args === "") {
          picker.current?.openThinking();

          return null;
        }

        if (args === "default") {
          onConfigure({ thinkingLevel: null });

          return null;
        }

        if (!isLevel(args)) return `There is no thinking level named ${args}.`;

        onConfigure({ thinkingLevel: args });

        return null;
      },
    },
    {
      name: "settings",
      description: "Open the settings",
      argument: "none",
      run: () => {
        navigate(SETTINGS_PATH);

        return null;
      },
    },
  ];

  if (rename !== undefined) {
    commands.push({
      name: "name",
      description: "Rename this session",
      argumentHint: "<title>",
      argument: "required",
      run: (title) =>
        title.length > MAX_TITLE_LENGTH
          ? `A title is at most ${MAX_TITLE_LENGTH} characters.`
          : rename.save(title),
    });
  }

  if (actions.newSession !== undefined) {
    commands.push({
      name: "new",
      description: "Start a new session in this environment",
      argument: "none",
      run: actions.newSession,
    });
  }

  if (actions.archive !== undefined) {
    commands.push({
      name: "archive",
      description: "Archive this session",
      argument: "none",
      run: actions.archive,
    });
  }

  return commands;
};

/** The chat of the Session shown: its transcript with live progress, a notice when disconnected, and the composer. */
export const Thread = ({
  title,
  rename,
  archived,
  notice,
  onStopAll,
  actions,
  commandActions = NO_ACTIONS,
}: {
  title: string | undefined;
  /** Lets the owner rename the Session from its header. */
  rename?: Rename | undefined;
  /** Set while the Session is archived: no composer, a banner to unarchive it instead. */
  archived?: Archived | undefined;
  /** Stop the run and every subagent; given while a subagent is working. */
  onStopAll?: (() => void) | undefined;
  /** Buttons in the header, after the title. */
  actions?: ReactNode;
  /** What the Session-wide Slash commands do. */
  commandActions?: SessionCommandActions | undefined;
  notice: ReactNode;
}) => {
  const sessionId = useShownSessionId();
  const status = useAtomValue(sessionStatusAtom(sessionId));
  const view = useAtomValue(sessionViewAtom(sessionId));
  const lanes = useAtomValue(sessionQueueAtom(sessionId));
  const sending = useAtomValue(sessionSendingAtom(sessionId));
  const failure = useAtomValue(sessionFailureAtom(sessionId));
  const picked = useAtomValue(sessionPickedAtom(sessionId));
  const onConfigure = useAtomSet(configureAtom(sessionId));
  const live = status === "live";
  const problem = failure ?? view.error;
  const picker = useRef<PickerHandle>(null);
  // A file dropped anywhere on the thread attaches to its composer.
  const dropZone = useRef<HTMLDivElement>(null);

  const commands = sessionCommands({
    live,
    view,
    picker,
    rename,
    actions: commandActions,
    onConfigure,
  });

  // assistant-ui shows its own placeholder while the answer to the last user message has not started.
  const working =
    view.running &&
    view.live === null &&
    view.tools.length === 0 &&
    view.messages.at(-1)?.role !== "user";

  return (
    <ThreadPrimitive.Root ref={dropZone} className="flex min-h-0 flex-1 flex-col">
      <Header title={title} rename={rename} actions={actions} />
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
              {live ? "Send a message to start the conversation." : null}
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
        <BrowserHandoffRequests />
        <SecretRequests />
      </div>
      {archived === undefined ? (
        <Composer
          steerLane={lanes.steer}
          followUpLane={lanes.followUp}
          sending={sending}
          onStopAll={onStopAll}
          commands={commands}
          dropZone={dropZone}
          tools={
            <ModelPicker
              ref={picker}
              view={view}
              picked={picked}
              disabled={!live}
              onConfigure={onConfigure}
            />
          }
        />
      ) : (
        <ArchivedBanner archived={archived} />
      )}
    </ThreadPrimitive.Root>
  );
};
