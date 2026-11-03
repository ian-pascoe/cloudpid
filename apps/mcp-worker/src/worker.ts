// `McpWorker`'s entry (`docs/architecture/mcp-connections.md` → The engine): a plain Worker, so it can export the
// `McpEngine` entrypoint `Server` binds as `MCP_ENGINE`, and `McpServer`, the one it binds as `MCP_SERVER` for `/mcp`
// (`docs/architecture/mcp-endpoint.md` → The handler). It is reached over RPC only; a request gets 404.
export { McpEngine } from "./engine.ts";

export { McpServer } from "./server.ts";

export default {
  fetch: () => new Response("Not found", { status: 404 }),
};
