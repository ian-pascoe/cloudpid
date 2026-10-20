// The test Worker for Sessions on Workspaces: the Workspace DO and a Session host on it. It is a Worker of its own, apart
// from `workerd.fixture.ts`'s: the Session host's modules slow the Workspace environment conformance cases in the
// Worker that hosts their Workspace DO (two binary reader cases time out).
export { TestWorkspaceSession } from "./session.fixture.ts";

export { TestWorkspace, WorkspaceServiceProxy } from "./workerd.fixture.ts";

export default {
  fetch: () => new Response("cloudpid Session on Workspace test worker"),
};
