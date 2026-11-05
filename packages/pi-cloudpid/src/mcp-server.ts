// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, called directly.
/**
 * The `cloudpid` MCP server this extension hands to pi (docs/architecture/mcp-endpoint.md → The `/cloudpid` command →
 * The MCP server), so pi's own MCP support (`/mcp`, its sign-in, the tools for the model) connects to the endpoint
 * without a hand-written `mcp.json` entry. pi keeps no registration (it is not saved), so `index.ts` registers on every
 * `session_start`; an `mcp.json` entry of the same name wins, which pi shows in `/mcp`.
 */
import type { ExtensionAPI, McpServerConfig } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";

/** The name the server is registered under: the tools are `mcp__cloudpid__<tool>`. */
export const MCP_SERVER_NAME = "cloudpid";

/** What `/mcp` and the model's `mcp_servers` section say the server is. */
export const MCP_SERVER_DESCRIPTION =
  "cloudpid's Sessions, Runs and transcripts: start, follow, read and stop the owner's agent work.";

/**
 * The server's config: the endpoint's URL, `exposure` left at pi's default, and the import tools hidden, since they are
 * for `/cloudpid import` and never for a model.
 */
const serverConfigOf = (config: Config): McpServerConfig => ({
  url: config.url.href,
  toolExposure: { "session_import_*": "hidden" },
  description: MCP_SERVER_DESCRIPTION,
});

/** The two calls of pi's API this uses. */
type McpRegistry = Pick<ExtensionAPI, "registerMcpServer" | "unregisterMcpServer">;

/**
 * Keeps pi's registration of `cloudpid` in step with the settings. Called with what the settings give now: the
 * endpoint registers it (the same URL again does nothing; another URL replaces the registration), none unregisters one
 * this made earlier (pi builds a new runtime at each session start, so this only matters to a `session_start` that
 * fires again on the same load). A registration pi refuses (another extension owns the name, a config it rejects) is
 * passed to `warn`, once per distinct reason, and never thrown.
 */
export const mcpRegistration = (pi: McpRegistry) => {
  let registered: string | undefined;
  let warned: string | undefined;

  return (config: Config | undefined, warn: (message: string) => void): void => {
    // A refusal is remembered only until the next call that does not repeat it.
    const lastWarning = warned;

    warned = undefined;

    if (config === undefined) {
      if (registered === undefined) return;

      registered = undefined;

      try {
        pi.unregisterMcpServer(MCP_SERVER_NAME);
      } catch {
        // pi no longer has the extension (it is shutting down): the registration went with it.
      }

      return;
    }

    if (config.url.href === registered) return;

    try {
      pi.registerMcpServer(MCP_SERVER_NAME, serverConfigOf(config));
      registered = config.url.href;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      warned = reason;

      if (reason !== lastWarning) {
        warn(`cloudpid: pi did not take the "${MCP_SERVER_NAME}" MCP server: ${reason}`);
      }
    }
  };
};
