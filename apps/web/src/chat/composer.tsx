// @effect-diagnostics preferEffectArray:off asyncFunction:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { ArrowUp, ChevronUp, CornerUpRight, ListPlus, Square } from "lucide-react";
import {
  type SubmitEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Menu, MenuItem } from "../components/ui/menu.tsx";
import { cn } from "../lib/utils.ts";
import type { QueuedEntry, SendingEntry } from "../session/connection.ts";
import { type ComposerCommand, resolveCommand } from "./commands.ts";
import {
  CompletionMenu,
  type CompletionRow,
  type CompletionSection,
  rowId,
} from "./completion-menu.tsx";
import { detectTrigger, type Edited, rank, replaceTrigger, type Trigger } from "./completion.ts";
import { UNKNOWN_QUEUED_TEXT } from "./queue-adapter.ts";

const Lane = ({
  label,
  hint,
  entries,
}: {
  label: string;
  hint: string;
  entries: readonly { readonly id: string; readonly text: string | null }[];
}) =>
  entries.length === 0 ? null : (
    <section aria-label={label} className="px-1">
      <h3 className="text-xs font-medium text-muted-foreground">
        {label} <span className="font-normal">· {hint}</span>
      </h3>
      <ul className="mt-1 flex flex-col gap-1">
        {entries.map((entry) => (
          <li
            key={entry.id}
            className="truncate rounded-md border border-dashed px-3 py-1.5 text-sm text-muted-foreground"
          >
            {entry.text ?? UNKNOWN_QUEUED_TEXT}
          </li>
        ))}
      </ul>
    </section>
  );

const WIDE_QUERY = "(min-width: 640px)";

const subscribeWide = (listener: () => void) => {
  const query = window.matchMedia(WIDE_QUERY);

  query.addEventListener("change", listener);

  return () => {
    query.removeEventListener("change", listener);
  };
};

/** Whether the screen has room for the long placeholder; on a phone it would wrap. */
const useWide = (): boolean =>
  useSyncExternalStore(subscribeWide, () => window.matchMedia(WIDE_QUERY).matches);

/** What a pick from the menu does: put text in place of the trigger, or run a command at once. */
type Pick =
  | { readonly kind: "insert"; readonly text: string }
  | { readonly kind: "run"; readonly command: ComposerCommand; readonly args: string };

type Entry = CompletionRow & { readonly pick: Pick };

type Completion = {
  readonly label: string;
  readonly sections: readonly CompletionSection[];
  readonly entries: readonly Entry[];
};

/** The menu for `trigger`: the commands whose names match it, or the values of the command whose argument it is. */
const completionFor = (
  trigger: Trigger,
  commands: readonly ComposerCommand[],
): Completion | null => {
  if (trigger.kind === "command") {
    const entries = rank(trigger.query, commands, ({ name }) => name).map((command): Entry => ({
      id: `command:${command.name}`,
      label: `/${command.name}`,
      hint: command.argumentHint,
      description: command.description,
      // A command without an argument runs as it is picked; one with an argument waits for it.
      pick:
        command.argument === "none"
          ? { kind: "run", command, args: "" }
          : { kind: "insert", text: `/${command.name}` },
    }));

    return { label: "Commands", sections: [{ label: "Commands", rows: entries }], entries };
  }

  if (trigger.kind === "argument") {
    const command = commands.find(({ name }) => name === trigger.command);

    if (command?.choices === undefined) return null;

    const entries = rank(trigger.query, command.choices, ({ value }) => value).map(
      (choice): Entry => ({
        id: `choice:${choice.value}`,
        label: choice.value,
        description: choice.description,
        pick: { kind: "run", command, args: choice.value },
      }),
    );

    const label = `/${command.name}`;

    return { label, sections: [{ label, rows: entries }], entries };
  }

  return null;
};

/** A line under the composer: why a command failed, or what one did. */
type Note = { readonly tone: "error" | "info"; readonly text: string };

const roundButton =
  "touch-target inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none";

/**
 * The composer: one bordered box holding the input and a toolbar, with `tools` (the model and thinking pickers) on the
 * left and the send controls on the right. While a Run is in progress a message is a steer by default (it joins the
 * Run at its next boundary, after the tool calls in progress) and Alt+Enter, or the Queue button, makes it a follow-up
 * (it waits for the next Run); with nothing typed, the main button stops the Run instead. Messages waiting in the
 * Session's inbox show above the box, by lane, after the ones still being sent.
 *
 * A `/` at the start of the message opens a menu of the Slash commands the composer runs itself: `commands`, and the
 * ones of any conversation (`/stop`, `/stop-all`, `/copy`). A submitted `/name` the composer does not know is sent as
 * written, for the Session to expand or the model to read.
 */
export const Composer = ({
  steerLane,
  followUpLane,
  sending,
  onStopAll,
  tools,
  commands = [],
  compact = false,
  who = "the session",
}: {
  steerLane: readonly QueuedEntry[];
  followUpLane: readonly QueuedEntry[];
  sending: readonly SendingEntry[];
  /** Stop the run and every subagent below it; offered beside Stop while there is one to stop. */
  onStopAll?: (() => void) | undefined;
  /** The toolbar's left side: the pickers of what the next request runs with. */
  tools?: ReactNode;
  /** Slash commands of the page, besides the conversation's own. */
  commands?: readonly ComposerCommand[];
  /** Inside a card: no page margins, and the input does not take the focus. */
  compact?: boolean;
  /** Whom the message is for, in the input's placeholder. */
  who?: string;
}) => {
  // On a touch screen, focusing the input opens the keyboard over the transcript.
  const autoFocus = !compact && window.matchMedia("(pointer: fine)").matches;
  const wide = useWide();
  const menuId = useId();
  const input = useRef<HTMLTextAreaElement>(null);

  const aui = useAui();
  const running = useAuiState((state) => state.thread.isRunning);
  const canSend = useAuiState((state) => state.composer.canSend);
  const text = useAuiState((state) => state.composer.text);

  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  // The start of a trigger the owner dismissed with Escape: its menu stays closed until the trigger moves.
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);

  const allCommands = useMemo(() => {
    const own: ComposerCommand[] = [
      {
        name: "stop",
        description: "Stop the run",
        argument: "none",
        run: () => {
          if (!aui.thread.getState().isRunning) return "Nothing is running.";

          aui.thread.cancelRun();

          return null;
        },
      },
      {
        name: "copy",
        description: "Copy the last answer",
        argument: "none",
        run: async () => {
          const last = aui
            .thread()
            .getState()
            .messages.findLast((message) => message.role === "assistant");

          const answer = (last?.content ?? [])
            .flatMap((part) => (part.type === "text" ? [part.text] : []))
            .join("\n\n")
            .trim();

          if (answer === "") return "There is no answer to copy yet.";

          try {
            await navigator.clipboard.writeText(answer);
          } catch {
            return "The browser did not allow copying.";
          }

          setNote({ tone: "info", text: "Copied the last answer." });

          return null;
        },
      },
    ];

    if (onStopAll !== undefined) {
      own.push({
        name: "stop-all",
        description: "Stop the run and every subagent below it",
        argument: "none",
        run: () => {
          onStopAll();

          return null;
        },
      });
    }

    return [...commands, ...own].toSorted((a, b) => a.name.localeCompare(b.name));
  }, [aui, commands, onStopAll]);

  const trigger = focused ? detectTrigger(text, caret) : null;

  const completion =
    trigger === null || trigger.start === dismissed ? null : completionFor(trigger, allCommands);

  const open = trigger !== null && completion !== null && completion.entries.length > 0;

  // A new menu, or a changed query, starts from its first row.
  const menuKey = trigger === null ? "" : `${trigger.kind}:${trigger.start}:${trigger.query}`;

  useEffect(() => {
    setHighlighted(0);
  }, [menuKey]);

  // A dismissed trigger that is gone (deleted, or the caret left it) no longer holds its menu closed.
  useEffect(() => {
    if (dismissed !== null && trigger?.start !== dismissed) setDismissed(null);
  }, [dismissed, trigger?.start]);

  const edit = (next: Edited) => {
    aui.composer.setText(next.text);
    setCaret(next.caret);

    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const run = async (command: ComposerCommand, args: string) => {
    setBusy(true);
    setNote(null);

    let failure: string | null;

    try {
      failure = await command.run(args);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    setBusy(false);

    if (failure === null) aui.composer.setText("");
    else setNote({ tone: "error", text: failure });
  };

  const pick = (index: number) => {
    const entry = completion?.entries[index];

    if (entry === undefined || trigger === null) return;

    if (entry.pick.kind === "run") void run(entry.pick.command, entry.pick.args);
    else edit(replaceTrigger(text, trigger, entry.pick.text));
  };

  /**
   * Send what is typed, or run it when it is one of the composer's commands; true when the composer took care of it, so
   * assistant-ui must not send it.
   */
  const handled = (): boolean => {
    const resolution = resolveCommand(allCommands, text);

    if (resolution.kind === "send") return false;

    if (resolution.kind === "refuse") setNote({ tone: "error", text: resolution.message });
    else void run(resolution.command, resolution.args);

    return true;
  };

  const queue = () => {
    if (!canSend || handled()) return;

    aui.composer.send({ steer: false });
  };

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    if (busy || handled()) event.preventDefault();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;

    if (open) {
      const count = completion.entries.length;

      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setHighlighted((highlighted + (event.key === "ArrowDown" ? 1 : count - 1)) % count);

        return;
      }

      if ((event.key === "Enter" && !event.shiftKey && !event.altKey) || event.key === "Tab") {
        event.preventDefault();
        pick(highlighted);

        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(trigger.start);

        return;
      }
    }

    if (event.key === "Enter" && event.altKey) {
      event.preventDefault();
      queue();
    }
  };

  const trackCaret = (element: HTMLTextAreaElement) => {
    setCaret(element.selectionStart);
  };

  const hints = "/ commands";

  const placeholder = running
    ? "Steer the run, or queue a follow-up…"
    : wide
      ? `Message ${who} · ${hints}`
      : `Message ${who}…`;

  return (
    <ComposerPrimitive.Root
      onSubmit={onSubmit}
      className={cn("flex w-full flex-col gap-2", !compact && "mx-auto max-w-3xl px-4 pb-4")}
    >
      <Lane label="Sending…" hint="waiting for the session" entries={sending} />
      <Lane label="Steering" hint="joins the run after its tool calls" entries={steerLane} />
      <Lane label="Next up" hint="starts after this run" entries={followUpLane} />
      <div className="relative">
        {open && (
          <CompletionMenu
            id={menuId}
            label={completion.label}
            sections={completion.sections}
            highlighted={highlighted}
            onHighlight={setHighlighted}
            onPick={pick}
          />
        )}
        <div className="rounded-lg border bg-background transition-colors focus-within:border-ring">
          <ComposerPrimitive.Input
            ref={input}
            rows={1}
            autoFocus={autoFocus}
            cancelOnEscape={false}
            placeholder={placeholder}
            aria-label="Message"
            aria-autocomplete="list"
            aria-controls={open ? menuId : undefined}
            aria-expanded={open}
            aria-activedescendant={open ? rowId(menuId, highlighted) : undefined}
            onKeyDown={onKeyDown}
            onChange={(event) => {
              setNote(null);
              trackCaret(event.target);
            }}
            onSelect={(event) => {
              trackCaret(event.currentTarget);
            }}
            onFocus={(event) => {
              setFocused(true);
              trackCaret(event.currentTarget);
            }}
            onBlur={() => {
              setFocused(false);
            }}
            className="block max-h-48 min-h-12 w-full resize-none bg-transparent px-3.5 pt-3 pb-1.5 outline-none placeholder:text-muted-foreground"
          />
          <div className="flex items-center gap-2 px-1.5 pb-1.5">
            <div className="flex min-w-0 flex-1 items-center gap-0.5">{tools}</div>
            <div className="flex shrink-0 items-center gap-1">
              {running && canSend && (
                <button
                  type="button"
                  disabled={busy}
                  aria-label="Queue"
                  title="Queue: starts after this run (Alt+Enter)"
                  onClick={queue}
                  className="touch-target inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50 [&_svg]:size-4"
                >
                  <ListPlus aria-hidden />
                </button>
              )}
              {running && !canSend && onStopAll !== undefined && (
                <Menu
                  label="More ways to stop"
                  title="More ways to stop"
                  icon={<ChevronUp className="size-4" aria-hidden />}
                  className="touch-target"
                >
                  <MenuItem destructive onSelect={onStopAll}>
                    <Square className="fill-current" aria-hidden />
                    Stop all: the run and every subagent
                  </MenuItem>
                </Menu>
              )}
              {running && !canSend ? (
                <button
                  type="button"
                  aria-label="Stop"
                  title="Stop the run"
                  onClick={() => {
                    aui.thread.cancelRun();
                  }}
                  className={cn(
                    roundButton,
                    "border border-destructive/40 text-destructive hover:bg-destructive/10",
                  )}
                >
                  <Square className="size-3 fill-current" aria-hidden />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!canSend || busy}
                  aria-label={running ? "Steer" : "Send"}
                  title={
                    running ? "Steer: joins the run after its tool calls (Enter)" : "Send (Enter)"
                  }
                  className={cn(
                    roundButton,
                    "bg-primary text-primary-foreground hover:bg-primary/90 [&_svg]:size-4",
                  )}
                >
                  {running ? <CornerUpRight aria-hidden /> : <ArrowUp aria-hidden />}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {note !== null && (
        <p
          role={note.tone === "error" ? "alert" : "status"}
          className={cn(
            "px-1 text-xs",
            note.tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {note.text}
        </p>
      )}
    </ComposerPrimitive.Root>
  );
};
