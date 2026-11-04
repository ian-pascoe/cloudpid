// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off missedPipeableOpportunity:off -- components, not combinators.

// The composer's App messages (`docs/architecture/mcp-apps.md` → App messages and App context): a chip above the input for
// what an App View asked to say (`ui/message`), never written into the textarea. Edit moves its text into the input, where it
// is the owner's own; Discard drops it; Send (the composer's) sends the owner's text and then the App's as a part of its own,
// which the transcript marks "sent from the <server> app". One chip for each View, at most `MAX_APP_MESSAGES`.
import { flatCut, fromApp } from "@cloudpid/protocol";
import { MessageSquare } from "lucide-react";
import type { AppMessageChipState, AttachmentsState } from "./attachments-state.ts";
import { ChipIcon, ChipList } from "./chip-card.tsx";

/** The longest a chip shows of its message, in characters; the whole of it is its tooltip. */
export const SHOWN_CHARS = 200;

/**
 * The input's text once the owner chose Edit on a chip: the chip's text after what is typed, set apart by a blank line, so that
 * it is the owner's own from then on and nothing they typed is lost.
 */
export const withEditedMessage = (typed: string, chipText: string): string =>
  typed.trim() === "" ? chipText : `${typed}\n\n${chipText}`;

/** What a chip says of where the message came from. */
export const chipSource = (chip: AppMessageChipState): string => `From ${fromApp(chip.server)}`;

/** The chips of the App messages the composer holds, each with Edit and Discard. */
export const AppMessageChips = ({
  state,
  onEdit,
  onDiscard,
}: {
  state: AttachmentsState;
  onEdit: (chip: AppMessageChipState) => void;
  onDiscard: (chip: AppMessageChipState) => void;
}) => (
  <ChipList label="App messages" empty={state.apps.length === 0}>
    {state.apps.map((chip) => (
      <li
        key={chip.callId}
        className="flex max-w-full min-w-0 items-center gap-2 rounded-md border bg-background py-1.5 pr-1.5 pl-2"
        data-app-message={chip.callId}
      >
        <ChipIcon>
          <MessageSquare className="size-4" aria-hidden />
        </ChipIcon>
        <div className="min-w-0 flex-1">
          <p className="max-w-80 truncate text-sm" title={chip.text}>
            {flatCut(chip.text, SHOWN_CHARS)}
          </p>
          <p className="max-w-80 truncate text-xs text-muted-foreground">{chipSource(chip)}</p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-sm px-1.5 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
          aria-label={`Edit the message from ${fromApp(chip.server)}`}
          onClick={() => {
            onEdit(chip);
          }}
        >
          Edit
        </button>
        <button
          type="button"
          className="shrink-0 rounded-sm px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          aria-label={`Discard the message from ${fromApp(chip.server)}`}
          onClick={() => {
            onDiscard(chip);
          }}
        >
          Discard
        </button>
      </li>
    ))}
  </ChipList>
);
