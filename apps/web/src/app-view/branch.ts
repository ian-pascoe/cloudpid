// docs/architecture/mcp-apps.md → App Views in the transcript (Remounting, Teardown). Which App calls of a thread a move of the
// active Session branch drops: those of the messages the branch it moves to does not hold. The Views of those are unmounted
// by the move and told to tear down first (`afterBranchTeardown`); the Views the branch keeps are not remounted at all.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- a plain decision over small native lists.
import type { McpAppEntry, TranscriptMessage } from "@cloudpid/protocol";
import { entryIdOf } from "../session/tree.ts";

/**
 * The IDs of the calls of `messages` (the thread's loaded transcript) that are not in a message of `kept`, the entries of the
 * branch moved to: each assistant message's tool calls, and the nested calls of those that were `codemode` scripts (`apps`).
 * A message with no entry ID (the one streaming) is not dropped by anything.
 */
export const callsDroppedBy = (
  messages: ReadonlyArray<Pick<TranscriptMessage, "id" | "role" | "parts">>,
  apps: ReadonlyArray<McpAppEntry>,
  kept: ReadonlySet<number>,
): ReadonlySet<string> => {
  const dropped = new Set<string>();

  for (const message of messages) {
    const entry = entryIdOf(message.id);

    if (message.role !== "assistant" || entry === undefined || kept.has(entry)) continue;

    for (const part of message.parts) if (part.type === "tool-call") dropped.add(part.id);
  }

  for (const entry of apps) {
    if (entry.parentCall !== undefined && dropped.has(entry.parentCall)) dropped.add(entry.callId);
  }

  return dropped;
};
