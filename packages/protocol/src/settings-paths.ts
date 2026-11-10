// @effect-diagnostics missingPipeableSignature:off -- plain path builders.
// Where the Settings page and its sections live in the web app, shared by the web (its links and router) and the server
// (a Notification's URL opens one: `docs/architecture/mcp-endpoint.md` → After a change, and Notifications).
import { GLOBAL_SCOPE } from "./registry.ts";

/** The Settings page, at Global's list of sections (a wide screen opens its first section). */
export const SETTINGS_PATH = "/settings";

/** Global's Scope in a Settings page path, in place of the `*` the Registry names it by. */
export const GLOBAL_SEGMENT = "all";

/** The path segment of Scope `scope` (`*` for Global, or an Environment's id). */
const scopeSegment = (scope: string): string =>
  scope === GLOBAL_SCOPE ? GLOBAL_SEGMENT : encodeURIComponent(scope);

/**
 * The Settings page at Scope `scope` (`*` for Global, or an Environment's id): section `section` (its slug), or the
 * Scope's list of sections when none is named.
 */
export const settingsPath = (scope: string, section?: string): string =>
  `${SETTINGS_PATH}/${scopeSegment(scope)}${section === undefined ? "" : `/${section}`}`;

/**
 * Where an Approval asked over the MCP endpoint is shown (#685 L3): its Scope's Settings page at `section`, which
 * scrolls to its card (`/settings/<all|id>/<section>?request=<id>`).
 */
export const approvalPath = (scope: string, section: string, id: string): string =>
  `${settingsPath(scope, section)}?request=${encodeURIComponent(id)}`;

/**
 * The Agent changes section of Scope `scope`, scrolled to change `id` (`#agent-change-<id>`, the row's element id) when
 * one is named.
 */
export const agentChangesPath = (scope: string, id?: number): string =>
  `${settingsPath(scope, "agent-changes")}${id === undefined ? "" : `#agent-change-${id}`}`;
