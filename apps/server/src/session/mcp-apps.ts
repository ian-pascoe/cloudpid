// The Session's MCP App records as the rest of the Session reaches them (`docs/architecture/mcp-apps.md` → App records,
// Socket messages): the service's shape. The implementation, over the object's storage, is `./mcp-apps-store.ts`; this
// file has no import of the sockets, which read the service.
import type { McpAppRecorder } from "@cloudpid/extensions/mcp";
import type {
  ConversationId,
  McpAppCopies,
  McpAppEntry,
  McpAppHtmlAnswer,
  McpAppMounted,
  McpAppTool,
} from "@cloudpid/protocol";
import type { AppCalls } from "./mcp-app-calls.ts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

/** What the Session holds of its App records, and of its inventory's App tools. */
export type McpAppsService = McpAppRecorder &
  McpAppCopies &
  AppCalls & {
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
     * The page of `callId`'s record, for the record's own server: by its pinned hash, or, when it pins none or the host no
     * longer keeps the page, by the `ui://` resource its tool declares, pinned to the record once the host has given it.
     */
    readonly pageOf: (callId: string) => Effect.Effect<McpAppHtmlAnswer>;
  };

export class McpApps extends Context.Service<McpApps, McpAppsService>()(
  "@cloudpid/server/session/mcp-apps/McpApps",
) {}
