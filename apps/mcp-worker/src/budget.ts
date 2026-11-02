/**
 * The engine's byte budget, one per isolate (`docs/architecture/mcp-connections.md` → The engine, Memory; #382 D9.1):
 * 24 MiB of counted bytes in flight, as an 8 MiB pool shared by calls of up to 4 MiB and one large slot for a call
 * whose bytes pass 4 MiB (up to 16 MiB, past which the core's byte limits fail the request).
 *
 * Each call takes a `Lease`, and its `fetch` is metered against it: every chunk of a response to a POST is charged
 * before the core reads it, so a call that must wait stops reading, which is backpressure on the server. A call
 * keeps what it was charged until it ends, since its bytes live on as the parsed and serialized result. A call that
 * passes 4 MiB moves from the pool to the large slot, and a call in the large slot is charged nothing more. A GET
 * stream is not charged: it lives only as long as its call, and its events are capped by the core.
 *
 * - **No hold-and-wait:** a call that must wait gives back all it holds and waits, first in, first out, for its whole
 *   need at once (what it held plus the new chunk, or the large slot), so waiting calls never wait on each other. What
 *   a waiting call has read is not counted while it waits; it reads nothing more until it is let in.
 * - **Release is immediate:** it gives back what the call holds and drops its waiter, whatever the call's charges are
 *   doing, so an abort or a timeout frees the budget at once.
 * - **A large result's stream** holds the call's lease until it is read or cancelled, but at most `STREAM_HOLD_MS`:
 *   after that the lease is taken back by the next call that asks the budget, or by the timer of a call waiting on it,
 *   since an unread stream would otherwise hold its bytes for the isolate's lifetime.
 */
// @effect-diagnostics asyncFunction:off -- the meter is a `fetch` and a byte stream, Promise-based at their seams.
// @effect-diagnostics globalFetch:off -- it wraps the `fetch` it is given, and builds the `Response` the core reads.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, not combinators.
// @effect-diagnostics globalTimers:off -- a waiting call's own timer, in its own invocation, takes back expired leases.
// @effect-diagnostics globalDate:off -- a lease's expiry is wall-clock time, across invocations.
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { MiB } from "./units.ts";

/** A call's charges in the pool stop at this; past it the call takes the large slot. */
export const POOL_CALL_LIMIT = 4 * MiB;

/** The pool shared by calls of up to 4 MiB. */
export const POOL_BYTES = 8 * MiB;

/** How long a returned stream may hold its call's lease unread. */
export const STREAM_HOLD_MS = 60_000;

/** What one call holds of the budget. */
export interface Lease {
  /** Charges `bytes`, waiting until the budget has room; at once once the lease is released. */
  readonly charge: (bytes: number) => Promise<void>;
  /** Gives back all the call holds, and drops its waiter; once only. */
  readonly release: () => void;
  /** Releases the lease `ms` from now if nothing has by then: its call returned a stream that holds it. */
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

/** A call waiting for `permits`; `grant` runs synchronously as they are taken for it. */
interface Waiter {
  readonly permits: number;
  readonly grant: () => void;
}

/**
 * A FIFO semaphore over plain Promises. A release grants waiters synchronously: the calls of one isolate are separate
 * invocations, and a wake scheduled on a timer of the releasing call's invocation never runs once that invocation
 * ends, as it may as soon as its stream is read (which is why this is not Effect's `Semaphore`).
 */
class Permits {
  readonly #waiters: Array<Waiter> = [];

  #free: number;

  constructor(permits: number) {
    this.#free = permits;
  }

  /** Takes `permits` if no one waits and they are free. */
  tryTake(permits: number) {
    if (this.#waiters.length > 0 || this.#free < permits) {
      return false;
    }

    this.#free -= permits;

    return true;
  }

  wait(waiter: Waiter) {
    this.#waiters.push(waiter);
  }

  cancel(waiter: Waiter) {
    const index = this.#waiters.indexOf(waiter);

    if (index >= 0) {
      this.#waiters.splice(index, 1);
      // The waiters behind it may fit now.
      this.release(0);
    }
  }

  release(permits: number) {
    this.#free += permits;

    for (
      let next = this.#waiters[0];
      next !== undefined && next.permits <= this.#free;
      next = this.#waiters[0]
    ) {
      this.#waiters.shift();
      this.#free -= next.permits;
      next.grant();
    }
  }
}

export interface BudgetOptions {
  /** The wall clock, for leases' expiry. */
  readonly now?: () => number;
}

export const makeBudget = (options: BudgetOptions = {}): ByteBudgetApi => {
  const now = options.now ?? Date.now;
  const pool = new Permits(POOL_BYTES);
  const large = new Permits(1);
  /** Leases whose call has returned, by when they are released. */
  const expiring = new Map<() => void, number>();

  /** Releases every lease past its expiry; how long until the next one expires, if any does. */
  const reclaim = () => {
    const at = now();
    let next = Number.POSITIVE_INFINITY;

    for (const [release, expires] of expiring) {
      if (expires <= at) {
        release();
      } else {
        next = Math.min(next, expires - at);
      }
    }

    return next;
  };

  return {
    lease: () => {
      let pooled = 0;
      let inLarge = false;
      let released = false;

      let waiting:
        | { readonly permits: Permits; readonly waiter: Waiter; readonly done: () => void }
        | undefined;

      // A call's charges run one after another, so a move to the large slot never races a pool charge.
      let queue = Promise.resolve();

      /** Waits in `permits` for `need`, holding nothing, until granted or released. */
      const waitFor = (permits: Permits, need: number, granted: () => void) => {
        const done = Promise.withResolvers<void>();
        let timer: ReturnType<typeof setTimeout> | undefined;

        const settle = () => {
          clearTimeout(timer);
          waiting = undefined;
          done.resolve();
        };

        const waiter: Waiter = {
          permits: need,
          grant: () => {
            granted();
            settle();
          },
        };

        // While it waits, this call's own invocation is alive, so its timer runs: it takes back expired leases.
        const watch = () => {
          const next = reclaim();

          if (waiting?.waiter === waiter && Number.isFinite(next)) {
            timer = setTimeout(watch, next);
          }
        };

        waiting = { permits, waiter, done: settle };
        permits.wait(waiter);
        watch();

        return done.promise;
      };

      const chargeNow = async (bytes: number) => {
        reclaim();

        if (released || inLarge) {
          return;
        }

        if (pooled + bytes > POOL_CALL_LIMIT) {
          pool.release(pooled);
          pooled = 0;

          if (large.tryTake(1)) {
            inLarge = true;

            return;
          }

          await waitFor(large, 1, () => {
            inLarge = true;
          });

          return;
        }

        if (pool.tryTake(bytes)) {
          pooled += bytes;

          return;
        }

        const need = pooled + bytes;

        pool.release(pooled);
        pooled = 0;

        if (pool.tryTake(need)) {
          pooled = need;

          return;
        }

        await waitFor(pool, need, () => {
          pooled = need;
        });
      };

      const release = () => {
        if (released) {
          return;
        }

        released = true;
        expiring.delete(release);

        if (waiting !== undefined) {
          const { permits, waiter, done } = waiting;

          permits.cancel(waiter);
          done();
        }

        if (inLarge) {
          inLarge = false;
          large.release(1);
        } else {
          pool.release(pooled);
          pooled = 0;
        }
      };

      return {
        charge: (bytes) => {
          const charged = queue.then(() => chargeNow(bytes));

          queue = charged.catch(() => undefined);

          return charged;
        },
        release,
        expireIn: (ms) => {
          if (!released) {
            expiring.set(release, now() + ms);
          }
        },
      };
    },
  };
};

/**
 * `fetch`, metered against `lease`: each chunk of a POST's response is charged before it is passed on, and a
 * `Content-Length` over 4 MiB takes the large slot before reading. `opened` is told when response headers arrive.
 */
export const meteredFetch =
  (fetch: typeof globalThis.fetch, lease: Lease, opened?: () => void): typeof globalThis.fetch =>
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

        await lease.charge(chunk.value.byteLength);
        controller.enqueue(chunk.value);
      },
      cancel: (reason) => reader.cancel(reason),
    });

    return new Response(body, response);
  };
