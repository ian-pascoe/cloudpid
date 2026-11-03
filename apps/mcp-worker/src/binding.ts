import type { McpBridgeOptions } from "@cloudpid/sandbox-image/mcp-bridge";
import type { RpcTarget } from "cloudflare:workers";

/** The name `Server` binds `McpWorker`'s `McpEngine` entrypoint under, for `McpHost` (ADR-0038). */
export const MCP_ENGINE_BINDING = "MCP_ENGINE";

/** The `McpWorker` entrypoint `Server` binds as `MCP_ENGINE`. */
export const MCP_ENGINE_ENTRYPOINT = "McpEngine";

/** The name `Server` binds `McpWorker`'s `McpServer` entrypoint under, for `/mcp` (`docs/architecture/mcp-endpoint.md` → The handler). */
export const MCP_SERVER_BINDING = "MCP_SERVER";

/** The `McpWorker` entrypoint `Server` binds as `MCP_SERVER`. */
export const MCP_SERVER_ENTRYPOINT = "McpServer";

/**
 * What `MCP_SERVER` answers: `serve` takes the request the main Worker verified (with no `Cf-Access-*` header or cookie)
 * and its `McpApi` target, and returns the endpoint's response, a stream when the call is. It only gains members.
 */
export interface McpServerBinding {
  serve(request: Request, api: RpcTarget): Promise<Response>;
}

/** The name `McpWorker` binds the Workspaces Worker's `WorkspaceMcpBridge` entrypoint under (`docs/architecture/mcp-connections.md` → The engine). */
export const MCP_BRIDGE_BINDING = "MCP_BRIDGE";

/** The Workspaces Worker's entrypoint `McpWorker` binds as `MCP_BRIDGE`. */
export const WORKSPACE_MCP_BRIDGE_ENTRYPOINT = "WorkspaceMcpBridge";

/**
 * What `MCP_BRIDGE` answers (`apps/server/src/workspace/worker.ts`, `WorkspaceMcpBridge`): `request`, the engine's, from
 * the bridge in the Container of Workspace object `workspace` (`ws:<id>`), or one of its own refusals
 * (`McpBridgeRefusal`). It only gains.
 */
export interface McpBridgeBinding {
  mcpBridge(workspace: string, request: Request, options: McpBridgeOptions): Promise<Response>;
}
