/**
 * The MCP core: the official TypeScript SDK v2 inside one Effect interface for both protocol eras (ADR-0036). This
 * entry loads `@modelcontextprotocol/client`, so only `McpEngine` and `McpServer` (the `McpWorker`) import it: the
 * SDK adds about 9-10 MiB of cold heap to every isolate that loads it.
 *
 * `docs/architecture/mcp.md` → Packages and objects (the SDK pin, the import rule, the core's seam).
 */
export {
  type CallToolParams,
  type Complete,
  connect,
  type InputRequired,
  type ListItems,
  type ListedPage,
  type ListKind,
  type McpConnection,
  type McpConnectionStats,
  type McpDeps,
  type McpLog,
  type McpTarget,
  type PagesRequired,
  type McpTasks,
  type Outcome,
  type ReadComplete,
  type RowStore,
  type TaskStarted,
  type TaskState,
} from "./connection.ts";

export {
  MCP_APPS_EXTENSION,
  MODERN_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./protocol.ts";

export { fetchPublic } from "./public-fetch.ts";
