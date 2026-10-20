// The codemode sandbox Worker's entry: it hosts pi-codemode's QuickJS sandbox Durable Object, one instance per Session.
// It is a plain (async) Worker because alchemy's Effect Workers export only their Effect-defined classes (see
// `apps/server/src/workspace/worker.ts`). The Session DO's `RemoteCodemodeSandbox` reaches the object over a Durable
// Object binding; nothing else does.
export { CodemodeSandboxDurableObject as CodemodeSandbox } from "@earendil-works/pi-codemode/cloudflare";

/** The sandbox is reached over RPC only. */
export default {
  fetch: () => new Response("Not found", { status: 404 }),
};
