// `McpWorker`'s entry (`docs/architecture/mcp-connections.md` → The engine): a plain Worker, so it can export the
// `McpEngine` entrypoint `Server` binds as `MCP_ENGINE`. It is reached over RPC only; a request gets 404.
export { McpEngine } from "./engine.ts";

export default {
  fetch: () => new Response("Not found", { status: 404 }),
};
