// The host's load caps (`docs/architecture/mcp-connections.md` → The engine → Load caps): what bounds the work it has
// in flight, kept in its runtime for the object's life and taken by discovery and `request` alike.
//
// - **Requests in flight:** at most 8 per server (`conn`) and 32 per host object; over a cap a request waits, first
//   come first served (the wait counts toward its timeout, which is the caller's).
// - **The engine queue:** at most 5 engine calls in flight per host object. Background work takes at most 3 of them,
//   and when a slot frees, a call waiting is served before any background work waiting.
//
// They compose in one order, server then host then engine queue, so no holder of a later slot ever waits for an
// earlier one: a request takes its server's slot, then the host's, then an engine slot for its engine call.
// @effect-diagnostics missingPipeableSignature:off -- the caps' operations, not combinators.
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

/** At most 8 requests in flight per HTTP server. */
export const MAX_IN_FLIGHT_PER_SERVER = 8;

/** At most 32 requests in flight per host object. */
export const MAX_IN_FLIGHT_PER_HOST = 32;

/** At most 5 engine calls in flight per host object. */
export const MAX_ENGINE_CALLS = 5;

/** Background work takes at most 3 of the engine queue's slots. */
export const MAX_BACKGROUND_ENGINE_CALLS = 3;

/** An engine call for a caller (`request`), or the host's own background work (discovery, refreshes). */
export type EngineCallKind = "call" | "background";

export type McpLoadCapsService = {
  /** Run `effect` as one request in flight on `conn`, within its server's cap and the host's. */
  readonly inFlight: <A, E, R>(
    conn: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** Run `effect`, one engine call of `kind`, within the engine queue. */
  readonly engineCall: <A, E, R>(
    kind: EngineCallKind,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** The engine calls in flight, by kind. */
  readonly engineCalls: () => { readonly call: number; readonly background: number };
};

/** The engine queue: the calls in flight by kind, and those waiting, calls apart from background work. */
const engineQueue = () => {
  const running = { call: 0, background: 0 };

  const waiting: Record<EngineCallKind, Array<Deferred.Deferred<void>>> = {
    call: [],
    background: [],
  };

  const total = () => running.call + running.background;

  const fits = (kind: EngineCallKind) =>
    total() < MAX_ENGINE_CALLS &&
    (kind === "call" || running.background < MAX_BACKGROUND_ENGINE_CALLS);

  /** Hand the free slots out: to calls waiting first, then to background work within its share. */
  const dispatch = () => {
    for (const kind of ["call", "background"] as const) {
      while (waiting[kind].length > 0 && fits(kind)) {
        const next = waiting[kind].shift();

        if (next !== undefined) {
          running[kind] += 1;
          Deferred.doneUnsafe(next, Exit.void);
        }
      }
    }
  };

  const release = (kind: EngineCallKind) =>
    Effect.sync(() => {
      running[kind] -= 1;
      dispatch();
    });

  /** Take a slot, or wait for one; a waiter interrupted once given its slot gives it back. */
  const acquire = (kind: EngineCallKind) =>
    Effect.suspend(() => {
      const ahead = kind === "call" ? waiting.call : [...waiting.call, ...waiting.background];

      if (ahead.length === 0 && fits(kind)) {
        running[kind] += 1;

        return Effect.void;
      }

      const slot = Deferred.makeUnsafe<void>();

      waiting[kind].push(slot);

      return Deferred.await(slot).pipe(
        Effect.onInterrupt(() =>
          Effect.suspend(() => {
            const index = waiting[kind].indexOf(slot);

            if (index >= 0) {
              waiting[kind].splice(index, 1);

              return Effect.void;
            }

            return release(kind);
          }),
        ),
      );
    });

  return {
    run: <A, E, R>(kind: EngineCallKind, effect: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.andThen(
          restore(acquire(kind)),
          restore(effect).pipe(Effect.ensuring(release(kind))),
        ),
      ),
    counts: () => ({ ...running }),
  };
};

/** A fresh set of load caps, for one host object. */
export const makeLoadCaps = (): McpLoadCapsService => {
  const host = Semaphore.makeUnsafe(MAX_IN_FLIGHT_PER_HOST);
  const servers = new Map<string, Semaphore.Semaphore>();
  const queue = engineQueue();

  const serverSlots = (conn: string) => {
    const known = servers.get(conn);

    if (known !== undefined) return known;

    const made = Semaphore.makeUnsafe(MAX_IN_FLIGHT_PER_SERVER);

    servers.set(conn, made);

    return made;
  };

  return {
    inFlight: (conn, effect) =>
      Semaphore.withPermit(serverSlots(conn), Semaphore.withPermit(host, effect)),
    engineCall: (kind, effect) => queue.run(kind, effect),
    engineCalls: queue.counts,
  };
};

/** The host's load caps. Internal to the host. */
export class McpLoadCaps extends Context.Service<McpLoadCaps, McpLoadCapsService>()(
  "@cloudpid/server/mcp/limits/McpLoadCaps",
) {
  static readonly layer = Layer.sync(McpLoadCaps, makeLoadCaps);
}
