// docs/architecture/mcp-apps.md → Socket messages. The Session's App calls arrive by conversation (`SessionState.mcpApps`); what
// reads them wants one list, or one call wherever it was made.
// @effect-diagnostics missingPipeableSignature:off -- plain readers of a state field, not combinators.
import type { McpAppEntry } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";

/** The Session's App calls by conversation, as its state keeps them. */
export type McpApps = Readonly<Record<string, ReadonlyArray<McpAppEntry>>>;

/** Every conversation's App calls in one list. */
export const appEntries = (apps: McpApps): ReadonlyArray<McpAppEntry> =>
  Arr.flatten(Record.values(apps));

/** The App call `callId` made, in whichever conversation; undefined when the Session has none. */
export const appEntryOf = (apps: McpApps, callId: string): McpAppEntry | undefined =>
  Arr.findFirst(appEntries(apps), (entry) => entry.callId === callId).pipe(Option.getOrUndefined);

/**
 * The conversation that made call `callId`, as a composer is keyed by it: undefined for the root's (`root`, the active
 * branch), else the subagent's. Undefined too for a call the Session has none of.
 */
export const appConversationOf = (
  apps: McpApps,
  callId: string,
  root: number | null,
): number | undefined => {
  const found = Arr.findFirst(Record.toEntries(apps), ([, entries]) =>
    Arr.some(entries, (entry) => entry.callId === callId),
  );

  if (Option.isNone(found)) return undefined;

  const id = Number(found.value[0]);

  return id === root || Number.isNaN(id) ? undefined : id;
};
