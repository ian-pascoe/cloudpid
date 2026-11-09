// The budget's leases are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off
import { describe, expect, it } from "vitest";
import { makeBudget, POOL_CALL_LIMIT } from "./budget.ts";
import { MiB } from "./units.ts";

/** Whether `promise` has settled once pending callbacks have run. */
const settled = async (promise: Promise<unknown>) => {
  let done = false;

  void promise.then(() => {
    done = true;
  });

  await new Promise((resolve) => setTimeout(resolve, 0));

  return done;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the byte budget", () => {
  it("lets the oldest waiter in over budget when every pool holder is waiting, one call at a time", async () => {
    const budget = makeBudget();
    const [a, b, c] = [budget.lease(), budget.lease(), budget.lease()];

    // Between them they hold the whole pool, and each waits for a mebibyte more.
    await a.charge(3 * MiB);
    await b.charge(3 * MiB);
    await c.charge(2 * MiB);

    const more = [a.charge(MiB), b.charge(MiB), c.charge(MiB)] as const;

    // The oldest, `a`, goes on over budget; the others keep what they hold and wait.
    expect(await settled(more[0])).toBe(true);
    expect(await settled(more[1])).toBe(false);
    expect(await settled(more[2])).toBe(false);

    // Over budget, `a` is never held back, until it moves to the large slot and gives its pool bytes back.
    expect(await settled(a.charge(MiB))).toBe(true);
    expect(await settled(more[1])).toBe(true);
    expect(await settled(more[2])).toBe(true);
  });

  it("lets nobody in over budget while the holders still running hold enough for the oldest waiter", async () => {
    const budget = makeBudget();
    const [running, a, b, fresh] = [budget.lease(), budget.lease(), budget.lease(), budget.lease()];

    // The pool is full; `a` and `b` wait for more, `running` does not.
    await running.charge(POOL_CALL_LIMIT);
    await a.charge(3 * MiB);
    await b.charge(MiB);

    const more = [a.charge(MiB), b.charge(MiB), fresh.charge(MiB)] as const;

    for (const charge of more) {
      expect(await settled(charge)).toBe(false);
    }

    running.release();

    for (const charge of more) {
      expect(await settled(charge)).toBe(true);
    }
  });

  it("lets the oldest waiter in over budget when the holders still running could not give back enough for it", async () => {
    const budget = makeBudget();
    const [idle, a, b, c] = [budget.lease(), budget.lease(), budget.lease(), budget.lease()];

    // `idle` holds a few bytes and waits on its server, not on the pool (a slow tool's open response); the others
    // hold the rest of the pool and each waits for a mebibyte more.
    await idle.charge(512);
    await a.charge(3 * MiB);
    await b.charge(3 * MiB);
    await c.charge(2 * MiB - 512);

    const more = [a.charge(MiB), b.charge(MiB), c.charge(MiB)] as const;

    // Were `idle` to end, its bytes would let none of them in, so waiting on it is a deadlock: the oldest goes on.
    expect(await settled(more[0])).toBe(true);
    expect(await settled(more[1])).toBe(false);
    expect(await settled(more[2])).toBe(false);
  });

  it("lets a second waiter in over budget only once the first has left the pool", async () => {
    const budget = makeBudget();
    const [a, b, c, d] = [budget.lease(), budget.lease(), budget.lease(), budget.lease()];

    // The pool is full, and each waits for a mebibyte more; `a`, the oldest, goes on over budget.
    await a.charge(512);
    await b.charge(3 * MiB);
    await c.charge(3 * MiB);
    await d.charge(2 * MiB - 512);

    const more = [a.charge(MiB), b.charge(MiB), c.charge(MiB), d.charge(MiB)] as const;

    expect(await settled(more[0])).toBe(true);

    // Were `a` to end, its bytes would not let `b` in either; still, `b` waits while `a` is over budget, even when
    // another call comes to wait after it.
    void budget.lease().charge(1);
    expect(await settled(more[1])).toBe(false);

    a.release();
    expect(await settled(more[1])).toBe(true);
    expect(await settled(more[2])).toBe(false);
  });

  it("counts a call waiting for the large slot as one that will give its pool bytes back", async () => {
    const budget = makeBudget();
    const [large, growing, a, b] = [budget.lease(), budget.lease(), budget.lease(), budget.lease()];

    await large.charge(10 * MiB);
    await growing.charge(3 * MiB);
    await a.charge(3 * MiB);
    await b.charge(2 * MiB);

    // `growing` waits for the large slot, holding 3 MiB it gives back once it gets the slot; `a` and `b` wait for it.
    const moving = growing.charge(2 * MiB);
    const more = [a.charge(MiB), b.charge(MiB)] as const;

    for (const charge of [moving, ...more]) {
      expect(await settled(charge)).toBe(false);
    }

    large.release();

    for (const charge of [moving, ...more]) {
      expect(await settled(charge)).toBe(true);
    }
  });

  it("keeps a waiting call's bytes counted", async () => {
    const budget = makeBudget();

    const [holder, growing, other, last] = [
      budget.lease(),
      budget.lease(),
      budget.lease(),
      budget.lease(),
    ];

    await holder.charge(10 * MiB);
    await growing.charge(3 * MiB);

    // Waiting for the large slot, `growing` keeps its 3 MiB: 5 MiB are left, not 8.
    const stuck = growing.charge(2 * MiB);

    expect(await settled(stuck)).toBe(false);
    expect(await settled(other.charge(POOL_CALL_LIMIT))).toBe(true);

    const waits = last.charge(2 * MiB);

    expect(await settled(waits)).toBe(false);

    // The large slot frees, `growing` moves to it and gives its pool bytes back.
    holder.release();
    expect(await settled(stuck)).toBe(true);
    expect(await settled(waits)).toBe(true);
  });

  it("gives back a waiting call's bytes at once when it is released, and drops its waiter", async () => {
    const budget = makeBudget();
    const [a, b, waiting] = [budget.lease(), budget.lease(), budget.lease()];

    await a.charge(POOL_CALL_LIMIT);
    await b.charge(POOL_CALL_LIMIT);

    const stuck = waiting.charge(MiB);

    expect(await settled(stuck)).toBe(false);

    // An abort or a timeout: its charge settles, and it is not let in later.
    waiting.release();
    expect(await settled(stuck)).toBe(true);

    a.release();
    expect(await settled(budget.lease().charge(POOL_CALL_LIMIT))).toBe(true);
  });

  it("drops a call waiting for the large slot when it is released", async () => {
    const budget = makeBudget();
    const [holder, waiting, next] = [budget.lease(), budget.lease(), budget.lease()];

    await holder.charge(10 * MiB);

    const stuck = waiting.charge(10 * MiB);

    expect(await settled(stuck)).toBe(false);
    waiting.release();
    expect(await settled(stuck)).toBe(true);

    holder.release();
    expect(await settled(next.charge(10 * MiB))).toBe(true);
  });

  it("takes back an unread stream's lease once it expires, waking the call waiting on it", async () => {
    let now = 0;

    const budget = makeBudget({ now: () => now });
    const [holder, waiting] = [budget.lease(), budget.lease()];

    await holder.charge(10 * MiB);
    holder.expireIn(50);

    const stuck = waiting.charge(10 * MiB);

    expect(await settled(stuck)).toBe(false);

    now = 50;
    await sleep(80);

    expect(await settled(stuck)).toBe(true);
  });

  it("wakes a call that began to wait before the lease it waits on started to expire", async () => {
    let now = 0;

    const budget = makeBudget({ now: () => now, recheckMs: 20 });
    const [holder, waiting] = [budget.lease(), budget.lease()];

    await holder.charge(10 * MiB);

    const stuck = waiting.charge(10 * MiB);

    expect(await settled(stuck)).toBe(false);

    holder.expireIn(50);
    now = 50;
    await sleep(60);

    expect(await settled(stuck)).toBe(true);
  });

  it("renews an expiry, so a stream read slowly keeps its lease", async () => {
    let now = 0;

    const budget = makeBudget({ now: () => now });
    const holder = budget.lease();

    await holder.charge(10 * MiB);
    holder.expireIn(50);
    now = 40;
    holder.expireIn(50);
    now = 60;

    const next = budget.lease().charge(10 * MiB);

    expect(await settled(next)).toBe(false);

    now = 90;
    expect(await settled(budget.lease().charge(MiB))).toBe(true);
    expect(await settled(next)).toBe(true);
  });
});
