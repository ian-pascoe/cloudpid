// @effect-diagnostics missingPipeableSignature:off -- components and an event handler, not combinators.

// The pieces the Session's composer and the draft of a new Session share: the bordered box, its toolbar's buttons, the
// Attach button, and what a paste of files does.

import { Paperclip } from "lucide-react";
import { type ClipboardEvent, useRef } from "react";
import { cn } from "../lib/utils.ts";

/** The composer's box: bordered, 10 px, Signal Blue while focused, and washed while files are dragged over it. */
export const composerBox = (dragging: boolean): string =>
  cn(
    "rounded-lg border bg-background transition-colors focus-within:border-ring",
    dragging && "border-ring bg-muted",
  );

/** A ghost 32 px icon button of the composer's toolbar, with a 44 px touch. */
export const toolbarButton =
  "touch-target inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4";

/** The composer's round 32 px main button, with a 44 px touch; its colours are the caller's. */
export const roundButton =
  "touch-target inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none";

/** The main button when it sends: Slate Ink, with a 16 px icon. */
export const sendButton = cn(
  roundButton,
  "bg-primary text-primary-foreground hover:bg-primary/90 [&_svg]:size-4",
);

/** The Attach button: the platform's file picker, for any number of files of any type. */
export const AttachButton = ({
  onAttach,
  disabled = false,
}: {
  onAttach: (files: File[]) => void;
  disabled?: boolean;
}) => {
  const picker = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        tabIndex={-1}
        onChange={(event) => {
          onAttach(Array.from(event.target.files ?? []));
          // The same file picked again is a change too.
          event.target.value = "";
        }}
      />
      <button
        type="button"
        aria-label="Attach files"
        title="Attach files"
        disabled={disabled}
        onClick={() => {
          picker.current?.click();
        }}
        className={toolbarButton}
      >
        <Paperclip aria-hidden />
      </button>
    </>
  );
};

/** Pasted files attach; the clipboard's text, when it has any too, is pasted as well. */
export const attachPasted = (
  event: ClipboardEvent<HTMLTextAreaElement>,
  onAttach: (files: File[]) => void,
): void => {
  const files = Array.from(event.clipboardData.files);

  if (files.length === 0) return;

  if (!event.clipboardData.types.includes("text/plain")) event.preventDefault();

  onAttach(files);
};
