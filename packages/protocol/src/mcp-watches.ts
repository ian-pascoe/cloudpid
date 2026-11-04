// The Resource watches on the Session socket (`docs/architecture/mcp-in-a-session.md` → Resource watches → UI): the
// Session lists what its agent watches, for Session details, and takes the owner's ✕ (`mcp_watch_end`, in `session.ts`).
// The host holds the watches; this is the Session's own list of them, one entry per conversation, server and URI.
import * as Schema from "effect/Schema";
import { ConversationId } from "./conversation-id.ts";

/** The longest URI, and server name, a watch entry carries: past it the Session lists none (a watch the host holds goes on). */
export const MAX_MCP_WATCH_KEY = 2048;

/** The most watches the list carries: the host's own bound, 20 for each conversation and 100 for the Environment. */
export const MAX_MCP_WATCHES = 100;

/** One Resource watch of a conversation: the server and the URI it watches. */
export const McpWatchEntry = Schema.Struct({
  conversationId: ConversationId,
  server: Schema.String,
  uri: Schema.String,
});

export type McpWatchEntry = typeof McpWatchEntry.Type;

/**
 * The Resource watches the Session's agent holds, whole: sent after `hello` on every connect (an empty list too) and to
 * every client whenever a watch starts or ends, oldest first.
 */
export const McpWatchesMessage = Schema.Struct({
  type: Schema.Literal("mcp_watches"),
  watches: Schema.Array(McpWatchEntry),
});
