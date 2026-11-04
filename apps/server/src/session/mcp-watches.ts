// The Session's Resource watches as the rest of the Session reaches them (`docs/architecture/mcp-in-a-session.md` →
// Resource watches): the service's shape. The implementation, over the object's storage and the host's `apply`, is
// `./mcp-watches-store.ts`; this file has no import of the sockets, which read the service.
import type { McpWatchRecorder } from "@cloudpid/extensions/mcp";
import type { ConversationId, McpWatchEntry } from "@cloudpid/protocol";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** What the Session holds of the Resource watches its agent started, and ends them at the host. */
export type McpWatchesService = McpWatchRecorder & {
  /** The watches, oldest first: what `mcp_watches` lists. */
  readonly list: Effect.Effect<ReadonlyArray<McpWatchEntry>>;
  /**
   * The owner's ✕: end the watch of `server`'s `uri` in `conversation` at the host, which tells the agent at its next
   * request, and take it off the list. A watch the host could not end stays on the list. Never fails.
   */
  readonly end: (watch: {
    readonly conversation: ConversationId;
    readonly server: string;
    readonly uri: string;
  }) => Effect.Effect<void>;
  /**
   * End every watch of `conversation` silently (the agent is not told): its subagent was deleted, or the active Session
   * branch moved off it. Never fails.
   */
  readonly endConversation: (conversation: ConversationId) => Effect.Effect<void>;
  /** End every watch of the Session silently: it was archived or is being deleted. Never fails. */
  readonly endAll: Effect.Effect<void>;
};

export class McpWatches extends Context.Service<McpWatches, McpWatchesService>()(
  "@cloudpid/server/session/mcp-watches/McpWatches",
) {}
