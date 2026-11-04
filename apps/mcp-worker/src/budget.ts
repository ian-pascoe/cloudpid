/**
 * The engine's byte budget, one per isolate (`docs/architecture/mcp-connections.md` → The engine, Memory; #382 D9.1):
 * an 8 MiB pool shared by calls of up to 4 MiB and one large slot for a call whose bytes pass 4 MiB (up to 16 MiB,
 * past which the core's byte limits fail the request).
 *
 * Each call takes a `Lease`, and its `fetch` is metered against it: every chunk of a response to a POST is charged
 * before the core reads it, so a call that must wait stops reading, which is backpressure on the server. A call
 * keeps what it was charged until it ends, since its bytes live on as the parsed and serialized result; a call that
 * waits keeps what it holds counted. A call that passes 4 MiB moves to the large slot, keeping its pool bytes until it
 * gets the slot, and a call in the large slot is charged nothing more. A GET stream is not charged: it lives only as
 * long as its call, and its events are capped by the core.
 *
 * - **Deadlock:** calls that hold pool bytes and wait for more can wait on each other. When the oldest waiter would not
 *   fit even were every holder not waiting for the pool to give back all it holds, only a waiter could make room, and
 *   none will: so it is let in over budget, and every later charge of its own is too, until it ends or moves to the
 *   large slot; one call at a time, so the pool overshoots by at most 4 MiB. While the holders still running hold
 *   enough for it, nobody overshoots; a running call holding a few bytes (a slow tool's open response) holds nobody
 *   up (#613). The large slot needs no such rule: its holder is charged nothing more, so it never waits.
 * - **Release is immediate:** it gives back what the call holds and drops its waiter, whatever the call's charges are
 *   doing, so an abort or a timeout frees the budget at once.
 * - **A returned stream** holds its call's lease until it is read or cancelled, but expires once it has gone unread
 *   for `STREAM_HOLD_MS` (each pull renews it): the next call that asks the budget takes it back, or the timer of a
 *   call waiting on the budget, which checks again at least every `STREAM_HOLD_MS` while it waits.
 */
// @effect-diagnostics asyncFunction:off -- the meter is a `fetch` and a byte stream, Promise-based at their seams.
// @effect-diagnostics globalFetch:off -- it wraps the `fetch` it is given, and builds the `Response` the core reads.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, not combinators.
// @effect-diagnostics globalTimers:off -- a waiting call's own timer, in its own invocation, takes back expired leases.
// @effect-diagnostics globalDate:off -- a lease's expiry is wall-clock time, across invocations.
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { MCP_STREAM_HOLD_MS } from "@cloudpid/mcp/types";
import { MiB } from "./units.ts";

/** A call's charges in the pool stop at this; past it the call takes the large slot. */
export const POOL_CALL_LIMIT = 4 * MiB;

/** The pool shared by calls of up to 4 MiB. */
export const POOL_BYTES = 8 * MiB;

/** How long a returned stream may go unread and still hold its call's lease. */
export const STREAM_HOLD_MS = MCP_STREAM_HOLD_MS;

/** What one call holds of the budget. */
export interface Lease {
  /** Charges `bytes`, waiting until the budget has room; at once once the lease is released. */
  readonly charge: (bytes: number) => Promise<void>;
  /** Gives back all the call holds, and drops its waiter; once only. */
  readonly release: () => void;
  /** Releases the lease `ms` from now, unless renewed or released by then: a returned stream holds it. */
  readonly expireIn: (ms: number) => void;
}

export interface ByteBudgetApi {
  /** A new lease for one call, holding nothing. */
  readonly lease: () => Lease;
}

export class ByteBudget extends Context.Service<ByteBudget, ByteBudgetApi>()(
  "@cloudpid/mcp-worker/budget/ByteBudget",
) {
  /** The isolate's budget: the 8 MiB pool and the one large slot. */
  static readonly layer = Layer.sync(ByteBudget, () => makeBudget());
}

export interface BudgetOptions {
  /** The wall clock, for leases' expiry. */
  readonly now?: () => number;
  /** How often, at most, a waiting call checks for expired leases (`STREAM_HOLD_MS`). */
  readonly recheckMs?: number;
}

/** What a waiting call waits for: pool bytes, or the large slot. */
interface Wait {
  readonly on: "pool" | "large";
  readonly need: number;
  readonly done: () => void;
}

/** One lease's holdings. */
interface Holding {
  pooled: number;
  inLarge: boolean;
  released: boolean;
  waiting: Wait | undefined;
}

/**
 * A budget over plain Promises. A release lets waiters in synchronously: the calls of one isolate are separate
 * invocations, and a wake scheduled on a timer of the releasing call's invocation never runs once that invocation
 * ends, as it may as soon as its stream is read (which is why this is not Effect's `Semaphore`).
 */
export const makeBudget = (options: BudgetOptions = {}): ByteBudgetApi => {
  const now = options.now ?? Date.now;
  const recheckMs = options.recheckMs ?? STREAM_HOLD_MS;
  const live = new Set<Holding>();
  const poolWaiters: Array<Holding> = [];
  const largeWaiters: Array<Holding> = [];
  /** Leases a returned stream holds, by when they expire. */
  const expiring = new Map<Holding, number>();
  let poolFree = POOL_BYTES;
  let largeHolder: Holding | undefined;
  /** The one call let in over budget to break a deadlock, until it leaves the pool. */
  let overBudget: Holding | undefined;

  const settle = (holding: Holding) => {
    const wait = holding.waiting;

    holding.waiting = undefined;
    wait?.done();
  };

  const leavePool = (holding: Holding) => {
    poolFree += holding.pooled;
    holding.pooled = 0;

    if (overBudget === holding) {
      overBudget = undefined;
    }
  };

  const takePool = (holding: Holding, bytes: number) => {
    poolFree -= bytes;
    holding.pooled += bytes;
  };

  const enterLarge = (holding: Holding) => {
    largeHolder = holding;
    holding.inLarge = true;
    leavePool(holding);
  };

  /**
   * Waiting for the pool cannot let `oldest` in: even were every holder not itself waiting for the pool to give back
   * all it holds, `oldest` would not fit, and the calls that wait keep what they hold.
   */
  const deadlocked = (oldest: Wait) => {
    let freeable = poolFree;

    for (const holding of live) {
      if (holding.waiting?.on !== "pool") {
        freeable += holding.pooled;
      }
    }

    return freeable < oldest.need;
  };

  /** Lets waiters in, first in first out, while they fit; then breaks a deadlock. */
  const drain = () => {
    const nextLarge = largeWaiters[0];

    if (largeHolder === undefined && nextLarge !== undefined) {
      largeWaiters.shift();
      enterLarge(nextLarge);
      settle(nextLarge);
    }

    for (
      let next = poolWaiters[0];
      next?.waiting !== undefined && next.waiting.need <= poolFree;
      next = poolWaiters[0]
    ) {
      poolWaiters.shift();
      takePool(next, next.waiting.need);
      settle(next);
    }

    const oldest = poolWaiters[0];

    if (overBudget === undefined && oldest?.waiting !== undefined && deadlocked(oldest.waiting)) {
      poolWaiters.shift();
      overBudget = oldest;
      takePool(oldest, oldest.waiting.need);
      settle(oldest);
    }
  };

  const release = (holding: Holding) => {
    if (holding.released) {
      return;
    }

    holding.released = true;
    live.delete(holding);
    expiring.delete(holding);

    for (const queue of [poolWaiters, largeWaiters]) {
      const index = queue.indexOf(holding);

      if (index >= 0) {
        queue.splice(index, 1);
      }
    }

    settle(holding);

    if (largeHolder === holding) {
      largeHolder = undefined;
      holding.inLarge = false;
    }

    leavePool(holding);
    drain();
  };

  /** Releases every lease past its expiry; how long until the next one expires, if any does. */
  const reclaim = () => {
    const at = now();
    let next = Number.POSITIVE_INFINITY;

    for (const [holding, expires] of expiring) {
      if (expires <= at) {
        release(holding);
      } else {
        next = Math.min(next, expires - at);
      }
    }

    return next;
  };

  /** Queues `holding` for `need`, holding what it holds, until it is let in or released. */
  const waitFor = (holding: Holding, on: Wait["on"], need: number) => {
    const done = Promise.withResolvers<void>();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const wait: Wait = {
      on,
      need,
      done: () => {
        // This may run in another call's invocation, where clearing this call's timer does nothing; harmless, since
        // `watch` checks the wait is still current before it arms again.
        clearTimeout(timer);
        done.resolve();
      },
    };

    // While it waits, this call's own invocation is alive, so its timer runs: it takes back expired leases, checking
    // at least every `recheckMs`, since a holder may start expiring after this call began to wait.
    const watch = () => {
      const next = reclaim();

      if (holding.waiting === wait) {
        timer = setTimeout(watch, Math.min(next, recheckMs));
      }
    };

    holding.waiting = wait;
    (on === "pool" ? poolWaiters : largeWaiters).push(holding);
    drain();
    watch();

    return done.promise;
  };

  const chargeNow = async (holding: Holding, bytes: number) => {
    reclaim();

    if (holding.released || holding.inLarge) {
      return;
    }

    if (holding.pooled + bytes > POOL_CALL_LIMIT) {
      if (largeHolder === undefined && largeWaiters.length === 0) {
        enterLarge(holding);
        drain();

        return;
      }

      await waitFor(holding, "large", 1);

      return;
    }

    if (overBudget === holding || (poolWaiters.length === 0 && poolFree >= bytes)) {
      takePool(holding, bytes);

      return;
    }

    await waitFor(holding, "pool", bytes);
  };

  return {
    lease: () => {
      const holding: Holding = { pooled: 0, inLarge: false, released: false, waiting: undefined };

      live.add(holding);

      // A call's charges run one after another, so a move to the large slot never races a pool charge.
      let queue = Promise.resolve();

      return {
        charge: (bytes) => {
          const charged = queue.then(() => chargeNow(holding, bytes));

          queue = charged.catch(() => undefined);

          return charged;
        },
        release: () => release(holding),
        expireIn: (ms) => {
          if (!holding.released) {
            expiring.set(holding, now() + ms);
          }
        },
      };
    },
  };
};

/**
 * `fetch`, metered against `lease`: each chunk of a POST's response is charged before it is passed on, and a
 * `Content-Length` over 4 MiB takes the large slot before reading. `opened` is told when response headers arrive, and `counted` each chunk's bytes as it is read.
 */
export const meteredFetch =
  (
    fetch: typeof globalThis.fetch,
    lease: Lease,
    opened?: () => void,
    counted?: (bytes: number) => void,
  ): typeof globalThis.fetch =>
  async (input, init) => {
    const response = await fetch(input, init);

    opened?.();

    if (init?.method !== "POST" || response.body === null) {
      return response;
    }

    const length = Number(response.headers.get("content-length") ?? "0");

    if (length > POOL_CALL_LIMIT) {
      await lease.charge(length);
    }

    const reader = response.body.getReader();

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const chunk = await reader.read();

        if (chunk.done) {
          controller.close();

          return;
        }

        counted?.(chunk.value.byteLength);
        await lease.charge(chunk.value.byteLength);
        controller.enqueue(chunk.value);
      },
      cancel: (reason) => reader.cancel(reason),
    });

    return new Response(body, response);
  };
