// The host's keep-alive (`docs/architecture/mcp-connections.md` → The host object): the object's alarm, held about 30 s
// ahead while a bounded unit of background work runs, so idle eviction (70–140 s with no incoming request or event) does
// not cut it. An outgoing RPC that is pending does not hold the object (#555): an alarm's firing is an incoming event,
// which does. Each `hold` counts; the alarm is armed when the count leaves 0, armed again at each firing while it is above
// 0, and cleared when it comes back to 0. An alarm that fires with nothing held (a fresh instance's, after an eviction or a
// deploy) does nothing, so an idle Environment never wakes and is never billed for one.
//
// It owns the object's one alarm: nothing else of `McpHost`'s arms it. Only discoveries hold it for now.
// @effect-diagnostics missingPipeableSignature:off -- the service's operations, not combinators.
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

/** An alarm that is never set, for a host with no object of its own (a test's runtime over storage of its own). */
export const NO_ALARM: KeepAliveAlarm = {
  setAlarm: () => Promise.resolve(),
  deleteAlarm: () => Promise.resolve(),
};

export type McpKeepAliveService = {
  /** `work`, with the object held in memory while it runs, however it ends. */
  readonly hold: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** What the object's alarm does: arm itself again while any work is held, and nothing otherwise. */
  readonly alarm: Effect.Effect<void>;
};

/** The host's keep-alive, over its object's alarm. Internal to the host. */
export class McpKeepAlive extends Context.Service<McpKeepAlive, McpKeepAliveService>()(
  "@cloudpid/server/mcp/keep-alive/McpKeepAlive",
) {
  /** The keep-alive over `alarm`, armed `intervalMs` ahead. */
  static readonly layer = (alarm: KeepAliveAlarm, intervalMs = KEEP_ALIVE_MS) =>
    Layer.sync(McpKeepAlive, () => {
      let held = 0;

      // The storage is asked at once, so its calls keep the order the count moved in, and the work does not wait for the
      // answer: a discovery's first steps stay where they were. A refused alarm (a replaced instance's storage) costs only
      // the keep-alive: the work goes on, and fails nothing.
      const attempt = (what: string, operation: () => Promise<void>) =>
        Effect.asVoid(
          Effect.forkDetach(
            Effect.tryPromise(operation).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(`The MCP host's keep-alive alarm was not ${what}`, cause),
              ),
            ),
            { startImmediately: true },
          ),
        );

      const arm = Effect.flatMap(Clock.currentTimeMillis, (now) =>
        attempt("armed", () => alarm.setAlarm(now + intervalMs)),
      );

      const disarm = attempt("cleared", () => alarm.deleteAlarm());

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
        alarm: Effect.suspend(() => (held > 0 ? arm : Effect.void)),
      };
    });
}
