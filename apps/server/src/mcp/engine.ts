// `McpEngine` as the host calls it (`docs/architecture/mcp-connections.md` → The host object, The engine): over the
// `MCP_ENGINE` binding, or a scripted fake. Arguments cross encoded and results are decoded here, so an answer this
// build cannot read, an engine that cannot be reached and one that does not answer in time are one failure,
// `McpEngineUnreachable`, which the host reads as the server being unavailable for now.
//
// A discovery passes the engine no hooks: it runs as a fiber in the host's runtime, often past the invocation that
// started it, and a function stub lives only as long as the invocation that made it (#409 answer 2), so an
// `untilAborted()` would cut it about 72 s later. The RPC itself is the object's own pending I/O, which keeps the object
// in memory for up to 15 minutes (Cloudflare's Durable Object lifecycle, "Pending operations prevent eviction"), and
// the engine runs the discovery to its own bounds. That keep-alive is the documented behaviour, not yet verified on a
// deployed stage: #409's 72 s also falls inside the 70-140 s idle eviction, so a deployed test still has to hold one
// background discovery past 150 s with no request reaching the host and see it stored.
//
// A discovery the host interrupts (a set change, a reload, a destroy) is dropped here, unread: it runs nothing on the
// server, so the engine finishing it costs only its own time, except that an interrupted Legacy discovery leaves the
// `Mcp-Session-Id` it opened on the server until the server expires it.
// @effect-diagnostics missingPipeableSignature:off -- the engine's methods, not combinators.
import {
  MCP_CONNECT_TIMEOUT_MS,
  MCP_LIST_WALK_TIMEOUT_MS,
  McpEngineDiscoverResult,
  type McpEngineMethods,
  McpEngineTarget,
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

export type McpEngineClientService = {
  /** Discover the server `target` names, from the rows the host keeps for it. */
  readonly discover: (
    target: McpEngineTarget,
    prior: PriorRows,
  ) => Effect.Effect<McpEngineDiscoverResult, McpEngineUnreachable>;
};

/** The engine, as the host sees it: `McpEngine` over the `MCP_ENGINE` binding, or a fake. */
export class McpEngineClient extends Context.Service<McpEngineClient, McpEngineClientService>()(
  "@cloudpid/server/mcp/engine/McpEngineClient",
) {}

const encodeTarget = Schema.encodeEffect(McpEngineTarget);

const decodeDiscovered = Schema.decodeUnknownEffect(McpEngineDiscoverResult);

const unreachable = (message: string) => McpEngineUnreachable.make({ message });

/** The engine over `engine`, the `MCP_ENGINE` binding's stub or a fake that answers as one. */
export const mcpEngineClient = (
  engine: Pick<McpEngineMethods, "discover">,
): McpEngineClientService => ({
  discover: (target, prior) =>
    Effect.gen(function* () {
      const encoded = yield* encodeTarget(target).pipe(
        Effect.mapError(() => unreachable("The server's target could not be encoded")),
      );

      const answer = yield* Effect.tryPromise({
        try: () => engine.discover(encoded, prior, {}),
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
