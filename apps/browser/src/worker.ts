// The browser Worker's entry: it hosts the browser host Durable Object, one instance per Session, and the
// `CodemodeRuntime` facet class `agents/browser`'s tool needs the entry to export. It is a plain (async) Worker because
// alchemy's Effect Workers export only their Effect-defined classes (see `apps/server/src/workspace/worker.ts`). The
// Session DO reaches the object over a Durable Object binding; nothing else does.
export { CodemodeRuntime } from "@cloudflare/codemode";

export { BrowserHost } from "./BrowserHost.ts";

/** The browser host is reached over RPC only. */
export default {
  fetch: () => new Response("Not found", { status: 404 }),
};
