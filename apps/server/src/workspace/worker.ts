// The Workspaces Worker's entry: it hosts the Workspace DO, and `WorkspaceServiceProxy`, through which the Worker
// Shell's Dynamic Worker reaches the DO (as `ctx.exports.WorkspaceServiceProxy`). It is a plain (async) Worker because
// alchemy's Effect Workers export only their Effect-defined classes.
export { WorkspaceServiceProxy } from "@cloudflare/computer";

export { Workspace } from "./Workspace.ts";

/** Workspaces are reached over RPC only. */
export default {
  fetch: () => new Response("Not found", { status: 404 }),
};
