// The host's load caps (`docs/architecture/mcp-connections.md` → The engine → Load caps): what bounds the work it has
// in flight, kept in its runtime for the object's life and taken by discovery and `request` alike.
//
// - **Requests in flight:** at most 8 per HTTP server (`conn`), 4 per stdio server and Workspace (one child in one
//   Container serves them all), and 32 per host object; over a cap a request waits, first come first served (the wait
//   counts toward its timeout, which is the caller's).
// - **The engine queue:** at most 5 engine calls in flight per host object. Background work takes at most 3 of them,
//   and when a slot frees, a call waiting is served before any background work waiting.
//
// They compose in one order, server then host then engine queue, so no holder of a later slot ever waits for an
// earlier one: a request takes its server's slot, then the host's, then an engine slot for its engine call.
//
// Each is a `slotPool`, not an Effect `Semaphore`: a freed slot goes straight to the oldest waiter of the first class
// waiting, and a newcomer never takes a slot while anyone of its class or a class before it waits.
// @effect-diagnostics missingPipeableSignature:off -- the caps' operations, not combinators.
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

/** At most 8 requests in flight per HTTP server. */
export const MAX_IN_FLIGHT_PER_SERVER = 8;

/** At most 4 requests in flight per stdio server and Workspace. */
export const MAX_IN_FLIGHT_PER_STDIO_SERVER = 4;

/** At most 32 requests in flight per host object. */
export const MAX_IN_FLIGHT_PER_HOST = 32;

/** At most 5 engine calls in flight per host object. */
export const MAX_ENGINE_CALLS = 5;

/** Background work takes at most 3 of the engine queue's slots. */
export const MAX_BACKGROUND_ENGINE_CALLS = 3;

/** An engine call for a caller (`request`), or the host's own background work (discovery, refreshes). */
export type EngineCallKind = "call" | "background";

export type McpLoadCapsService = {
  /**
   * Run `effect` as one request in flight on `conn`, within its server's cap and the host's. A stdio server's cap is
   * its own in each Workspace it runs in: pass the `workspace`.
   */
  readonly inFlight: <A, E, R>(
    conn: string,
    effect: Effect.Effect<A, E, R>,
    workspace?: string,
  ) => Effect.Effect<A, E, R>;
  /** Run `effect`, one engine call of `kind`, within the engine queue. */
  readonly engineCall: <A, E, R>(
    kind: EngineCallKind,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  /** The engine calls in flight, by kind. */
  readonly engineCalls: () => { readonly call: number; readonly background: number };
  /** The servers whose cap is held now: any with a request in flight or waiting. */
  readonly serversHeld: () => number;
};

/** A pool of slots: what runs and waits per class, and whether one more of a class fits. */
type SlotPool<K extends string> = {
  /** Run `effect` in a slot of `kind`, waiting first come first served for one. */
  readonly run: <A, E, R>(kind: K, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** The slots of `kind` held now. */
  readonly count: (kind: K) => number;
};

/**
 * A pool of slots handed out by class, `classes` in the order they are served: a freed slot goes to the oldest waiter
 * of the first class with one that `fits`, and a newcomer takes a slot at once only when no one of its class or of a
 * class before it waits. A waiter is queued where nothing can interrupt it, and only its wait is interruptible: one
 * interrupted while it waits leaves the queue, and one interrupted once given its slot gives it back.
 */
const slotPool = <K extends string>(
  classes: ReadonlyArray<K>,
  fits: (count: (kind: K) => number, kind: K) => boolean,
): SlotPool<K> => {
  const running = new Map<K, number>();
  const waiting = new Map<K, Array<Deferred.Deferred<void>>>();

  const count = (kind: K) => running.get(kind) ?? 0;

  const queueOf = (kind: K) => {
    const queue = waiting.get(kind) ?? [];

    waiting.set(kind, queue);

    return queue;
  };

  const take = (kind: K) => running.set(kind, count(kind) + 1);

  const dispatch = () => {
    for (const kind of classes) {
      const queue = queueOf(kind);

      while (queue.length > 0 && fits(count, kind)) {
        const next = queue.shift();

        if (next !== undefined) {
          take(kind);
          Deferred.doneUnsafe(next, Exit.void);
        }
      }
    }
  };

  const release = (kind: K) =>
    Effect.sync(() => {
      running.set(kind, count(kind) - 1);
      dispatch();
    });

  /** No one of `kind`'s class, or of a class served before it, waits. */
  const noneAhead = (kind: K) =>
    Arr.every(Arr.take(classes, classes.indexOf(kind) + 1), (each) => queueOf(each).length === 0);

  /** Leave the queue; a waiter already given its slot gives it back. */
  const cancel = (kind: K, slot: Deferred.Deferred<void>) =>
    Effect.suspend(() => {
      const queue = queueOf(kind);
      const index = queue.indexOf(slot);

      if (index < 0) return release(kind);

      queue.splice(index, 1);

      return Effect.void;
    });

  return {
    run: (kind, effect) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          const inSlot = restore(effect).pipe(Effect.ensuring(release(kind)));

          if (noneAhead(kind) && fits(count, kind)) {
            take(kind);

            return inSlot;
          }

          const slot = Deferred.makeUnsafe<void>();

          queueOf(kind).push(slot);

          return restore(Deferred.await(slot)).pipe(
            Effect.onInterrupt(() => cancel(kind, slot)),
            Effect.andThen(inSlot),
          );
        }),
      ),
    count,
  };
};

/** A cap of `max` slots of one class, first come first served. */
const cap = (max: number) => slotPool(["held"] as const, (count) => count("held") < max);

/** A fresh set of load caps, for one host object. */
export const makeLoadCaps = (): McpLoadCapsService => {
  const host = cap(MAX_IN_FLIGHT_PER_HOST);

  const engine = slotPool(
    ["call", "background"] as const,
    (count, kind) =>
      count("call") + count("background") < MAX_ENGINE_CALLS &&
      (kind === "call" || count("background") < MAX_BACKGROUND_ENGINE_CALLS),
  );

  // A server's cap lives while a request holds or waits for it, so a server that left the set leaves nothing behind.
  const servers = new Map<string, { readonly pool: ReturnType<typeof cap>; users: number }>();

  const serverCap = (key: string, max: number) => {
    const held = servers.get(key) ?? { pool: cap(max), users: 0 };

    servers.set(key, held);
    held.users += 1;

    return held;
  };

  const leave = (key: string, held: { users: number }) =>
    Effect.sync(() => {
      held.users -= 1;

      if (held.users === 0) servers.delete(key);
    });

  return {
    inFlight: (conn, effect, workspace) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          // A `conn` is a hash: it holds no NUL, so the key tells a server from a server in a Workspace.
          const key = workspace === undefined ? conn : `${conn}\0${workspace}`;

          const held = serverCap(
            key,
            workspace === undefined ? MAX_IN_FLIGHT_PER_SERVER : MAX_IN_FLIGHT_PER_STDIO_SERVER,
          );

          return restore(held.pool.run("held", host.run("held", effect))).pipe(
            Effect.ensuring(leave(key, held)),
          );
        }),
      ),
    engineCall: (kind, effect) => engine.run(kind, effect),
    engineCalls: () => ({ call: engine.count("call"), background: engine.count("background") }),
    serversHeld: () => servers.size,
  };
};

/** The host's load caps. Internal to the host. */
export class McpLoadCaps extends Context.Service<McpLoadCaps, McpLoadCapsService>()(
  "@cloudpid/server/mcp/limits/McpLoadCaps",
) {
  static readonly layer = Layer.sync(McpLoadCaps, makeLoadCaps);
}
