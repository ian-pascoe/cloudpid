// docs/architecture/mcp-endpoint.md → The handler, Access and identity, The `api` target: `/mcp` on the main Worker, after
// the Access guard. The request that reaches `McpServer` is the caller's own with every `Cf-Access-*` header, cookie and
// `Authorization` removed (and no `AbortSignal`, which RPC cannot carry), and the caller's identity travels only inside the
// `api` target built here.
// @effect-diagnostics asyncFunction:off tryCatchInEffectGen:off preferEffectArray:off missingPipeableSignature:off globalFetch:off -- the Request/Response seam of Workers.
import type { McpServerBinding } from "@cloudpid/mcp-worker";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { AccessCaller } from "../access.ts";
import { REGISTRY_NAME, type Registry } from "../registry/Registry.ts";
import type { Session } from "../session/Session.ts";
import type * as Cloudflare from "@alchemy.run/cloudflare";
import { mcpApiService, type McpBackend, MCP_CALLS_PERIOD_S } from "./api.ts";
import { apiTarget, type RpcTargetBase } from "./api-target.ts";

/** The headers that name or prove who is calling: none reaches `McpServer`. */
const IDENTITY_HEADERS = [
  "cf-access-jwt-assertion",
  "cf-access-client-id",
  "cf-access-client-secret",
  "cf-access-authenticated-user-email",
  "cookie",
  "authorization",
];

/** The runtime's rate limit binding (`MCP_CALLS`): counts a key, and says whether it is within the rate. */
export interface RateLimiter {
  limit(options: { readonly key: string }): Promise<{ readonly success: boolean }>;
}

/** What the route takes of the Worker. */
export interface McpEndpoint {
  readonly registries: Cloudflare.DurableObject<Registry>;
  readonly sessions: Cloudflare.DurableObject<Session>;
  /** `McpWorker`'s `McpServer` entrypoint (`MCP_SERVER`). */
  readonly server: McpServerBinding;
  /** `MCP_CALLS`; absent where the runtime has none (`alchemy dev`), which is no limit. */
  readonly calls: RateLimiter | undefined;
  /** Where the `api` target gets `RpcTarget` from: the Worker's default; a test under Node gives a plain class. */
  readonly loadRpcTarget?: () => Promise<RpcTargetBase>;
}

/** The request as `McpServer` gets it: the caller's own, with no identity header, cookie or signal. */
const forwardedRequest = (source: Request): Request => {
  const headers = new Headers(source.headers);

  for (const name of IDENTITY_HEADERS) headers.delete(name);

  // A Request over the source keeps its method and body (a stream needs no `duplex`); `signal: null` leaves RPC no signal.
  return new Request(source, { headers, signal: null });
};

/** The Registry's and the Sessions' side of one request: each call is one RPC. */
const backendOf = (endpoint: McpEndpoint): McpBackend => {
  const registry = endpoint.registries.getByName(REGISTRY_NAME);

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
    status: (id) => endpoint.sessions.getByName(id).status().pipe(Effect.orDie),
    transcript: (id, request) =>
      endpoint.sessions.getByName(id).transcriptPage(request).pipe(Effect.orDie),
  };
};

/**
 * Serves `/mcp`: `MCP_SERVER.serve(request, api)`, with `api` built for this request over the Registry and the Sessions and
 * the identity the guard admitted. The response is `McpServer`'s: a stream while a call is open.
 */
export const serveMcpRoute = (endpoint: McpEndpoint) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const caller = yield* AccessCaller;
    const source = request.source;

    if (!(source instanceof Request)) {
      return HttpServerResponse.text("Not found", { status: 404 });
    }

    const run = Effect.runPromiseWith(yield* Effect.context<never>());

    const service = mcpApiService(backendOf(endpoint), {
      origin: new URL(source.url).origin,
      caller,
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

    const target = yield* Effect.promise(() => apiTarget(service, run, endpoint.loadRpcTarget));

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
            { status: 503, headers: { "retry-after": String(MCP_CALLS_PERIOD_S / 12) } },
          ),
        ),
      ),
    );

    return HttpServerResponse.fromWeb(response);
  });
