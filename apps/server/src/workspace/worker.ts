// The Workspaces Worker's entry: it hosts the Workspace DO, `WorkspaceServiceProxy`, through which the Worker Shell's
// Dynamic Worker reaches the DO (as `ctx.exports.WorkspaceServiceProxy`), `WorkspaceProxy`, which carries the
// Container's egress back to the DO (`ctx.exports.WorkspaceProxy`), and `ContainerExitReports`, which logs what the
// Container's supervisor reports when computerd stops on its own (`ctx.exports.ContainerExitReports`). It is a plain
// (async) Worker because alchemy's Effect Workers export only their Effect-defined classes.
// @effect-diagnostics globalConsole:off
import { WorkerEntrypoint } from "cloudflare:workers";
import { type ExitReportProps, exitReport } from "./exit-report.ts";
import type { WorkspaceEnv } from "./Workspace.ts";

export { WorkspaceProxy, WorkspaceServiceProxy } from "@cloudflare/computer";

export { Workspace } from "./Workspace.ts";

/**
 * The report host of one Workspace's Container (docs/spec.md → Container and Toolchains → Exit reports): the Workspace
 * DO intercepts `EXIT_REPORT_HOST` with it, naming itself in `props`. A report goes to the Workers logs and nowhere
 * else, so it needs nothing of the DO.
 */
export class ContainerExitReports extends WorkerEntrypoint<WorkspaceEnv, ExitReportProps> {
  override fetch(request: Request): Promise<Response> {
    return exitReport(request, {
      workspace: this.ctx.props.workspace,
      secret: this.env.CLOUDPID_GITHUB_TOKEN,
      log: (report) => console.warn(report),
    });
  }
}

/** Workspaces are reached over RPC only. */
export default {
  fetch: () => new Response("Not found", { status: 404 }),
};
