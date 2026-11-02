// The budget's leases are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off
import { describe, expect, it } from "vitest";
import { type Lease, makeBudget, POOL_CALL_LIMIT } from "./budget.ts";
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

/** Charges `bytes` to `lease` in one go, as a fetch's first chunk would. */
const charged = (lease: Lease, bytes: number) => lease.charge(bytes);

describe("the byte budget", () => {
  it("lets calls that oversubscribe the pool all go on: a waiting call holds nothing", async () => {
    const budget = makeBudget();
    const [a, b, c] = [budget.lease(), budget.lease(), budget.lease()];

    // Between them they hold the whole pool, so none can take a mebibyte more while the others hold theirs.
    await charged(a, 3 * MiB);
    await charged(b, 3 * MiB);
    await charged(c, 2 * MiB);

    const more = [a.charge(MiB), b.charge(MiB), c.charge(MiB)];

    // Whoever waits gives back what it holds, so the one before it goes on.
    expect(await settled(more[0]!)).toBe(true);
    expect(await settled(more[1]!)).toBe(true);

    a.release();
    expect(await settled(more[2]!)).toBe(true);

    b.release();
    c.release();

    // All given back: two calls take the whole pool at once.
    const [d, e] = [budget.lease(), budget.lease()];

    expect(await settled(charged(d, POOL_CALL_LIMIT))).toBe(true);
    expect(await settled(charged(e, POOL_CALL_LIMIT))).toBe(true);
  });

  it("gives back a waiting call's bytes at once when it is released, and drops its waiter", async () => {
    const budget = makeBudget();
    const [a, b, waiting] = [budget.lease(), budget.lease(), budget.lease()];

    await charged(a, POOL_CALL_LIMIT);
    await charged(b, POOL_CALL_LIMIT);
    await charged(waiting, 0);

    const stuck = waiting.charge(MiB);

    expect(await settled(stuck)).toBe(false);

    // An abort or a timeout: its charge settles, and it is not let in later.
    waiting.release();
    expect(await settled(stuck)).toBe(true);

    a.release();

    const next = budget.lease();

    expect(await settled(charged(next, POOL_CALL_LIMIT))).toBe(true);
  });

  it("drops a call waiting for the large slot when it is released", async () => {
    const budget = makeBudget();
    const [holder, waiting, next] = [budget.lease(), budget.lease(), budget.lease()];

    await charged(holder, 10 * MiB);

    const stuck = waiting.charge(10 * MiB);

    expect(await settled(stuck)).toBe(false);
    waiting.release();
    expect(await settled(stuck)).toBe(true);

    holder.release();
    expect(await settled(charged(next, 10 * MiB))).toBe(true);
  });

  it("gives back a waiting call's pool bytes while it waits for the large slot", async () => {
    const budget = makeBudget();
    const [holder, growing, small] = [budget.lease(), budget.lease(), budget.lease()];

    await charged(holder, 10 * MiB);
    await charged(growing, 3 * MiB);

    const stuck = growing.charge(2 * MiB);

    expect(await settled(stuck)).toBe(false);
    // The 3 MiB it held are free for others while it waits.
    expect(await settled(charged(small, POOL_CALL_LIMIT))).toBe(true);
    small.release();

    holder.release();
    expect(await settled(stuck)).toBe(true);
  });

  it("takes back an unread stream's lease once it expires, waking the call waiting on it", async () => {
    let now = 0;

    const budget = makeBudget({ now: () => now });
    const [holder, waiting] = [budget.lease(), budget.lease()];

    await charged(holder, 10 * MiB);
    holder.expireIn(50);

    const stuck = waiting.charge(10 * MiB);

    expect(await settled(stuck)).toBe(false);

    now = 50;
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(await settled(stuck)).toBe(true);
  });

  it("takes back an expired lease when the next call asks", async () => {
    let now = 0;

    const budget = makeBudget({ now: () => now });
    const holder = budget.lease();

    await charged(holder, 10 * MiB);
    holder.expireIn(50);
    now = 50;

    expect(await settled(charged(budget.lease(), 10 * MiB))).toBe(true);
  });
});
