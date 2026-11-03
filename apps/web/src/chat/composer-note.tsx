// @effect-diagnostics missingPipeableSignature:off -- a component, not a combinator.

// The line under a composer (`Note`): what a command did, or why a send was refused. After a refused MCP prompt send it
// also offers Retry, and a link to sign in to the server the refusal names, in a new tab as a Sign-in card's link opens.

import { cn } from "../lib/utils.ts";
import type { Note } from "./composer-state.ts";

/** `note` under the composer `id` describes; `signInHref` is the link to sign in to a server, `onRetry` sends again. */
export const ComposerNote = ({
  id,
  note,
  signInHref,
  onRetry,
}: {
  id: string;
  note: Note;
  signInHref: (server: string) => string;
  onRetry: () => void;
}) => (
  <p
    id={id}
    role={note.tone === "error" ? "alert" : "status"}
    className={cn(
      "px-1 text-xs",
      note.tone === "error" ? "text-destructive" : "text-muted-foreground",
    )}
  >
    {note.text}
    {note.signIn !== undefined && (
      <>
        {" "}
        <a
          href={signInHref(note.signIn)}
          target="_blank"
          rel="noopener"
          className="font-medium underline underline-offset-2"
        >
          Sign in to {note.signIn}
        </a>
      </>
    )}
    {note.retry === true && (
      <>
        {" "}
        <button
          type="button"
          onClick={onRetry}
          className="font-medium underline underline-offset-2"
        >
          Retry
        </button>
      </>
    )}
  </p>
);
