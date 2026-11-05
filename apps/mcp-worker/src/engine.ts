/**
 * `McpEngine`, the stateless `WorkerEntrypoint` that runs `@cloudpid/mcp` for `McpHost` (ADR-0038;
 * `docs/architecture/mcp-connections.md` → The engine; #382 D1, D13.2). `discover`, `request` and `listen` are here;
 * `control` lands with its first user. `fetchPublic` is not the core's: it is the Registry's sign-in read on one of
 * cloudpid's own hosts, made here for this Worker's `global_fetch_strictly_public` (`docs/architecture/mcp-sign-in.md` →
 * Code). One `ManagedRuntime` per isolate holds the byte budget and the validator cache, built at the first call.
 *
 * Each call's work is held under `ctx.waitUntil` as well as returned: without it, a host that dies mid-call has the
 * engine's invocation cancelled silently, its fetches with it, and a Legacy server is never told; with it, the call's
 * `untilAborted()` rejects and the engine aborts the server request (#409 answer 2).
 */
// @effect-diagnostics globalFetch:off -- `fetchPublic` reads with the Worker's own `fetch`, for its compatibility flag.
import { WorkerEntrypoint } from "cloudflare:workers";
import { fetchPublic } from "@cloudpid/mcp";
import type {
  McpPublicFetchRequest,
  McpEngineHooks,
  McpListenFilter,
  McpEngineMethods,
  McpEnginePriorEncoded,
  McpEngineRequestEncoded,
  McpEngineTargetEncoded,
} from "@cloudpid/mcp/types";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import type { Mutable } from "effect/Types";
import { ByteBudget } from "./budget.ts";
import type { McpBridgeBinding } from "./binding.ts";
import { discover, listen, request } from "./calls.ts";
import type { CallEnvironment } from "./call-context.ts";
import { Validators } from "./validators.ts";

/** What `McpWorker` is bound to (`resource.ts`). */
export interface McpWorkerEnv {
  /** The deployed version; absent where the Worker runs undeployed (tests). */
  readonly CF_VERSION_METADATA?: { readonly id: string };
  /** The Workspaces Worker's `WorkspaceMcpBridge`, which reaches a Workspace's Container MCP bridge; absent where undeployed. */
  readonly MCP_BRIDGE?: McpBridgeBinding;
}

const EngineLive = Layer.mergeAll(ByteBudget.layer, Validators.layer);

type EngineServices = Layer.Success<typeof EngineLive>;

let runtime: ManagedRuntime.ManagedRuntime<EngineServices, never> | undefined;

/** The isolate's runtime, built at its first call. */
const engineRuntime = () => {
  runtime ??= ManagedRuntime.make(EngineLive);

  return runtime;
};

export class McpEngine extends WorkerEntrypoint<McpWorkerEnv> implements McpEngineMethods {
  discover(target: McpEngineTargetEncoded, prior: McpEnginePriorEncoded, hooks: McpEngineHooks) {
    return this.#run(discover(target, prior, hooks, this.#environment()));
  }

  request(
    target: McpEngineTargetEncoded,
    prior: McpEnginePriorEncoded,
    req: McpEngineRequestEncoded,
    hooks: McpEngineHooks,
  ) {
    return this.#run(request(target, prior, req, hooks, this.#environment()));
  }

  listen(
    target: McpEngineTargetEncoded,
    prior: McpEnginePriorEncoded,
    filter: typeof McpListenFilter.Encoded,
    hooks: McpEngineHooks,
    stop?: ReadableStream<Uint8Array>,
  ) {
    return this.#run(listen(target, prior, filter, hooks, this.#environment(), stop));
  }

  fetchPublic(request: typeof McpPublicFetchRequest.Encoded) {
    const result = fetchPublic(request, (input, init) => fetch(input, init));

    this.ctx.waitUntil(result);

    return result;
  }

  #environment(): CallEnvironment {
    const { MCP_BRIDGE: bridge } = this.env;

    const environment: Mutable<CallEnvironment> = {
      version: this.env.CF_VERSION_METADATA?.id ?? "dev",
      hold: (done) => this.ctx.waitUntil(done),
    };

    if (bridge !== undefined) environment.bridge = bridge;

    return environment;
  }

  /** Runs a call, held under `ctx.waitUntil` until it settles. */
  #run<A>(call: Effect.Effect<A, never, EngineServices>) {
    const result = engineRuntime().runPromise(call);

    this.ctx.waitUntil(
      result.then(
        () => undefined,
        () => undefined,
      ),
    );

    return result;
  }
}
