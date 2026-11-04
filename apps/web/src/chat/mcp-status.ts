// The status chip of an `settings_mcp_add`, `settings_mcp_update` or `settings_mcp_enable` card (`docs/architecture/
// mcp-configuration.md` → The agent's changes → Results): the server's state from the call's `details.mcp`, which the call
// sets while it waits for the host (so a call that is stopped keeps the last one) and again when it ends.
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { TranscriptPart } from "@cloudpid/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A server's status as the call recorded it. `status` is a string, so one a later build adds reads as itself. */
export const ShownMcpStatus = Schema.Struct({
  server: Schema.String,
  status: Schema.String,
  tools: Schema.Finite,
  error: Schema.NullOr(Schema.String),
});

export type ShownMcpStatus = typeof ShownMcpStatus.Type;

const decodeDetails = Schema.decodeUnknownOption(Schema.Struct({ mcp: ShownMcpStatus }));

/** The status a result's details record; none for a call that waited for no host. */
export const mcpStatusOf = (
  details: Extract<TranscriptPart, { type: "tool-result" }>["details"],
): ShownMcpStatus | undefined =>
  Option.getOrUndefined(Option.map(decodeDetails(details), (found) => found.mcp));

const decodeArtifact = Schema.decodeUnknownOption(Schema.Struct({ mcp: ShownMcpStatus }));

/** The status a card's artifact holds, if it holds one. */
export const shownMcpStatus = (
  artifact: ToolCallMessagePartProps["artifact"],
): ShownMcpStatus | undefined =>
  Option.getOrUndefined(Option.map(decodeArtifact(artifact), (found) => found.mcp));

const MAX_ERROR = 80;

/** What the chip says: `Connected · 3 tools`, `Needs sign-in`, `Failed: …`, `Connecting`. */
export const mcpStatusLabel = (shown: ShownMcpStatus): string => {
  switch (shown.status) {
    case "connected":
      return `Connected · ${shown.tools} tool${shown.tools === 1 ? "" : "s"}`;
    case "needs_sign_in":
      return "Needs sign-in";
    case "sign_in_rejected":
      return "Sign-in rejected";
    case "connecting":
      return "Connecting";
    case "not_checked":
      return "Not checked";
    case "not_discovered":
      return "Not discovered";
    case "disabled":
      return "Switched off";
    case "failed":
    case "unavailable":
    case "skipped": {
      const error = shown.error ?? "no reason given";

      return `Failed: ${error.length > MAX_ERROR ? `${error.slice(0, MAX_ERROR - 1)}…` : error}`;
    }

    default:
      return shown.status;
  }
};
