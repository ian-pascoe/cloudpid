// docs/architecture/mcp-endpoint.md → The handler, Access and identity, The `api` target: `/mcp` on the main Worker, after
// the Access guard. The request that reaches `McpServer` is the caller's own with every `Cf-Access-*` header, cookie and
// `Authorization` removed (and no `AbortSignal`, which RPC cannot carry), and the caller's identity travels only inside the
// `api` target built here.
// @effect-diagnostics asyncFunction:off tryCatchInEffectGen:off preferEffectArray:off missingPipeableSignature:off globalFetch:off -- the Request/Response seam of Workers.
import type { McpServerBinding } from "@cloudpid/mcp-worker";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { AccessCaller } from "../access.ts";
import type { Builds } from "../registry/builds.ts";
import { REGISTRY_NAME, type Registry } from "../registry/Registry.ts";
import { type RemovalObjects, removals } from "../registry/removal.ts";
import { type Spares, upkeepAfterStart } from "../registry/rpc.ts";
import type { Session } from "../session/Session.ts";
import type * as Cloudflare from "@alchemy.run/cloudflare";
import { approvalWait, approvalWithdraw } from "../harness/approval-follow.ts";
import { approvalRunner } from "../harness/approval-runner.ts";
import { harnessDispatch } from "../harness/dispatch.ts";
import { harnessServices } from "../harness/services.ts";
import { mcpApiService, type McpBackend } from "./api.ts";
import type { McpHost } from "./McpHost.ts";
import type { McpPushes } from "./push.ts";
import { apiTarget, type RpcTargetBase } from "./api-target.ts";

/**
 * The headers that name or prove who is calling: every `Cf-Access-*` header (the assertion, a service token's id and
 * secret, the authenticated user's email, and whatever Access adds), the cookie and `Authorization`. None reaches
 * `McpServer` (`docs/architecture/mcp-endpoint.md` → Access and identity).
 */
const isIdentityHeader = (name: string): boolean => {
  const lower = name.toLowerCase();

  return lower.startsWith("cf-access-") || lower === "cookie" || lower === "authorization";
};

/** What a caller is told to wait when `McpServer` cannot be reached (`Retry-After`, seconds): a deploy usually takes seconds. */
const UNAVAILABLE_RETRY_AFTER_S = 5;

/** The runtime's rate limit binding (`MCP_CALLS`): counts a key, and says whether it is within the rate. */
export interface RateLimiter {
  limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>;
}

/** What the route takes of the Worker; `R` is what its `background` needs of the request. */
export interface McpEndpoint<R = never> {
  readonly registries: Cloudflare.DurableObject<Registry>;
  readonly sessions: Cloudflare.DurableObject<Session>;
  /** The Environments' hosts, whose held inventory `settings_mcp_list` and `settings_mcp_get` show (`harness/services.ts`). */
  readonly mcpHosts: Pick<Cloudflare.DurableObject<McpHost>, "getByName">;
  /** `APP_ORIGIN_VAR`: this stage's own origin, set on live stages only; the management tools' Self-use rule reads it. */
  readonly appOrigin: string | undefined;
  /**
   * What deleting an import's Session wipes besides its records, as the owner's delete does (`registry/removal.ts`), and
   * an approved Environment's delete (`harness/services.ts`).
   */
  readonly objects: RemovalObjects;
  /** `McpWorker`'s `McpServer` entrypoint (`MCP_SERVER`). */
  readonly server: McpServerBinding;
  /**
   * The spare and Build upkeep a start runs after the answer, as the owner's start does (`registry/rpc.ts`), and a change
   * of the management tools after theirs (`harness/services.ts`); `all` for a change of the Spare Workspace setting at
   * Global, and `rebuild` for the Build the agent asks for.
   */
  readonly spares: Pick<Spares, "of" | "all">;
  readonly builds: Pick<Builds, "of" | "rebuild">;
  /** The push of an Environment's MCP server set to its host after a change, as after the owner's save. */
  readonly mcp: Pick<McpPushes, "sync">;
  /** The deploy-time credentials no text a change keeps may hold (`DeployCredentials`): the GitHub App's key, in its forms. */
  readonly credentials: ReadonlyArray<string>;
  /** Runs `effect` once the answer is sent, keeping the request alive until it is done (`waitUntil`). */
  readonly background: (effect: Effect.Effect<void>) => Effect.Effect<void, never, R>;
  /** `MCP_CALLS`; absent where the runtime has none (`alchemy dev`), which is no limit. */
  readonly calls: RateLimiter | undefined;
  /** `Server`'s deploy id (`CF_VERSION_METADATA`), which `describe()` reports for `serverInfo.version`; absent under `alchemy dev`. */
  readonly version?: string | undefined;
  /** Where the `api` target gets `RpcTarget` from: the Worker's default; a test under Node gives a plain class. */
  readonly loadRpcTarget?: () => Promise<RpcTargetBase>;
}

/** The request as `McpServer` gets it: the caller's own, with no identity header, cookie or signal. */
const forwardedRequest = (source: Request): Request => {
  const headers = new Headers(source.headers);

  for (const name of Arr.filter(Arr.fromIterable(headers.keys()), isIdentityHeader)) {
    headers.delete(name);
  }

  // A Request over the source keeps its method and body (a stream needs no `duplex`); `signal: null` leaves RPC no signal.
  return new Request(source, { headers, signal: null });
};

/** The Registry's and the Sessions' side of one request: each call is one RPC. */
const backendOf = (
  endpoint: Pick<
    McpEndpoint,
    | "registries"
    | "sessions"
    | "mcpHosts"
    | "appOrigin"
    | "spares"
    | "builds"
    | "mcp"
    | "credentials"
    | "objects"
  >,
  background: (effect: Effect.Effect<void>) => Effect.Effect<void>,
  origin: string,
): McpBackend => {
  const registry = endpoint.registries.getByName(REGISTRY_NAME);

  const services = harnessServices({
    registry,
    mcpHosts: endpoint.mcpHosts,
    appOrigin: endpoint.appOrigin,
    builds: endpoint.builds,
    spares: endpoint.spares,
    mcp: endpoint.mcp,
    objects: endpoint.objects,
    background,
    credentials: endpoint.credentials,
    origin,
  });

  const dispatch = harnessDispatch(services);

  // An approved request no run is applying is applied by the caller's `approval_wait`, as by the owner's Approve.
  const runner = approvalRunner(services);

  // A failed RPC is a defect here: `McpApiService` answers every one as `unavailable`, which may heal.
  return {
    environments: Effect.suspend(() => registry.listEnvironments()).pipe(Effect.orDie),
    allSessions: Effect.suspend(() => registry.listSessions()).pipe(Effect.orDie),
    sessions: (query) => registry.sessions(query).pipe(Effect.orDie),
    session: (id) => registry.getSession({ id }).pipe(Effect.orDie),
    workspace: (id) => registry.getWorkspace({ id }).pipe(Effect.orDie),
    defaultModel: Effect.suspend(() => registry.getSettings()).pipe(
      Effect.map(({ settings }) => settings.model),
      Effect.orDie,
    ),
    models: Effect.suspend(() => registry.getModelCatalog()).pipe(Effect.orDie),
    status: (id, after) =>
      endpoint.sessions
        .getByName(id)
        .status(after === undefined ? undefined : { after })
        .pipe(Effect.orDie),
    wait: (id, request) =>
      endpoint.sessions.getByName(id).waitForChange(request).pipe(Effect.orDie),
    transcript: (id, request) =>
      endpoint.sessions.getByName(id).transcriptPage(request).pipe(Effect.orDie),
    createSession: ({
      environment,
      title,
      branch,
      base,
      marks,
      requestId,
      maxRunning,
      maxOpenImports,
    }) =>
      registry
        .createSession({
          title,
          workspace: { kind: "new", environment, branch, base },
          marks,
          requestId,
          maxRunning,
          maxOpenImports,
        })
        .pipe(
          Effect.orDie,
          // The Session took the Environment's spare or made a Workspace: either way, the next one is made ahead.
          Effect.tap((created) =>
            "refused" in created
              ? Effect.void
              : background(upkeepAfterStart(endpoint, environment)),
          ),
        ),
    configure: (id, request) =>
      endpoint.sessions.getByName(id).configure(request).pipe(Effect.orDie),
    submit: (id, request) => endpoint.sessions.getByName(id).submit(request).pipe(Effect.orDie),
    stop: (id, request) => endpoint.sessions.getByName(id).stop(request).pipe(Effect.orDie),
    stageImportBegin: (id, request) =>
      endpoint.sessions.getByName(id).stageImportBegin(request).pipe(Effect.orDie),
    stageImportAppend: (id, request) =>
      endpoint.sessions.getByName(id).stageImportAppend(request).pipe(Effect.orDie),
    stageImportFinish: (id, request) =>
      endpoint.sessions.getByName(id).stageImportFinish(request).pipe(Effect.orDie),
    stageImportCancel: (id) =>
      endpoint.sessions.getByName(id).stageImportCancel().pipe(Effect.orDie),
    // The Session's object, then its record, then its Workspace if it was the last Session in it.
    deleteSession: (id) =>
      Effect.suspend(() => removals(registry, endpoint.objects).removeSession(id)).pipe(
        Effect.orDie,
      ),
    // The management tools over the Registry and the hosts, with no Session.
    harness: (request, caller) => dispatch(request, caller),
    approvalWait: approvalWait({ registry: services.registry, runner }),
    approvalWithdraw: approvalWithdraw(services),
  };
};

/**
 * Serves `/mcp`: `MCP_SERVER.serve(request, api)`, with `api` built for this request over the Registry and the Sessions and
 * the identity the guard admitted. The response is `McpServer`'s: a stream while a call is open.
 */
export const serveMcpRoute = <R = never>(endpoint: McpEndpoint<R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const caller = yield* AccessCaller;
    const source = request.source;

    if (!(source instanceof Request)) {
      return HttpServerResponse.text("Not found", { status: 404 });
    }

    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const services = yield* Effect.context<R>();

    // The upkeep after a start or a change, and the notice of a change, are the Worker's own (`waitUntil`), which needs the
    // request's services.
    const background = (effect: Effect.Effect<void>) =>
      Effect.provideContext(endpoint.background(effect), services);

    const origin = new URL(source.url).origin;

    const service = mcpApiService(backendOf(endpoint, background, origin), {
      origin,
      caller,
      version: endpoint.version,
      withinRate: (key) => {
        const limiter = endpoint.calls;

        return limiter === undefined
          ? Effect.succeed(true)
          : Effect.tryPromise(() => limiter.limit({ key })).pipe(
              Effect.map(({ success }) => success),
              // The service reads a failed limiter as within the rate.
              Effect.orDie,
            );
      },
    });

    const target = yield* Effect.promise(() =>
      apiTarget(service, run, endpoint.loadRpcTarget, (promise) => {
        // Its outcome is the call's own: here it is only waited for.
        void Effect.tryPromise(() => promise).pipe(Effect.ignore, background, run);
      }),
    );

    const response = yield* Effect.tryPromise(() =>
      endpoint.server.serve(forwardedRequest(source), target),
    ).pipe(
      // `McpServer` is a deploy behind (or ahead, or cut): the caller may try again.
      Effect.catchCause(() =>
        Effect.succeed(
          Response.json(
            {
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "The MCP endpoint is not available: try again shortly.",
              },
              id: null,
            },
            { status: 503, headers: { "retry-after": String(UNAVAILABLE_RETRY_AFTER_S) } },
          ),
        ),
      ),
    );

    return HttpServerResponse.fromWeb(response);
  });
