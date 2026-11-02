/**
 * The MCP core: the official TypeScript SDK v2 inside one Effect interface for both protocol eras (ADR-0036). This
 * entry loads `@modelcontextprotocol/client`, so only `McpEngine` and `McpServer` (the `McpWorker`) import it: the
 * SDK adds about 9-10 MiB of cold heap to every isolate that loads it.
 *
 * `docs/architecture/mcp.md` → Packages and objects (the SDK pin, the import rule). A skeleton: the core's seam
 * (`connect`, `McpConnection`, `McpError`) lands in later changes.
 */
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client";

/** The newest protocol version the pinned SDK speaks. */
export const SDK_PROTOCOL_VERSION: string = LATEST_PROTOCOL_VERSION;
