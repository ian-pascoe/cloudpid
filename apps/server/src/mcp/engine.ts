// `McpEngine` as the host calls it (`docs/architecture/mcp-connections.md` → The host object, The engine): over the
// `MCP_ENGINE` binding, or a scripted fake. Arguments cross encoded and results are decoded here, so an answer this
// build cannot read, an engine that cannot be reached and one that does not answer in time are one failure,
// `McpEngineUnreachable`, which the host reads as the server being unavailable for now.
//
// RPC carries no `AbortSignal`, so each call passes `untilAborted()`, which resolves once the host interrupts the call
// (a set change, a destroy): the engine then aborts the server request (#409 answer 2).
// @effect-diagnostics missingPipeableSignature:off -- the engine's methods, not combinators.
import {
  McpEngineDiscoverResult,
  type McpEngineMethods,
  McpEngineTarget,
} from "@cloudpid/mcp/types";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { PriorRows } from "./store.ts";

/**
 * The longest the host waits for a discovery: past the engine's own bounds (15 s to probe or initialize, 120 s to walk
 * a list), so only an engine that went silent reaches it.
 */
export const DISCOVER_TIMEOUT = Duration.seconds(180);

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

/** A promise that settles once `signal` aborts: the call's `untilAborted()`. */
const abortOf = (signal: AbortSignal): Promise<void> =>
  // @effect-diagnostics-next-line newPromise:off -- a native callback for the engine to await over RPC, not an effect.
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });

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
        try: (signal) => {
          const aborted = abortOf(signal);

          return engine.discover(encoded, prior, { untilAborted: () => aborted });
        },
        catch: (error) =>
          unreachable(
            `The MCP engine could not be reached: ${error instanceof Error ? error.message : "no answer"}`,
          ),
      }).pipe(
        Effect.timeoutOrElse({
          duration: DISCOVER_TIMEOUT,
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
