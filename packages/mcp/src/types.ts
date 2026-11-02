/**
 * `@cloudpid/mcp/types`: Effect Schemas for `McpHost`'s and `McpEngine`'s RPC (`McpEngineMethods` included). It never
 * loads the SDK, so Sessions, the `mcp` extension, `McpHost`, the web app and the bridge can import it; its test
 * (`sdk-isolation.test.ts`) fails if it comes to.
 *
 * `docs/architecture/mcp.md` → Packages and objects. A skeleton: the schemas land in later changes.
 */
export {};
