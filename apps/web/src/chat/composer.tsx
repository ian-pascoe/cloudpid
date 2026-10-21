// @effect-diagnostics preferEffectArray:off asyncFunction:off globalTimers:off -- browser code in a React app with no Effect runtime: native arrays, promises, timers, Date and fetch are the platform here.

import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { ArrowUp, ChevronUp, CornerUpRight, ListPlus, Paperclip, Square } from "lucide-react";
import {
  type ClipboardEvent,
  type SubmitEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Menu, MenuItem } from "../components/ui/menu.tsx";
import { cn } from "../lib/utils.ts";
import { type CommandOutcome, sessionCommandsFor, type WhenBusy } from "@cloudpid/protocol";
import type { QueuedEntry, SendingEntry } from "../session/connection.ts";
import { AttachmentTiles } from "./attachment-tiles.tsx";
import { outgoingMessage } from "./attachments.ts";
import { type ComposerCommand, resolveCommand, sessionCommands } from "./commands.ts";
import { CompletionMenu, rowId } from "./completion-menu.tsx";
import { detectTrigger, type Edited, replaceTrigger } from "./completion.ts";
import { completionFor, menuKey } from "./menu.ts";
import { UNKNOWN_QUEUED_TEXT } from "./queue-adapter.ts";
import { useConnection, useSessionId } from "./session-context.tsx";
import { useAttachments } from "./use-attachments.ts";
import { useCatalog } from "./use-catalog.ts";
import { useFileSearch } from "./use-file-search.ts";
import { useFileDrop } from "./use-file-drop.ts";

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

/** How long a download's link to its file is kept: Safari on iOS reads the file after the click returns. */
const DOWNLOAD_LINK_MS = 30_000;

/** Hand the owner `file` as a download, as a link to it would. */
const download = (file: NonNullable<CommandOutcome["file"]>) => {
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }));
  const link = document.createElement("a");

  link.href = url;
  link.download = file.name;
  link.hidden = true;
  // In the document, as Safari clicks only a link that is.
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, DOWNLOAD_LINK_MS);
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
 * A `/` at the start of the message opens a menu of the Slash commands: `commands`, the ones of any conversation
 * (`/stop`, `/stop-all`, `/copy`) and the Session's (`/compact`, `/rollover`, `/todo`, `/export`, run on this
 * conversation), then the Prompt templates and Skills of the conversation's directory; `$` opens one of the Skills, and
 * `@` one of the files and folders of the conversation's directory, picked as `@path` text (a folder keeps the menu open
 * to narrow into it). A submitted `/name` the composer does not know is sent as written, for the Session to expand or
 * the model to read.
 *
 * Files attach with the Attach button, a paste, or a drop anywhere on `dropZone` (the thread), and upload at once
 * (`use-attachments.ts`). A message with Attachments is sent by the composer itself, once every one is uploaded and every
 * picture fitted (Send waits until then): its text names each one's `@path`, and the pictures go inline.
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
  conversationId,
  dropZone,
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
  /** The subagent conversation this composer writes to; the root's when absent. */
  conversationId?: number | undefined;
  /** Where a dropped file attaches to this composer: its thread. */
  dropZone?: RefObject<HTMLElement | null> | undefined;
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
  // The highlighted row's id: it stays on that row when the rows change under it (the `@` menu's, as answers come).
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const connection = useConnection();
  const { catalog, refresh } = useCatalog(connection, conversationId);
  const sessionId = useSessionId();
  const attachments = useAttachments(sessionId);
  const picker = useRef<HTMLInputElement>(null);
  const dragging = useFileDrop(dropZone, attachments.add, sessionId !== null);
  const attached = attachments.items.length > 0;
  // Attachments alone make a message.
  const hasMessage = canSend || attached;
  // Why Send waits, shown under the box while no other note is.
  const waiting = attached ? attachments.waiting : null;
  const noteId = useId();

  const shownNote: Note | null =
    note ?? (waiting === null ? null : { tone: "info", text: waiting });

  // The Session's commands run on this composer's conversation; what they did shows under the box.
  const session = useMemo(
    () =>
      // Known before the catalog arrives, so `/compact` typed first, or after the catalog could not be had, still runs.
      sessionCommands(
        catalog?.commands ?? sessionCommandsFor(conversationId === undefined),
        async (name, args) => {
          let outcome: CommandOutcome;

          try {
            outcome = await connection.command(name, args, conversationId);
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }

          if (outcome.file !== undefined) download(outcome.file);

          if (outcome.notice !== undefined) setNote({ tone: "info", text: outcome.notice });

          return null;
        },
      ),
    [catalog, connection, conversationId],
  );

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

    return [...commands, ...session, ...own].toSorted((a, b) => a.name.localeCompare(b.name));
  }, [aui, commands, session, onStopAll]);

  const trigger = focused ? detectTrigger(text, caret) : null;

  // The `@` menu asks the Session for the files that match while it is open.
  const fileQuery = trigger?.kind === "file" && trigger.start !== dismissed ? trigger.query : null;

  const files = useFileSearch(connection, conversationId, fileQuery);

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

  // A new menu, or a changed query, starts from its first row.
  const menuKeyOf = trigger === null ? "" : `${trigger.kind}:${trigger.start}:${trigger.query}`;

  useEffect(() => {
    setHighlighted(null);
  }, [menuKeyOf]);

  // The catalog is asked for when a menu that lists it first opens, and again once it is stale.
  const listsCatalog = trigger?.kind === "command" || trigger?.kind === "skill";

  useEffect(() => {
    if (listsCatalog) refresh();
  }, [listsCatalog, refresh]);

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
  const sendAttached = (whenBusy: WhenBusy) => {
    const sent = attachments.sent();

    if (sent === undefined) {
      setNote({ tone: "info", text: attachments.waiting ?? "The attachments are not ready." });

      return;
    }

    const typed = text;
    const held = attachments.hold();

    aui.composer.setText("");
    setNote(null);

    connection.submit(outgoingMessage(typed, sent), whenBusy, conversationId, (failure) => {
      if (failure === null) {
        held.release();

        return;
      }

      held.restore();

      // What was typed since goes after it, so nothing is lost.
      const since = aui.composer.getState().text;

      aui.composer.setText(since.trim() === "" ? typed : `${typed}\n\n${since}`);
      setNote({ tone: "error", text: failure });
    });
  };

  const queue = () => {
    if (!hasMessage || handled()) return;

    if (attached) sendAttached("followUp");
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
      sendAttached(running ? "steer" : "followUp");
    }
  };

  /** Pasted files attach; the clipboard's text, when it has any too, is pasted as well. */
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);

    if (files.length === 0 || sessionId === null) return;

    if (!event.clipboardData.types.includes("text/plain")) event.preventDefault();

    attachments.add(files);
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

      if (!busy && !handled()) sendAttached("steer");
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
        <div
          className={cn(
            "rounded-lg border bg-background transition-colors focus-within:border-ring",
            dragging && "border-ring bg-muted",
          )}
        >
          <AttachmentTiles
            items={attachments.items}
            fits={attachments.fits}
            onRemove={attachments.remove}
          />
          <ComposerPrimitive.Input
            ref={input}
            rows={1}
            autoFocus={autoFocus}
            cancelOnEscape={false}
            addAttachmentOnPaste={false}
            onPaste={onPaste}
            placeholder={placeholder}
            aria-label="Message"
            aria-autocomplete="list"
            aria-controls={open && entries.length > 0 ? menuId : undefined}
            aria-expanded={open && entries.length > 0}
            aria-activedescendant={open && entries.length > 0 ? rowId(menuId, active) : undefined}
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
              {sessionId !== null && (
                <>
                  <input
                    ref={picker}
                    type="file"
                    multiple
                    hidden
                    tabIndex={-1}
                    onChange={(event) => {
                      attachments.add(Array.from(event.target.files ?? []));
                      event.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    aria-label="Attach files"
                    title="Attach files"
                    onClick={() => {
                      picker.current?.click();
                    }}
                    className="touch-target inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground [&_svg]:size-4"
                  >
                    <Paperclip aria-hidden />
                  </button>
                </>
              )}
              {running && hasMessage && (
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
