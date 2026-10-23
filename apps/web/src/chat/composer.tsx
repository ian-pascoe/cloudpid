// @effect-diagnostics preferEffectArray:off asyncFunction:off -- assistant-ui's messages and the lanes are native arrays,
// and a command's run, awaited in an event handler, is a promise.

import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { useAtom, useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react";
import * as ScopedAtom from "@effect/atom-react/ScopedAtom";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Atom from "effect/reactivity/Atom";
import { ArrowUp, ChevronUp, CornerUpRight, ListPlus, Square } from "lucide-react";
import {
  type SubmitEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useId,
  useRef,
} from "react";
import { Menu, MenuItem } from "../components/ui/menu.tsx";
import { cn } from "../lib/utils.ts";
import { sessionCommandsFor, type WhenBusy } from "@cloudpid/protocol";
import { messageOf } from "../registry.ts";
import type { QueuedEntry, SendingEntry } from "../session/state.ts";
import { useCall } from "../calls.ts";
import { AttachmentTiles } from "./attachment-tiles.tsx";
import {
  addAttachmentsAtom,
  attachmentsAtom,
  removeAttachmentAtom,
  sendAttachedAtom,
  sentAttachments,
  waitingFor,
} from "./attachments-state.ts";
import { catalogAtom } from "./catalog.ts";
import { type ComposerCommand, resolveCommand, sessionCommands } from "./commands.ts";
import { CompletionMenu, rowId } from "./completion-menu.tsx";
import {
  AttachButton,
  attachPasted,
  composerBox,
  roundButton,
  sendButton,
  toolbarButton,
} from "./composer-parts.tsx";
import { type Edited, replaceTrigger } from "./completion.ts";
import {
  type ComposerSource,
  composerState,
  copyAtom,
  type Note,
  sessionCommandAtom,
  wideAtom,
} from "./composer-state.ts";
import { type ConversationKey, conversationKey, useShownSessionId } from "./conversation.ts";
import { fileDragAtom, useFileDropZone } from "./file-drop.ts";
import { fileResults, fileSearchAtom } from "./file-search.ts";
import { completionFor, menuKey } from "./menu.ts";
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

/** One composer's state (`composerState`), kept while it is shown. */
const ComposerScope = ScopedAtom.make((source: ComposerSource) => Atom.make(composerState(source)));

type ComposerProps = {
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
  /** The subagent conversation this composer writes to; the root's when absent. */
  conversationId?: number | undefined;
  /** Where a dropped file attaches to this composer: its thread. */
  dropZone?: RefObject<HTMLElement | null> | undefined;
};

const ComposerBox = ({
  steerLane,
  followUpLane,
  sending,
  onStopAll,
  tools,
  commands = [],
  compact = false,
  who = "the session",
  conversationId,
  dropZone,
  conversation: key,
  input,
}: ComposerProps & {
  /** This composer's conversation, which its catalog, `@` menu and Attachments belong to. */
  conversation: ConversationKey;
  input: RefObject<HTMLTextAreaElement | null>;
}) => {
  // On a touch screen, focusing the input opens the keyboard over the transcript.
  const autoFocus = !compact && window.matchMedia("(pointer: fine)").matches;
  const wide = useAtomValue(wideAtom);
  const menuId = useId();

  const aui = useAui();
  const running = useAuiState((state) => state.thread.isRunning);
  const canSend = useAuiState((state) => state.composer.canSend);

  const state = useAtomValue(ComposerScope.use());
  const text = useAtomValue(state.text);
  const trigger = useAtomValue(state.trigger);
  const setCaret = useAtomSet(state.caret);
  const setFocused = useAtomSet(state.focused);
  const [dismissed, setDismissed] = useAtom(state.dismissed);
  const [highlighted, setHighlighted] = useAtom(state.highlighted);
  const [note, setNote] = useAtom(state.note);
  const [busy, setBusy] = useAtom(state.busy);
  const fileQuery = useAtomValue(state.fileQuery);

  useAtomMount(state.effects);

  const catalog = useAtomValue(catalogAtom(key));
  const runSessionCommand = useCall(sessionCommandAtom(key));
  const copy = useCall(copyAtom);
  const attachments = useAtomValue(attachmentsAtom(key));
  const addAttachments = useAtomSet(addAttachmentsAtom(key));
  const removeAttachment = useAtomSet(removeAttachmentAtom(key));
  const sendAttached = useCall(sendAttachedAtom(key));

  useFileDropZone(dropZone, key);

  const dragging = useAtomValue(fileDragAtom(key));
  const attached = attachments.items.length > 0;
  // Attachments alone make a message.
  const hasMessage = canSend || attached;
  // Why Send waits, shown under the box while no other note is.
  const waiting = attached ? waitingFor(attachments) : null;
  const noteId = useId();

  const shownNote: Note | null =
    note ?? (waiting === null ? null : { tone: "info", text: waiting });

  // The Session's commands run on this composer's conversation; what they did shows under the box. They are known
  // before the catalog arrives, so `/compact` typed first, or after the catalog could not be had, still runs.
  const session = sessionCommands(
    catalog?.commands ?? sessionCommandsFor(conversationId === undefined),
    (name, args) =>
      runSessionCommand({ name, args }).then((exit) => {
        if (Exit.isFailure(exit)) return messageOf(exit.cause);

        if (exit.value !== null) setNote({ tone: "info", text: exit.value });

        return null;
      }),
  );

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
      run: () => {
        const last = aui
          .thread()
          .getState()
          .messages.findLast((message) => message.role === "assistant");

        const answer = (last?.content ?? [])
          .flatMap((part) => (part.type === "text" ? [part.text] : []))
          .join("\n\n")
          .trim();

        if (answer === "") return "There is no answer to copy yet.";

        return copy(answer).then((exit) => {
          if (Exit.isFailure(exit)) return "The browser did not allow copying.";

          setNote({ tone: "info", text: "Copied the last answer." });

          return null;
        });
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

  const allCommands = [...commands, ...session, ...own].toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );

  const fileSearch = useAtomValue(fileSearchAtom(key));
  const files = fileResults(fileSearch, fileQuery);

  const completion =
    trigger === null || trigger.start === dismissed
      ? null
      : completionFor(trigger, allCommands, catalog ?? undefined, files);

  const open =
    trigger !== null &&
    completion !== null &&
    (completion.entries.length > 0 || completion.notice !== undefined);

  const entries = completion?.entries ?? [];

  // The highlighted row's index; the first row when it is gone.
  const active = Math.max(
    0,
    entries.findIndex((entry) => entry.id === highlighted),
  );

  const highlight = (index: number) => {
    setHighlighted(entries[index]?.id ?? null);
  };

  const edit = (next: Edited) => {
    Atom.batch(() => {
      aui.composer.setText(next.text);
      setCaret(next.caret);
    });

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
    else {
      edit(
        replaceTrigger(text, trigger, entry.pick.text, { space: entry.pick.continues !== true }),
      );
    }
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

  /**
   * Send what is typed with the Attachments, once they are all uploaded and fitted; else say what it waits for. Should
   * the Session refuse the message, its text and Attachments come back to the composer, with why under it.
   */
  const sendWithAttachments = (whenBusy: WhenBusy) => {
    if (sentAttachments(attachments) === undefined) {
      setNote({
        tone: "info",
        text: waitingFor(attachments) ?? "The attachments are not ready.",
      });

      return;
    }

    const typed = text;

    // The Attachments leave the composer with the text, as the send takes them.
    void sendAttached({ typed, whenBusy }).then((exit) => {
      if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;

      // What was typed since goes after it, so nothing is lost.
      const since = aui.composer.getState().text;

      aui.composer.setText(since.trim() === "" ? typed : `${typed}\n\n${since}`);
      setNote({ tone: "error", text: messageOf(exit.cause) });
    });
    aui.composer.setText("");
    setNote(null);
  };

  const queue = () => {
    if (!hasMessage || handled()) return;

    if (attached) sendWithAttachments("followUp");
    else aui.composer.send({ steer: false });
  };

  const onSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    if (busy || handled()) {
      event.preventDefault();

      return;
    }

    // assistant-ui sends text only: a message with Attachments is the composer's to send.
    if (attached) {
      event.preventDefault();
      sendWithAttachments(running ? "steer" : "followUp");
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;

    if (open) {
      const count = entries.length;
      const action = menuKey(event, count);

      if (action !== null) event.preventDefault();

      if (action === "close") setDismissed(trigger.start);
      else if (action === "next" || action === "previous") {
        highlight((active + (action === "next" ? 1 : count - 1)) % count);
      } else if (action === "pick") pick(active);

      if (action !== null) return;
    }

    if (event.key === "Enter" && event.altKey) {
      event.preventDefault();
      queue();

      return;
    }

    // assistant-ui's own steer shortcut would send the text without the Attachments.
    if (attached && event.key === "Enter" && event.shiftKey && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();

      if (!busy && !handled()) sendWithAttachments("steer");
    }
  };

  const trackCaret = (element: HTMLTextAreaElement) => {
    setCaret(element.selectionStart);
  };

  const hints = "/ commands · $ skills · @ files";

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
            notice={completion.notice}
            highlighted={active}
            onHighlight={highlight}
            onPick={pick}
          />
        )}
        <div className={composerBox(dragging)}>
          <AttachmentTiles
            items={attachments.items}
            fits={attachments.fits}
            onRemove={removeAttachment}
          />
          <ComposerPrimitive.Input
            ref={input}
            rows={1}
            autoFocus={autoFocus}
            cancelOnEscape={false}
            // On a phone or tablet without a mouse, Return starts a new line and the Send button sends, as in a native
            // messaging app; with a mouse or trackpad, Enter still sends.
            unstable_insertNewlineOnTouchEnter
            addAttachmentOnPaste={false}
            onPaste={(event) => {
              attachPasted(event, addAttachments);
            }}
            placeholder={placeholder}
            aria-label="Message"
            aria-autocomplete="list"
            aria-controls={open && entries.length > 0 ? menuId : undefined}
            aria-expanded={open && entries.length > 0}
            aria-activedescendant={open && entries.length > 0 ? rowId(menuId, active) : undefined}
            onKeyDown={onKeyDown}
            // No onChange: it runs before assistant-ui stores the new text, and an update there would render the input with
            // the text before the edit, which puts the caret at its end. The composer's state hears the edit once the
            // text is stored (`composerState`).
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
              <AttachButton onAttach={addAttachments} />
              {running && hasMessage && (
                <button
                  type="button"
                  disabled={busy}
                  aria-label="Queue"
                  title="Queue: starts after this run (Alt+Enter)"
                  onClick={queue}
                  className={toolbarButton}
                >
                  <ListPlus aria-hidden />
                </button>
              )}
              {running && !hasMessage && onStopAll !== undefined && (
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
              {running && !hasMessage ? (
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
                  disabled={!hasMessage || busy || waiting !== null}
                  aria-label={running ? "Steer" : "Send"}
                  aria-describedby={waiting === null ? undefined : noteId}
                  title={
                    waiting !== null
                      ? waiting
                      : running
                        ? "Steer: joins the run after its tool calls (Enter)"
                        : "Send (Enter)"
                  }
                  className={sendButton}
                >
                  {running ? <CornerUpRight aria-hidden /> : <ArrowUp aria-hidden />}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
      {shownNote !== null && (
        <p
          id={noteId}
          role={shownNote.tone === "error" ? "alert" : "status"}
          className={cn(
            "px-1 text-xs",
            shownNote.tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {shownNote.text}
        </p>
      )}
    </ComposerPrimitive.Root>
  );
};

/**
 * The composer: one bordered box holding the input and a toolbar, with `tools` (the model and thinking pickers) on the
 * left and the send controls on the right. While a Run is in progress a message is a steer by default (it joins the
 * Run at its next boundary, after the tool calls in progress) and Alt+Enter, or the Queue button, makes it a follow-up
 * (it waits for the next Run); with nothing typed, the main button stops the Run instead. Enter sends, except on a touch
 * screen without a mouse, where it starts a new line and only the buttons send. Messages waiting in the
 * Session's inbox show above the box, by lane, after the ones still being sent.
 *
 * A `/` at the start of the message opens a menu of the Slash commands: `commands`, the ones of any conversation
 * (`/stop`, `/stop-all`, `/copy`) and the Session's (`/compact`, `/rollover`, `/todo`, `/export`, run on this
 * conversation), then the Prompt templates and Skills of the conversation's directory; `$` opens one of the Skills, and
 * `@` one of the files and folders of the conversation's directory, picked as `@path` text (a folder keeps the menu open
 * to narrow into it). A submitted `/name` the composer does not know is sent as written, for the Session to expand or
 * the model to read.
 *
 * Files attach with the Attach button, a paste, or a drop anywhere on `dropZone` (the thread), and upload at once
 * (`attachments-state.ts`). A message with Attachments is sent by the composer itself, once every one is uploaded and
 * every picture fitted (Send waits until then): its text names each one's `@path`, and the pictures go inline.
 */
export const Composer = (props: ComposerProps) => {
  const aui = useAui();
  const input = useRef<HTMLTextAreaElement>(null);
  const key = conversationKey(useShownSessionId(), props.conversationId);

  return (
    // Another conversation's composer starts over.
    <ComposerScope.Provider
      key={`${key.sessionId}/${key.conversationId}`}
      value={{
        key,
        text: () => aui.composer.getState().text,
        subscribe: (listener) => aui.subscribe(listener),
        input: () => input.current,
        setText: (text) => {
          aui.composer.setText(text);
        },
      }}
    >
      <ComposerBox {...props} conversation={key} input={input} />
    </ComposerScope.Provider>
  );
};
