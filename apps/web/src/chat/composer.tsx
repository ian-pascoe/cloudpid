import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { ArrowUp, Square } from "lucide-react";
import type { KeyboardEvent } from "react";
import { Button } from "../components/ui/button.tsx";
import type { QueuedEntry } from "../session/connection.ts";
import { UNKNOWN_QUEUED_TEXT } from "./queue-adapter.ts";

const Lane = ({
  label,
  hint,
  entries,
}: {
  label: string;
  hint: string;
  entries: readonly QueuedEntry[];
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

/**
 * The composer. While a Run is in progress a message is a steer by default (it joins the Run at its next boundary,
 * after the tool calls in progress) and Alt+Enter, or the Queue button, makes it a follow-up (it waits for the next
 * Run). Messages waiting in the Session's inbox show above the input, by lane.
 */
export const Composer = ({
  steerLane,
  followUpLane,
}: {
  steerLane: readonly QueuedEntry[];
  followUpLane: readonly QueuedEntry[];
}) => {
  const aui = useAui();
  const running = useAuiState((state) => state.thread.isRunning);
  const canSend = useAuiState((state) => state.composer.canSend);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || !event.altKey || !canSend) return;

    event.preventDefault();
    aui.composer().send({ steer: false });
  };

  return (
    <ComposerPrimitive.Root className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pb-4">
      <Lane label="Steering" hint="joins the run after its tool calls" entries={steerLane} />
      <Lane label="Next up" hint="starts after this run" entries={followUpLane} />
      <div className="rounded-lg border bg-background focus-within:border-ring">
        <ComposerPrimitive.Input
          rows={1}
          autoFocus
          placeholder={running ? "Steer the run, or queue a follow-up…" : "Message the session…"}
          aria-label="Message"
          onKeyDown={onKeyDown}
          className="block max-h-48 min-h-11 w-full resize-none bg-transparent px-3 py-2.5 outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <span className="px-1 text-xs text-muted-foreground">
            {running
              ? "Enter steers · Alt+Enter queues"
              : "Enter sends · Shift+Enter for a new line"}
          </span>
          <div className="flex items-center gap-2">
            {running && (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => {
                  aui.thread().cancelRun();
                }}
              >
                <Square />
                Stop
              </Button>
            )}
            {running && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canSend}
                onClick={() => {
                  aui.composer().send({ steer: false });
                }}
              >
                Queue
              </Button>
            )}
            <Button
              type="submit"
              size={running ? "sm" : "icon"}
              disabled={!canSend}
              aria-label={running ? "Steer" : "Send"}
            >
              {running ? "Steer" : <ArrowUp />}
            </Button>
          </div>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};
