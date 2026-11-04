// docs/architecture/mcp-apps.md → App Views in the transcript (Which App Views are live). Which App calls of a conversation
// are in the newest generation of their server's, and whether a View is live given that, what the owner chose of it on this
// device, and whether the Session is archived. Pure: the transcript's messages and the conversation's App calls go in.
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain decisions over small native lists.
import type { McpAppEntry, TranscriptMessage } from "@cloudpid/protocol";
import type { AppChoice } from "../session-layout.ts";

/** No call is live by the generation rule: what a conversation with no App call gives. */
export const NO_LIVE_CALLS: ReadonlySet<string> = new Set();

/**
 * The App calls of the newest generation of each server's in a conversation: those of the latest assistant message that
 * made any of that server's, and, within a `codemode` script (a nested call has its script's call as `parentCall`), only
 * the last call per server. Older generations are not in the set; they collapse, and Reopen brings one back.
 *
 * A message is the model's own, one answer of a turn: a turn that calls an App tool, reads its result and calls it again
 * has two generations. A call counts whether its record was kept or evicted (an evicted one is a newer generation all
 * the same), and one whose call is not in `messages` (an earlier part of the History that is not loaded) counts for nothing.
 * `apps` are the conversation's entries, oldest first.
 */
export const liveGeneration = (
  messages: ReadonlyArray<Pick<TranscriptMessage, "role" | "parts">>,
  apps: ReadonlyArray<McpAppEntry>,
): ReadonlySet<string> => {
  if (apps.length === 0) return NO_LIVE_CALLS;

  // The assistant message each tool call was made in, in order of the messages.
  const messageOf = new Map<string, number>();
  let index = 0;

  for (const message of messages) {
    if (message.role !== "assistant") continue;

    for (const part of message.parts) if (part.type === "tool-call") messageOf.set(part.id, index);

    index += 1;
  }

  const placed = apps.flatMap((entry, order) => {
    const message = messageOf.get(entry.parentCall ?? entry.callId);

    return message === undefined ? [] : [{ entry, order, message }];
  });

  const newest = new Map<string, number>();

  for (const { entry, message } of placed) {
    newest.set(entry.server, Math.max(newest.get(entry.server) ?? -1, message));
  }

  const live = new Set<string>();
  // A script's last call of a server: the latest by the time it completed, then by its place in the list.
  const lastInScript = new Map<string, { callId: string; at: number; order: number }>();

  for (const { entry, order, message } of placed) {
    if (message !== newest.get(entry.server)) continue;

    if (entry.parentCall === undefined) {
      live.add(entry.callId);
      continue;
    }

    const key = `${entry.parentCall}\0${entry.server}`;
    const last = lastInScript.get(key);

    if (last === undefined || entry.at > last.at || (entry.at === last.at && order > last.order)) {
      lastInScript.set(key, { callId: entry.callId, at: entry.at, order });
    }
  }

  for (const { callId } of lastInScript.values()) live.add(callId);

  return live;
};

/** The most App Views a `codemode` script's strip lists: the last ones it made. */
export const MAX_STRIP = 20;

/** The App calls a `codemode` script made (`parentCall` is its call), oldest first, at most the last {@link MAX_STRIP}. */
export const callsOfScript = (
  apps: ReadonlyArray<McpAppEntry>,
  scriptCallId: string,
): ReadonlyArray<McpAppEntry> =>
  apps.filter((entry) => entry.parentCall === scriptCallId).slice(-MAX_STRIP);

/** What decides whether an App View is live. */
export interface LiveFacts {
  /** The call is in the newest generation of its server's (`liveGeneration`). */
  readonly newest: boolean;
  /** What the owner chose of it on this device. */
  readonly choice: AppChoice | undefined;
  /** The Session is archived: App Views are collapsed, and a Reopen mounts one read-only. */
  readonly archived: boolean;
  /** The View has the keyboard focus (the owner is using it). */
  readonly focused: boolean;
}

/**
 * Whether the View is live in its card: the owner's Reopen or Collapse wins; else the newest generation of an active
 * Session; a View the owner is using is never collapsed by a newer generation.
 */
export const isAppLive = ({ newest, choice, archived, focused }: LiveFacts): boolean => {
  if (choice !== undefined) return choice === "open";

  return !archived && (newest || focused);
};
