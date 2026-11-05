// `McpWorker`'s compatibility (`docs/development/workers.md` → Effect Workers and plain Workers), in a module that imports
// nothing, so that its deploy (`resource.ts`) and its workerd tests (`vitest.config.ts`) run with the same.

/**
 * The date, and `global_fetch_strictly_public`: the engine's `fetch` goes out as a request from the Internet would, so an
 * MCP server on one of cloudpid's own hosts (its own MCP endpoint, Self-use) or another Worker of the account is reached
 * through its front door, Access included, rather than refused (error 1042) or sent to the origin past Access. No
 * `nodejs_compat`: the SDK client, Effect and TypeBox need none.
 */
export const MCP_WORKER_COMPATIBILITY = {
  date: "2026-08-31",
  flags: ["global_fetch_strictly_public"],
} as const;
