// @effect-diagnostics missingPipeableSignature:off -- a component and its words, not combinators.

// The webhook delivery a Trigger's Fire carried, as the transcript shows it (docs/architecture/triggers.md → Payload and
// untrusted content): a chip with where it came from and how big it was, in place of the block of untrusted content the
// model got, which the Session wrote after the message. The body is the sender's, so it is never shown here; the file
// that holds the whole of it is named, for the owner to open.

import { payloadChipLabel, type TriggerPayloadChip } from "@cloudpid/protocol";
import { Webhook } from "lucide-react";
import { SentChip } from "./chip-card.tsx";

/** What a chip says of how much of the body the model got and where the whole of it is. */
export const payloadNote = (chip: TriggerPayloadChip): string => {
  const kept =
    chip.path === undefined
      ? "body not kept: too large"
      : chip.shown < chip.size
        ? `first ${String(chip.shown)} bytes shown, all of it in a file`
        : "all of it shown, and in a file";

  return `${String(chip.size)} bytes · ${kept}`;
};

export const PayloadChip = ({ chip }: { chip: TriggerPayloadChip }) => (
  <ul aria-label="Webhook payload" className="mt-1.5 flex flex-col gap-1.5">
    <SentChip
      icon={<Webhook className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
      title={payloadChipLabel(chip)}
      tooltip={`Delivery ${chip.delivery}`}
      note={payloadNote(chip)}
    >
      {chip.path !== undefined && (
        <p className="mt-1 font-mono text-xs break-all text-muted-foreground">{chip.path}</p>
      )}
    </SentChip>
  </ul>
);
