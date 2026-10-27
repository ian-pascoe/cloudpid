// The Workspaces Worker's entry: it hosts the Workspace DO, `WorkspaceServiceProxy`, through which the Worker Shell's
// Dynamic Worker reaches the DO (as `ctx.exports.WorkspaceServiceProxy`), `WorkspaceProxy`, which carries the
// Container's egress back to the DO (`ctx.exports.WorkspaceProxy`), and `ContainerExitReports`, which logs what the
// Container's supervisor reports when computerd stops on its own (`ctx.exports.ContainerExitReports`), and
// `WorkspaceContainerPreviews`, which the browser Worker binds to reach a Workspace's Container preview and nothing else
// of the DO. It is a plain (async) Worker because alchemy's Effect Workers export only their Effect-defined classes.
// @effect-diagnostics globalConsole:off asyncFunction:off
import { isContainerPreviewWorkspace } from "@cloudpid/extensions/browser/contract";
import { WorkerEntrypoint } from "cloudflare:workers";
import { WORKSPACE_BINDING } from "./binding.ts";
import { type ExitReportProps, exitReport } from "./exit-report.ts";
import type { Workspace, WorkspaceEnv } from "./Workspace.ts";

export { WorkspaceProxy, WorkspaceServiceProxy } from "@cloudflare/computer";

export { Workspace } from "./Workspace.ts";

/**
 * The report host of one Workspace's Container (docs/spec.md → Container and Toolchains → Exit reports): the Workspace
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
      secret: this.env.CLOUDPID_GITHUB_TOKEN,
      // The DO the report names holds its Environment's Secrets, sealed: it takes them out of the lines.
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

/** Workspaces are reached over RPC only. */
export default {
  fetch: () => new Response("Not found", { status: 404 }),
};
