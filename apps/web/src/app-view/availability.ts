// docs/architecture/mcp-apps.md → Lifecycle (Server states). Whether an App call's View mounts, and what the card says of its
// server, from what the page knows: the inventory's App tools, the conversation's App calls, and the server's state.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- a plain decision over small values.
import type { McpAppEntry, McpAppTool, McpServerState } from "@cloudpid/protocol";
import { isKeptApp } from "@cloudpid/protocol";

/** What a card with an App call shows of its View. */
export type AppAvailability =
  /** An ordinary tool call: nothing of an App. */
  | { readonly kind: "none" }
  /** Its server is switched off, removed or shadowed (its tool is no longer an App tool): "App unavailable", no mount. */
  | { readonly kind: "unavailable" }
  /** Its record was evicted: the call's summary only, "App data no longer kept". */
  | { readonly kind: "evicted" }
  /** It mounts, with the server's state as a badge: `offline` or `sign-in`, or none. */
  | { readonly kind: "mount"; readonly badge: "offline" | "sign-in" | null };

export interface AppFacts {
  /** The call's tool as the model names it (`mcp__<server>__<tool>`). */
  readonly toolName: string;
  /** The inventory's App tools; null until the socket has told them. */
  readonly tools: ReadonlyArray<McpAppTool> | null;
  /** The call's entry among the conversation's App calls, if there is one. */
  readonly entry: McpAppEntry | undefined;
  /** The server's state as its host reports it; undefined until the list is read. */
  readonly serverState: McpServerState | undefined;
}

/** Whether a server's state is one that cannot be reached for now. */
const isOffline = (state: McpServerState): boolean =>
  state === "unavailable" || state === "failed" || state === "unknown";

export const appAvailability = (facts: AppFacts): AppAvailability => {
  const declared = facts.tools?.some((tool) => tool.name === facts.toolName) === true;

  // Not an App call: the tool is no App tool (once the tools are known) and no record says it was one.
  if (!declared && facts.entry === undefined) return { kind: "none" };

  // An App call whose tool the inventory no longer lists as an App's: the server is off, gone or shadowed.
  if (facts.tools !== null && !declared) return { kind: "unavailable" };

  if (facts.serverState === "disabled") return { kind: "unavailable" };

  if (facts.entry !== undefined && !isKeptApp(facts.entry)) return { kind: "evicted" };

  const state = facts.serverState;

  if (state === undefined) return { kind: "mount", badge: null };

  if (isOffline(state)) return { kind: "mount", badge: "offline" };

  return { kind: "mount", badge: state === "sign_in" || state === "rejected" ? "sign-in" : null };
};
