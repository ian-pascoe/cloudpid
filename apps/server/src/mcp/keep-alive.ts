// The host's keep-alive (`docs/architecture/mcp-connections.md` → The host object): the object's alarm, held about 30 s
// ahead while a bounded unit of background work runs, so idle eviction (70–140 s with no incoming request or event) does
// not cut it. An outgoing RPC that is pending does not hold the object (#555): an alarm's firing is an incoming event,
// which does. Each `hold` counts; the alarm is armed when the count leaves 0, armed again at each firing while it is above
// 0, and cleared when it comes back to 0. An alarm that fires with nothing held (a fresh instance's, after an eviction or a
// deploy) does nothing, so an idle Environment never wakes and is never billed for one.
//
// It owns the object's one alarm: nothing else of `McpHost`'s arms it. Only discoveries hold it for now.
// @effect-diagnostics missingPipeableSignature:off -- the service's operations, not combinators.
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SECOND_MS } from "./time.ts";

/** How far ahead the alarm is armed: well under the 70 s idle-eviction floor. */
export const KEEP_ALIVE_MS = 30 * SECOND_MS;

/** The object's alarm, as the keep-alive arms and clears it: its Durable Object storage's. */
export type KeepAliveAlarm = {
  readonly setAlarm: (scheduledTime: number) => Promise<void>;
  readonly deleteAlarm: () => Promise<void>;
};

export type McpKeepAliveService = {
  /** `work`, with the object held in memory while it runs, however it ends. */
  readonly hold: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * What the object's alarm does: arm itself again while any work is held, and nothing otherwise. A re-arm the storage
   * refuses fails it, so the platform retries the alarm rather than let the chain end while work is held.
   */
  readonly alarm: Effect.Effect<void, Cause.UnknownError>;
};

/** The host's keep-alive, over its object's alarm. Internal to the host. */
export class McpKeepAlive extends Context.Service<McpKeepAlive, McpKeepAliveService>()(
  "@cloudpid/server/mcp/keep-alive/McpKeepAlive",
) {
  /** The keep-alive over `alarm`, armed `KEEP_ALIVE_MS` ahead. */
  static readonly layer = (alarm: KeepAliveAlarm) =>
    Layer.sync(McpKeepAlive, () => {
      let held = 0;

      const setAlarm = Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.tryPromise(() => alarm.setAlarm(now + KEEP_ALIVE_MS)),
      );

      // At a hold or a release the storage is asked at once, so its calls keep the order the count moved in, and the
      // work does not wait for the answer: a discovery's first steps stay where they were. A refusal (a replaced
      // instance's storage) costs only the keep-alive: the work goes on, and fails nothing.
      const inBackground = (what: string, operation: Effect.Effect<void, Cause.UnknownError>) =>
        Effect.asVoid(
          Effect.forkDetach(
            operation.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(`The MCP host's keep-alive alarm was not ${what}`, cause),
              ),
            ),
            { startImmediately: true },
          ),
        );

      const arm = inBackground("armed", setAlarm);

      const disarm = inBackground(
        "cleared",
        Effect.tryPromise(() => alarm.deleteAlarm()),
      );

      return {
        hold: (work) =>
          Effect.acquireUseRelease(
            Effect.suspend(() => {
              held += 1;

              return held === 1 ? arm : Effect.void;
            }),
            () => work,
            () =>
              Effect.suspend(() => {
                held -= 1;

                return held === 0 ? disarm : Effect.void;
              }),
          ),
        alarm: Effect.suspend(() => (held > 0 ? setAlarm : Effect.void)),
      };
    });
}
