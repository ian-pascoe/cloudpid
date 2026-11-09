// @effect-diagnostics missingPipeableSignature:off
// The Notification for the changes an agent made over the MCP endpoint (`docs/architecture/mcp-endpoint.md` → After a
// change, and Notifications, #685 D8): one per call that recorded changes, listing what that caller changed in the last
// 10 minutes. The Registry knows what was recorded, so it decides: the main Worker asks after a call that made changes.
import * as Arr from "effect/Array";
import { type AgentChangeVia, GLOBAL_SCOPE, SETTINGS_SCOPE } from "@cloudpid/protocol";
import { describeMcpChanges, type PushPayload } from "../push/notification.ts";
import { type AgentChanges, callerOf } from "./agent-changes.ts";
import { scopeNameOf } from "./scope-names.ts";
import type { RegistryStore } from "./store.ts";

/** How far back a Notification looks for the caller's changes. */
export const MCP_NOTICE_WINDOW_MS = 10 * 60 * 1000;

/**
 * The push for the changes the caller `via` recorded in the `MCP_NOTICE_WINDOW_MS` before `now`, or null when it recorded
 * none (a call that changed nothing, or whose changes are older, sends nothing). The Settings' changes are their own
 * "Settings" group, linked to Global's list, which shows them.
 */
export const mcpChangeNotice = (
  {
    changes,
    store,
  }: {
    readonly changes: Pick<AgentChanges, "madeBy">;
    readonly store: Pick<RegistryStore, "getEnvironment">;
  },
  via: AgentChangeVia,
  now: number,
): PushPayload | null => {
  const recorded = changes.madeBy(via, now - MCP_NOTICE_WINDOW_MS);

  if (!Arr.isReadonlyArrayNonEmpty(recorded)) return null;

  const scopeName = scopeNameOf(store);

  return describeMcpChanges(
    { via, caller: callerOf(via).key },
    Arr.map(recorded, ({ id, scope, field }) => ({
      id,
      scope: scope === SETTINGS_SCOPE ? GLOBAL_SCOPE : scope,
      scopeName: scopeName(scope),
      field,
    })),
  );
};
