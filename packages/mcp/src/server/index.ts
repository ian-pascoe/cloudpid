/**
 * `@cloudpid/mcp/server`: cloudpid's own MCP endpoint (`docs/architecture/mcp-endpoint.md` → The handler). It loads the
 * SDK's server, so only `McpWorker`'s `McpServer` entrypoint (and the conformance run) import it.
 */
export {
  DESCRIBE_TTL_MS,
  instructionsFor,
  KEEP_ALIVE_MS,
  MAX_REQUEST_BODY_BYTES,
  MAX_STRUCTURED_BYTES,
  type Gate,
  type Caller,
  type McpObserver,
  type McpServeDeps,
  type McpServerApi,
  serveMcp,
  toolGate,
  tracingObserver,
  type Tracing,
  type ToolGate,
  unobserved,
} from "./handler.ts";
