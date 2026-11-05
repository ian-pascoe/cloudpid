// `McpEngine` as the host calls it (`docs/architecture/mcp-connections.md` → The host object, The engine): over the
// `MCP_ENGINE` binding, or a scripted fake. Arguments cross encoded and results are decoded here, so an answer this
// build cannot read, an engine that cannot be reached and one that does not answer in time are one failure,
// `McpEngineUnreachable`, which the host reads as the server being unavailable for now.
//
// A discovery passes the engine one hook only, `onDeprecated`, so a server's Sampling request is noted on any path, a
// discovery's included; a note lost to a dead stub fails nothing. It passes no other: it runs as a fiber in the host's
// runtime, often past the invocation that started it, and a function stub lives only as long as the invocation that
// made it (#409 answer 2), so an `untilAborted()` would cut it about 72 s later. The engine runs the discovery to its own
// bounds. The pending RPC does not keep the object in memory, though Cloudflare's lifecycle says pending operations
// prevent eviction: on prod, idle eviction cut one 107-125 s after the host's last request (#555). The host's
// keep-alive alarm holds it instead while a discovery is in flight (`keep-alive.ts`).
//
// A discovery the host interrupts (a set change, a reload, a destroy) is dropped here, unread: it runs nothing on the
// server, so the engine finishing it costs only its own time, except that an interrupted Legacy discovery leaves the
// `Mcp-Session-Id` it opened on the server until the server expires it.
// @effect-diagnostics missingPipeableSignature:off -- the engine's methods, not combinators.
import {
  MCP_CONNECT_TIMEOUT_MS,
  MCP_LIST_WALK_TIMEOUT_MS,
  McpEngineDiscoverResult,
  type McpEngineHooks,
  McpEngineListenResult,
  type McpEngineMethods,
  McpEngineRequest,
  McpEngineRequestResult,
  McpEngineTarget,
  McpListenFilter,
  MCP_LISTEN_ACK_MS,
} from "@cloudpid/mcp/types";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { PriorRows } from "./store.ts";

/** What the host waits past the engine's own bounds, for the RPC's way there and back. */
const DISCOVER_SLACK_MS = 15_000;

/**
 * The longest the host waits for a discovery: past the engine's own bounds for the slowest one, a Legacy server whose
 * era row is in doubt (three connects, 3 × 15 s, then walking the tools and the prompts, 2 × 120 s: 285 s), so only
 * an engine that went silent reaches it. 300 s.
 */
export const DISCOVER_TIMEOUT_MS =
  3 * MCP_CONNECT_TIMEOUT_MS + 2 * MCP_LIST_WALK_TIMEOUT_MS + DISCOVER_SLACK_MS;

/** The engine could not be reached, did not answer in time, or answered with something this build cannot read. */
export class McpEngineUnreachable extends Schema.TaggedError<
  McpEngineUnreachable,
  { readonly brand: unique symbol }
>()("McpEngineUnreachable", { message: Schema.String }) {}

/** What the host waits for a listen's acknowledgement past the engine's own 10 s: the RPC's way there and back, a connect that may be needed first. */
export const LISTEN_TIMEOUT_MS = 3 * MCP_CONNECT_TIMEOUT_MS + MCP_LISTEN_ACK_MS + DISCOVER_SLACK_MS;

export type McpEngineClientService = {
  /** Discover the server `target` names, from the rows the host keeps for it. */
  readonly discover: (
    target: McpEngineTarget,
    prior: PriorRows,
    hooks?: Pick<McpEngineHooks, "onDeprecated">,
  ) => Effect.Effect<McpEngineDiscoverResult, McpEngineUnreachable>;
  /**
   * Send `request` to the server `target` names, from the rows the host keeps for it, with the caller's `hooks`: a
   * caller's call runs inside the caller's invocation, so its stubs live as long as the call. No timeout of the
   * host's own: the engine bounds the call by its `timeout`, which progress resets, and `untilAborted` cuts it.
   */
  readonly request: (
    target: McpEngineTarget,
    prior: PriorRows,
    request: McpEngineRequest,
    hooks: McpEngineHooks,
  ) => Effect.Effect<McpEngineRequestResult, McpEngineUnreachable>;
  /**
   * Open a listen on the server `target` names, from the rows the host keeps for it (`docs/architecture/mcp-connections.md`
   * → Requests and Legacy sessions → Listens). It answers once the server acknowledged: what it honors, and the events as
   * a stream of lines. `stop` is the stream the host closes to end the listen at once. The call passes the engine no hook
   * of the caller's: a listen outlives the invocation that opened it, and a function stub does not (#409 answer 2).
   */
  readonly listen: (
    target: McpEngineTarget,
    prior: PriorRows,
    filter: McpListenFilter,
    stop?: ReadableStream<Uint8Array>,
  ) => Effect.Effect<McpEngineListenResult, McpEngineUnreachable>;
};

/** The engine, as the host sees it: `McpEngine` over the `MCP_ENGINE` binding, or a fake. */
export class McpEngineClient extends Context.Service<McpEngineClient, McpEngineClientService>()(
  "@cloudpid/server/mcp/engine/McpEngineClient",
) {}

const encodeTarget = Schema.encodeEffect(McpEngineTarget);

const decodeDiscovered = Schema.decodeUnknownEffect(McpEngineDiscoverResult);

const encodeRequest = Schema.encodeEffect(McpEngineRequest);

const decodeRequested = Schema.decodeUnknownEffect(McpEngineRequestResult);

const encodeFilter = Schema.encodeEffect(McpListenFilter);

const decodeListened = Schema.decodeUnknownEffect(McpEngineListenResult);

const unreachable = (message: string) => McpEngineUnreachable.make({ message });

/** The engine over `engine`, the `MCP_ENGINE` binding's stub or a fake that answers as one. */
export const mcpEngineClient = (
  engine: Pick<McpEngineMethods, "discover" | "request" | "listen">,
): McpEngineClientService => ({
  listen: (target, prior, filter, stop) =>
    Effect.gen(function* () {
      const encoded = yield* Effect.all([encodeTarget(target), encodeFilter(filter)]).pipe(
        Effect.mapError(() => unreachable("The listen could not be encoded")),
      );

      const answer = yield* Effect.tryPromise({
        try: () => engine.listen(encoded[0], prior, encoded[1], {}, stop),
        catch: (error) =>
          unreachable(
            `The MCP engine could not be reached: ${error instanceof Error ? error.message : "no answer"}`,
          ),
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(LISTEN_TIMEOUT_MS),
          orElse: () => Effect.fail(unreachable("The MCP engine did not answer in time")),
        }),
      );

      return yield* decodeListened(answer).pipe(
        Effect.mapError(() =>
          unreachable("The MCP engine answered with something this build cannot read"),
        ),
      );
    }),
  request: (target, prior, request, hooks) =>
    Effect.gen(function* () {
      const encoded = yield* Effect.all([encodeTarget(target), encodeRequest(request)]).pipe(
        Effect.mapError(() => unreachable("The request could not be encoded")),
      );

      const answer = yield* Effect.tryPromise({
        try: () => engine.request(encoded[0], prior, encoded[1], hooks),
        catch: (error) =>
          unreachable(
            `The MCP engine could not be reached: ${error instanceof Error ? error.message : "no answer"}`,
          ),
      });

      return yield* decodeRequested(answer).pipe(
        Effect.mapError(() =>
          unreachable("The MCP engine answered with something this build cannot read"),
        ),
      );
    }),
  discover: (target, prior, hooks = {}) =>
    Effect.gen(function* () {
      const encoded = yield* encodeTarget(target).pipe(
        Effect.mapError(() => unreachable("The server's target could not be encoded")),
      );

      const answer = yield* Effect.tryPromise({
        try: () => engine.discover(encoded, prior, hooks),
        catch: (error) =>
          unreachable(
            `The MCP engine could not be reached: ${error instanceof Error ? error.message : "no answer"}`,
          ),
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(DISCOVER_TIMEOUT_MS),
          orElse: () => Effect.fail(unreachable("The MCP engine did not answer in time")),
        }),
      );

      return yield* decodeDiscovered(answer).pipe(
        Effect.mapError(() =>
          unreachable("The MCP engine answered with something this build cannot read"),
        ),
      );
    }),
});
