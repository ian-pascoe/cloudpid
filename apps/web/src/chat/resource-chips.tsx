// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off missedPipeableOpportunity:off -- components, not combinators.

// The composer's attached MCP resources (`docs/architecture/mcp-in-a-session.md` → Attached resources): a chip per
// resource picked from the `@` menu, above the Attachments' tiles and beside the attached pages, removable before
// sending. Nothing is read until the message is sent, so a chip says only what the menu listed.

import { resourceKey, resourceLabel } from "@cloudpid/protocol";
import { FileText } from "lucide-react";
import type { AttachmentsState, ResourceChipState } from "./attachments-state.ts";
import { ChipIcon, ChipList, ComposerChip } from "./chip-card.tsx";

/** The chips of the MCP resources attached to the message, each with a button that removes it. */
export const ResourceChips = ({
  state,
  onRemove,
}: {
  state: AttachmentsState;
  onRemove: (resource: Pick<ResourceChipState, "server" | "uri">) => void;
}) => (
  <ChipList label="Attached MCP resources" empty={state.resources.length === 0}>
    {state.resources.map((chip) => {
      const label = resourceLabel(chip);

      return (
        <ComposerChip
          key={resourceKey(chip)}
          lead={
            <ChipIcon>
              <FileText className="size-4" aria-hidden />
            </ChipIcon>
          }
          title={label}
          tooltip={chip.uri}
          note={`MCP · ${chip.server}`}
          removeLabel={`Remove resource ${label}`}
          onRemove={() => {
            onRemove(chip);
          }}
        />
      );
    })}
  </ChipList>
);
