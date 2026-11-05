// The Workspaces Worker's entry: it hosts the Workspace DO, `WorkspaceServiceProxy`, through which the Worker Shell's
// Dynamic Worker reaches the DO (as `ctx.exports.WorkspaceServiceProxy`), `WorkspaceProxy`, which carries the
// Container's egress back to the DO (`ctx.exports.WorkspaceProxy`), and `ContainerExitReports`, which logs what the
// Container's supervisor reports when computerd stops on its own (`ctx.exports.ContainerExitReports`), and
// `WorkspaceContainerPreviews`, which the browser Worker binds to reach a Workspace's Container preview and nothing else
// of the DO, and `WorkspaceMcpBridge`, which `McpWorker` binds (as `MCP_BRIDGE`) to reach a Workspace's Container MCP
// bridge and nothing else of the DO. It is a plain (async) Worker because alchemy's Effect Workers export only their Effect-defined classes.
// @effect-diagnostics globalConsole:off asyncFunction:off
import { isContainerPreviewWorkspace } from "@cloudpid/extensions/browser/contract";
import { WorkerEntrypoint } from "cloudflare:workers";
import { isWorkspaceObjectName, WORKSPACE_BINDING } from "./binding.ts";
import { type ExitReportProps, exitReport } from "./exit-report.ts";
import type { McpBridgeOptions } from "@cloudpid/sandbox-image/mcp-bridge";
import { refuse } from "./mcp-bridge.ts";
import type { Workspace, WorkspaceEnv } from "./Workspace.ts";

export { WorkspaceProxy, WorkspaceServiceProxy } from "@cloudflare/computer";

export { Workspace } from "./Workspace.ts";

/**
 * The report host of one Workspace's Container (docs/architecture/container.md → Exit reports): the Workspace
 * DO intercepts `EXIT_REPORT_HOST` with it, naming itself in `props`. A report goes to the Workers logs and nowhere
 * else, so it needs nothing of the DO.
 */
export class ContainerExitReports extends WorkerEntrypoint<
  WorkspaceEnv & { readonly [WORKSPACE_BINDING]: DurableObjectNamespace<Workspace> },
  ExitReportProps
> {
  override fetch(request: Request): Promise<Response> {
    const { workspace } = this.ctx.props;

    return exitReport(request, {
      workspace,
      // The DO the report names holds the GitHub tokens it minted and its Environment's Secrets, sealed: it takes them
      // out of the lines.
      redact: async (output) => {
        const namespace = this.env[WORKSPACE_BINDING];

        const redacted = await namespace
          .get(namespace.idFromString(workspace))
          .redactExitReport(output);

        return redacted ?? undefined;
      },
      log: (report) => console.warn(report),
    });
  }
}

/**
 * A Workspace's Container preview (ADR-0023), as the browser Worker reaches it through a service binding: this one call,
 * not the Workspace DO's other methods, and only for a Workspace's object (`ws:<id>`), never a Build's.
 */
export class WorkspaceContainerPreviews extends WorkerEntrypoint<{
  readonly [WORKSPACE_BINDING]: DurableObjectNamespace<Workspace>;
}> {
  /** Answer `request`, a page's in the Session's browser, from Workspace DO `workspace`'s Container `port`. */
  async containerPreview(workspace: string, request: Request, port: number): Promise<Response> {
    if (!isContainerPreviewWorkspace(workspace)) return new Response("Not found", { status: 404 });

    return this.env[WORKSPACE_BINDING].getByName(workspace).containerPreview(request, port);
  }
}

/**
 * A Workspace's Container MCP bridge (docs/architecture/mcp-connections.md → The stdio bridge), as `McpWorker`'s engine
 * reaches it through a service binding: this one call, not the Workspace DO's other methods, and only for a Workspace's
 * object (`ws:<id>`), never a Build's.
 */
export class WorkspaceMcpBridge extends WorkerEntrypoint<{
  readonly [WORKSPACE_BINDING]: DurableObjectNamespace<Workspace>;
}> {
  /**
   * Answer `request`, the engine's, from the bridge in Workspace DO `workspace`'s Container, with the bridge token the
   * launch holds as its bearer. `start` lets it start a stopped Container; `use` makes it a use of the Container, held
   * until the response's body ends; neither is activity. It answers 404 `no_workspace` for a Workspace that does not
   * exist and 503 `stopped` (`x-cloudpid-container: stopped`) for a stopped Container it may not start.
   */
  async mcpBridge(
    workspace: string,
    request: Request,
    options: McpBridgeOptions,
  ): Promise<Response> {
    if (!isWorkspaceObjectName(workspace)) return refuse(request, "no_workspace");

    return this.env[WORKSPACE_BINDING].getByName(workspace).mcpBridge(request, options);
  }
}

/** Workspaces are reached over RPC only (and, for now, the throwaway #143 probe's token-guarded route). */
export default {
  fetch: async (
    request: Request,
    env: { readonly [WORKSPACE_BINDING]: DurableObjectNamespace<Workspace>; readonly PROBE_143_TOKEN?: string },
  ) => {
    const url = new URL(request.url);
    const token = env.PROBE_143_TOKEN ?? "";
    if (
      url.pathname.startsWith("/probe-143/") &&
      token.length >= 32 &&
      request.headers.get("x-probe-token") === token
    ) {
      const op = url.pathname.slice("/probe-143/".length);
      const name = `ws:probe143-${url.searchParams.get("ws") ?? "a"}`;
      try {
        const text = await env[WORKSPACE_BINDING].getByName(name).probe143(op);
        return new Response(text, { headers: { "content-type": "application/json" } });
      } catch (cause) {
        return new Response(String((cause as Error)?.stack ?? cause), { status: 500 });
      }
    }
    return new Response("Not found", { status: 404 });
  },
};
