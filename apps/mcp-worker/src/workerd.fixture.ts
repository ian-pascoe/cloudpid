// The test Worker for the engine's workerd tests: the tests reach `McpWorker` (an auxiliary Worker, bundled as it
// deploys, without `nodejs_compat`) over its bindings, and a `Caller` object stands in for a host that dies mid-call.
// @effect-diagnostics asyncFunction:off newPromise:off -- workerd's Durable Object and RPC APIs are Promise-based.
import { DurableObject } from "cloudflare:workers";
import type { McpEngineMethods } from "@cloudpid/mcp/types";

interface CallerEnv {
  readonly MCP_ENGINE: McpEngineMethods;
}

/** A host stand-in that calls the engine and never aborts the call itself: it can only die. */
export class Caller extends DurableObject<CallerEnv> {
  async request(
    target: Parameters<McpEngineMethods["request"]>[0],
    prior: Parameters<McpEngineMethods["request"]>[1],
    req: Parameters<McpEngineMethods["request"]>[2],
  ) {
    return this.env.MCP_ENGINE.request(target, prior, req, {
      untilAborted: () => new Promise<void>(() => undefined),
    });
  }

  /** Resets this object, as a deploy or an eviction would, rejecting the calls in flight. */
  die() {
    this.ctx.abort("the caller died");
  }
}

export default {
  fetch: () => new Response("Not found", { status: 404 }),
};
