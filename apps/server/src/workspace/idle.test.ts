// The Container's idle stop (docs/spec.md → Container and Toolchains): a Workspace stops its Container once no command
// has used it for the idle time. The Workspace DO's alarm and storage are faked; the clock is a number the test moves.
// @effect-diagnostics asyncFunction:off
import { describe, expect, it } from "vitest";
import { IdleStop } from "./idle.ts";

const MINUTE = 60_000;

type FakeState = {
  now: number;
  alarm: number | undefined;
  saved: number | undefined;
  stops: number;
};

/** A fake Durable Object: a clock, one alarm, one stored time, and a count of Container stops. */
const open = (idleMs = 15 * MINUTE) => {
  const state: FakeState = {
    now: 1_000_000,
    alarm: undefined,
    saved: undefined,
    stops: 0,
  };

  const make = () =>
    new IdleStop({
      idleMs,
      now: () => state.now,
      load: async () => state.saved,
      save: async (at) => {
        state.saved = at;
      },
      setAlarm: async (at) => {
        state.alarm = at;
      },
      stop: async () => {
        state.stops++;
      },
    });

  /** Move the clock to the alarm and run it, as the platform does. */
  const fire = async (idle: IdleStop) => {
    const at = state.alarm;

    if (at === undefined) throw new Error("no alarm set");
    state.alarm = undefined;
    state.now = Math.max(state.now, at);
    await idle.alarm();
  };

  return { state, idle: make(), make, fire };
};

describe("IdleStop", () => {
  it("stops the Container once the idle time has passed without use", async () => {
    const { state, idle, fire } = open();

    await idle.touch();
    expect(state.alarm).toBe(state.now + 15 * MINUTE);

    await fire(idle);

    expect(state.stops).toBe(1);
    expect(state.alarm).toBeUndefined();
  });

  it("keeps the Container while it is used: the alarm moves to the last use plus the idle time", async () => {
    const { state, idle, fire } = open();

    await idle.touch();
    state.now += 10 * MINUTE;
    await idle.touch();

    const lastUse = state.now;

    await fire(idle);
    expect(state.stops).toBe(0);
    expect(state.alarm).toBe(lastUse + 15 * MINUTE);

    await fire(idle);
    expect(state.stops).toBe(1);
  });

  it("sets one alarm for many uses", async () => {
    const { state, idle } = open();
    const first = state.now + 15 * MINUTE;

    for (let use = 0; use < 5; use++) {
      await idle.touch();
      state.now += 1000;
    }

    expect(state.alarm).toBe(first);
  });

  it("arms again for the next use after it stopped the Container", async () => {
    const { state, idle, fire } = open();

    await idle.touch();
    await fire(idle);
    state.now += 5 * MINUTE;
    await idle.touch();

    expect(state.alarm).toBe(state.now + 15 * MINUTE);

    await fire(idle);
    expect(state.stops).toBe(2);
  });

  it("works from the stored time when the object was evicted since the last use", async () => {
    const { state, idle, make, fire } = open();

    await idle.touch();

    const firstUse = state.now;

    state.now += 10 * MINUTE;
    await idle.touch();

    const lastUse = state.now;

    // A new instance has no memory of the uses, only what was stored: the later one, so the Container stays.
    const revived = make();

    state.alarm = firstUse + 15 * MINUTE;
    await fire(revived);
    expect(state.stops).toBe(0);
    expect(state.alarm).toBe(lastUse + 15 * MINUTE);

    await fire(revived);
    expect(state.stops).toBe(1);
  });
});
