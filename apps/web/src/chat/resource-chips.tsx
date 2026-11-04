// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off missedPipeableOpportunity:off -- components, not combinators.

// The composer's attached MCP resources (`docs/architecture/mcp-in-a-session.md` → Attached resources): a chip per
// resource picked from the `@` menu, above the Attachments' tiles and beside the attached pages, removable before
// sending. Nothing is read until the message is sent, so a chip says only what the menu listed.

import { resourceLabel } from "@cloudpid/protocol";
import { FileText, X } from "lucide-react";
import type { AttachmentsState, ResourceChipState } from "./attachments-state.ts";

/** The chips of the MCP resources attached to the message, each with a button that removes it. */
export const ResourceChips = ({
  state,
  onRemove,
}: {
  state: AttachmentsState;
  onRemove: (resource: Pick<ResourceChipState, "server" | "uri">) => void;
}) =>
  state.resources.length === 0 ? null : (
    <ul
      aria-label="Attached MCP resources"
      aria-live="polite"
      aria-relevant="additions"
      className="flex flex-wrap gap-2 px-2.5 pt-2.5"
    >
      {state.resources.map((chip) => {
        const label = resourceLabel(chip);

        return (
          <li
            key={`${chip.server}\u0000${chip.uri}`}
            className="relative flex h-12 max-w-full min-w-0 items-center gap-2 rounded-md border bg-background pr-8 pl-2"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <FileText className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="max-w-64 truncate text-sm" title={chip.uri}>
                {label}
              </p>
              <p className="max-w-64 truncate text-xs text-muted-foreground">MCP · {chip.server}</p>
            </div>
            <button
              type="button"
              aria-label={`Remove resource ${label}`}
              title={`Remove resource ${label}`}
              onClick={() => {
                onRemove(chip);
              }}
              className="group absolute -top-1.5 -right-1.5 z-10 inline-flex size-11 items-center justify-center text-muted-foreground outline-none pointer-fine:pointer-events-none"
            >
              <span className="pointer-events-auto inline-flex size-5 items-center justify-center rounded-full border bg-background transition-colors group-hover:bg-accent group-hover:text-accent-foreground group-focus-visible:ring-2 group-focus-visible:ring-ring">
                <X className="size-3" aria-hidden />
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
