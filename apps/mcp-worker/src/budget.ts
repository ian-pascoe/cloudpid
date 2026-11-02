/**
 * The engine's byte budget, one per isolate (`docs/architecture/mcp-connections.md` → The engine, Memory; #382 D9.1):
 * 24 MiB of counted bytes in flight, as an 8 MiB pool shared by calls of up to 4 MiB and one large slot for a call
 * whose bytes pass 4 MiB (up to 16 MiB, past which the core's byte limits fail the request).
 *
 * Each call takes a `Lease`, and its `fetch` is metered against it: every chunk of a response to a POST is charged
 * before the core reads it, so a call that must wait stops reading, which is backpressure on the server. A call
 * keeps what it was charged until it ends (for a large result, until its stream is read or cancelled), since its
 * bytes live on as the parsed and serialized result. A call that passes 4 MiB moves from the pool to the large slot
 * whole, and a call in the large slot is charged nothing more. A GET stream is not charged: it lives only as long as
 * its call, and its events are capped by the core.
 */
// @effect-diagnostics asyncFunction:off -- the meter is a `fetch` and a byte stream, Promise-based at their seams.
// @effect-diagnostics globalFetch:off -- it wraps the `fetch` it is given, and builds the `Response` the core reads.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over values, not combinators.
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

const MiB = 1024 * 1024;

/** A call's charges in the pool stop at this; past it the call takes the large slot. */
export const POOL_CALL_LIMIT = 4 * MiB;

/** The pool shared by calls of up to 4 MiB. */
export const POOL_BYTES = 8 * MiB;

/** What one call holds of the budget. */
export interface Lease {
  /** Charges `bytes`, waiting until the budget has room. */
  readonly charge: (bytes: number) => Promise<void>;
  /** Gives back all the call holds; once only. */
  readonly release: () => void;
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

/**
 * A FIFO semaphore over plain Promises. A release wakes waiters synchronously: the calls of one isolate are separate
 * invocations, and a wake scheduled on a timer of the releasing call's invocation never runs once that invocation
 * ends, as it may as soon as its stream is read (which is why this is not Effect's `Semaphore`).
 */
class Permits {
  readonly #waiters: Array<{ readonly permits: number; readonly wake: () => void }> = [];

  #free: number;

  constructor(permits: number) {
    this.#free = permits;
  }

  take(permits: number) {
    if (this.#waiters.length === 0 && this.#free >= permits) {
      this.#free -= permits;

      return Promise.resolve();
    }

    const taken = Promise.withResolvers<void>();

    this.#waiters.push({ permits, wake: taken.resolve });

    return taken.promise;
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
      next.wake();
    }
  }
}

const makeBudget = (): ByteBudgetApi => {
  const pool = new Permits(POOL_BYTES);
  const large = new Permits(1);

  return {
    lease: () => {
      let pooled = 0;
      let inLarge = false;
      let released = false;
      // Charges run one after another, so a move to the large slot never races a pool charge.
      let queue = Promise.resolve();

      const chargeNow = async (bytes: number) => {
        if (released || inLarge) {
          return;
        }

        if (pooled + bytes > POOL_CALL_LIMIT) {
          await large.take(1);
          inLarge = true;
          pool.release(pooled);
          pooled = 0;

          return;
        }

        await pool.take(bytes);
        pooled += bytes;
      };

      return {
        charge: (bytes) => {
          const charged = queue.then(() => chargeNow(bytes));

          queue = charged.catch(() => undefined);

          return charged;
        },
        release: () => {
          if (released) {
            return;
          }

          released = true;
          // After any charge in flight, so what it took is given back too.
          void queue.then(() => (inLarge ? large.release(1) : pool.release(pooled)));
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
