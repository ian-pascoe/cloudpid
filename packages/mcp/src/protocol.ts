/**
 * The protocol versions and extensions the core speaks (`docs/architecture/mcp.md` → Protocol eras, Extensions).
 */
// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, not combinators.
import type { ClientCapabilities, JSONObject } from "@modelcontextprotocol/client";
import type { McpCallContext, McpRoot } from "./types.ts";

/** The one Modern version (The MCP core #394 D1). */
export const MODERN_PROTOCOL_VERSION = "2026-07-28";

/** Legacy offers the first and accepts the rest, as pi-mcp does (D1). */
export const LEGACY_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** Exactly these five: the SDK's own list adds `2024-10-07`, which cloudpid drops (D1). */
export const SUPPORTED_PROTOCOL_VERSIONS = [MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS];

/** MCP Apps, declared always, in both eras, on every request (D23; `docs/architecture/mcp-apps.md`). */
export const MCP_APPS_EXTENSION = "io.modelcontextprotocol/ui";

export const MCP_APPS_CAPABILITY: JSONObject = { mimeTypes: ["text/html;profile=mcp-app"] };

/**
 * What the client declares: the injected capabilities, plus the injected extensions and MCP Apps, and `roots` only on a
 * connection that has Roots to offer (a stdio server's, `docs/architecture/mcp-in-a-session.md` → Roots): a remote server
 * is declared none. `roots.listChanged` is never declared: a Workspace's Repos are fixed when it is made.
 */
export const declaredCapabilities = (
  capabilities: (ctx?: McpCallContext) => ClientCapabilities,
  extensions: Readonly<Record<string, JSONObject>> | undefined,
  roots: ReadonlyArray<McpRoot> | undefined,
  ctx?: McpCallContext,
): ClientCapabilities => {
  const base = capabilities(ctx);

  const declared: ClientCapabilities = {
    ...base,
    extensions: { ...base.extensions, ...extensions, [MCP_APPS_EXTENSION]: MCP_APPS_CAPABILITY },
  };

  if (roots !== undefined) declared.roots = {};

  return declared;
};
