// @effect-diagnostics missingPipeableSignature:off -- a component, not a combinator.

// The MCP prompt chip above the composer's input (`docs/architecture/mcp-in-a-session.md` → Arguments and completions):
// "docs · Review PR · pr: 7". Clicking it opens its form again, ✕ takes it off. One the catalog no longer offers (a Branch
// gave it back, or the server dropped it) is muted and says so: it cannot be sent, only removed.

import { Sparkles, X } from "lucide-react";
import { cn } from "../lib/utils.ts";
import { type PromptChip, chipText } from "./mcp-prompt-state.ts";

/** The chip of the prompt the message is about to get. `gone` says why it cannot be sent, when it cannot. */
export const PromptChipView = ({
  chip,
  gone,
  onEdit,
  onRemove,
}: {
  chip: PromptChip;
  gone?: string | undefined;
  onEdit: () => void;
  onRemove: () => void;
}) => (
  <div className="flex flex-wrap items-center gap-1.5 px-2.5 pt-2.5">
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-md border bg-muted text-xs",
        gone !== undefined && "border-dashed text-muted-foreground",
      )}
    >
      <button
        type="button"
        onClick={onEdit}
        title={gone ?? "Edit the arguments"}
        aria-label={`MCP prompt ${chipText(chip)}. ${gone ?? "Edit the arguments"}`}
        className="flex min-w-0 items-center gap-1.5 rounded-l-md px-2 py-1 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Sparkles className="size-3 shrink-0" aria-hidden />
        <span className="truncate">{chipText(chip)}</span>
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove the MCP prompt"
        title="Remove the MCP prompt"
        className="touch-target rounded-r-md px-1.5 py-1 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
    {gone !== undefined && <span className="text-xs text-muted-foreground">{gone}</span>}
  </div>
);
