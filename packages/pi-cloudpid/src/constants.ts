/**
 * What `/cloudpid` shares with the endpoint (`docs/architecture/mcp-endpoint.md` → The `/cloudpid` command). The
 * values are copies of `@cloudpid/protocol`'s: that package builds its Schemas on `effect`, which the extension must
 * not load, so the extension imports it for types only, and `constants.test.ts` checks the copies against the original.
 */

/** begin's `format`: pi's own session file. */
export const PI_SESSION_FORMAT = "pi-session-jsonl";

/** The most `data` one append may carry, in UTF-8 bytes. */
export const MAX_SLICE_BYTES = 2 * 1024 * 1024;

/** The largest file begin accepts, in UTF-8 bytes. */
export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;

/** The longest `title` begin accepts. */
export const MAX_TITLE_LENGTH = 200;

/** The custom entry `/cloudpid` leaves in the pi Session after an import. */
export const IMPORT_MARKER = "cloudpid-import";

/** The tools `/cloudpid` calls; an endpoint that lacks one is older than this extension. */
export const REQUIRED_TOOLS = [
  "environments_list",
  "session_import_begin",
  "session_import_append",
  "session_import_finish",
  "session_import_cancel",
] as const;

/** The thinking levels begin takes (`@cloudpid/config`'s `THINKING_LEVELS`). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
