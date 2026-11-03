// docs/architecture/mcp-endpoint.md → The `api` target: the `RpcTarget` `McpServer` is handed, over `McpApiService`. A
// class of `cloudflare:workers` is loaded when the first `/mcp` request needs it (`rpc-target.ts`), since the stack imports
// the Worker's module under Node. Only methods and getters of the prototype cross RPC, so the service and the runner it
// holds are private. An operation `describe()` does not list answers `unsupported` (every edge only gains: a `McpServer`
// that is newer than this `Server` finds out here, loudly, and leaves the tool out).
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- a class over a service, loaded by a dynamic import.
import {
  type ApiResult,
  apiFailure,
  type McpApi,
  type SessionsQuery,
  type TranscriptRequest,
} from "@cloudpid/protocol";
import type { RpcTarget } from "cloudflare:workers";
import type * as Effect from "effect/Effect";
import type { McpApiService } from "./api.ts";

/** Runs an Effect to a Promise: the one the Worker's fiber holds, so spans and services are the request's. */
export type RunEffect = <A>(effect: Effect.Effect<A>) => Promise<A>;

const unsupported = (operation: string): ApiResult<never> =>
  apiFailure("unsupported", `This version of cloudpid does not serve ${operation} yet.`);

/** What the target extends: `cloudflare:workers`' `RpcTarget`, which only the Workers runtime has. */
export interface RpcTargetBase {
  readonly RpcTarget: typeof RpcTarget;
}

/** Loads {@link RpcTargetBase} when the first `/mcp` request needs it. */
export const loadRpcTarget = (): Promise<RpcTargetBase> => import("./rpc-target.ts");

/** The `api` target for one request. `load` is the Worker's own; a test under Node gives a plain class. */
export const apiTarget = async (
  service: McpApiService,
  run: RunEffect,
  load: () => Promise<RpcTargetBase> = loadRpcTarget,
) => {
  const { RpcTarget } = await load();

  class McpApiTarget extends RpcTarget {
    #service = service;
    #run = run;

    describe() {
      return this.#service.describe();
    }

    environments() {
      return this.#run(this.#service.environments);
    }

    sessions(query: SessionsQuery) {
      return this.#run(this.#service.sessions(query));
    }

    session(id: string) {
      return this.#run(this.#service.session(id));
    }

    transcript(request: TranscriptRequest & { readonly session_id: string }) {
      return this.#run(this.#service.transcript(request));
    }

    start(request: Parameters<McpApi["start"]>[0]) {
      return this.#run(this.#service.start(request));
    }

    send(request: Parameters<McpApi["send"]>[0]) {
      return this.#run(this.#service.send(request));
    }

    stop(request: Parameters<McpApi["stop"]>[0]) {
      return this.#run(this.#service.stop(request));
    }

    // Not served yet: `describe()` does not list it, and a caller that asks anyway is told so.
    wait() {
      return unsupported("waiting for a Run");
    }

    /** Over RPC `await api.limited`: counts the call, and is present only when the caller is over its rate. */
    get limited() {
      return this.#run(this.#service.limited);
    }

    get auth() {
      return this.#service.auth;
    }
  }

  return new McpApiTarget();
};
