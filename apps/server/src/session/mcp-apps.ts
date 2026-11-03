// The Session's MCP App records as the rest of the Session reaches them (`docs/architecture/mcp-apps.md` → App records,
// Socket messages): the service's shape. The implementation, over the object's storage, is `./mcp-apps-store.ts`; this
// file has no import of the sockets, which read the service.
import type { McpAppRecorder } from "@cloudpid/extensions/mcp";
import type {
  ConversationId,
  McpAppCopy,
  McpAppEntry,
  McpAppHtmlAnswer,
  McpAppMounted,
  McpAppTool,
} from "@cloudpid/protocol";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

/** What the Session holds of its App records, and of its inventory's App tools. */
export type McpAppsService = McpAppRecorder & {
  /** The App calls of `conversation`, oldest first: what `mcp_apps` lists. */
  readonly list: (conversation: ConversationId) => Effect.Effect<ReadonlyArray<McpAppEntry>>;
  /** `conversation`'s App calls now, and again each time they change. */
  readonly updates: (conversation: ConversationId) => Stream.Stream<ReadonlyArray<McpAppEntry>>;
  /** The inventory's App tools, as the extension last told them. */
  readonly tools: Effect.Effect<ReadonlyArray<McpAppTool>>;
  /** Mount `callId`'s record: its record, its stub, or none; a record read is the most recently mounted. */
  readonly mount: (callId: string) => Effect.Effect<McpAppMounted>;
  /** The page of `hash`, which some record pins, through the host; the record's server is the one asked. */
  readonly html: (hash: string) => Effect.Effect<McpAppHtmlAnswer>;
  /**
   * The records and stubs of the calls whose result entry is among `callIds`, and of the calls nested in them, for a
   * Fork or Clone to carry.
   */
  readonly copiesFor: (callIds: ReadonlyArray<string>) => ReadonlyArray<McpAppCopy>;
  /** Keep the copies a Fork or Clone's source sent, as the calls of conversation `conversation`; the bounds apply. */
  readonly adopt: (copies: ReadonlyArray<McpAppCopy>, conversation: ConversationId) => void;
};

export class McpApps extends Context.Service<McpApps, McpAppsService>()(
  "@cloudpid/server/session/mcp-apps/McpApps",
) {}
