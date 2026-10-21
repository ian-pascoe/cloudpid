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
  snapshots: number;
  /** Runs inside `snapshot`, while the Container's disk is being saved. */
  duringSnapshot: (() => Promise<void>) | undefined;
  /** Set to make `setAlarm` reject once. */
  failNextSetAlarm: boolean;
  /** Runs inside `stop`, while the Container is being stopped. */
  duringStop: (() => Promise<void>) | undefined;
};

/** A fake Durable Object: a clock, one alarm, one stored time, and a count of Container stops. */
const open = (initialIdleMs = 15 * MINUTE) => {
  const idle = { ms: initialIdleMs };

  const state: FakeState = {
    now: 1_000_000,
    alarm: undefined,
    saved: undefined,
    stops: 0,
    snapshots: 0,
    duringSnapshot: undefined,
    failNextSetAlarm: false,
    duringStop: undefined,
  };

  const make = () =>
    new IdleStop({
      idleMs: async () => idle.ms,
      now: () => state.now,
      load: async () => state.saved,
      save: async (at) => {
        state.saved = at;
      },
      setAlarm: async (at) => {
        if (state.failNextSetAlarm) {
          state.failNextSetAlarm = false;
          throw new Error("storage unavailable");
        }

        state.alarm = at;
      },
      snapshot: async () => {
        await state.duringSnapshot?.();
        state.snapshots++;
      },
      stop: async () => {
        await state.duringStop?.();
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

  return { state, idle: make(), make, fire, setIdle: (ms: number) => (idle.ms = ms) };
};

describe("IdleStop", () => {
  it("brings the alarm forward when the Container turns out to have a shorter idle time than the one it was armed with", async () => {
    const { state, idle, setIdle } = open(15 * MINUTE);

    // The first use comes before the launch is recorded, so it sees the default time.
    await idle.touch();
    expect(state.alarm).toBe(state.now + 15 * MINUTE);

    // The launch is recorded with the Workspace's own, shorter time.
    setIdle(MINUTE);
    state.now += 5_000;
    await idle.touch();

    expect(state.alarm).toBe(state.now + MINUTE);
  });

  it("does not move the alarm earlier on ordinary use", async () => {
    const { state, idle } = open();

    await idle.touch();

    const armed = state.alarm;

    state.now += 5 * MINUTE;
    await idle.touch();

    expect(state.alarm).toBe(armed);
  });

  it("stops after the configured idle time, whatever it is", async () => {
    const { state, idle, fire } = open(5 * MINUTE);

    await idle.touch();
    expect(state.alarm).toBe(state.now + 5 * MINUTE);

    state.now += 3 * MINUTE;
    await idle.touch();

    await fire(idle);

    // The alarm found the Container used 3 minutes ago, and waits for the rest of the 5.
    expect(state.stops).toBe(0);
    expect(state.alarm).toBe(state.now + 3 * MINUTE);

    await fire(idle);

    expect(state.stops).toBe(1);
  });

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

  it("tries to arm the alarm again at the next use when setting it failed", async () => {
    const { state, idle } = open();

    state.failNextSetAlarm = true;
    await expect(idle.touch()).rejects.toThrow("storage unavailable");
    expect(state.alarm).toBeUndefined();

    state.now += MINUTE;
    await idle.touch();

    expect(state.alarm).toBe(state.now + 15 * MINUTE);
  });

  it("tries to arm the alarm again when waiting for the rest of the idle time failed", async () => {
    const { state, idle, fire } = open();

    await idle.touch();
    state.now += 10 * MINUTE;
    await idle.touch();
    state.failNextSetAlarm = true;
    await expect(fire(idle)).rejects.toThrow("storage unavailable");
    expect(state.alarm).toBeUndefined();

    state.now += MINUTE;
    await idle.touch();

    expect(state.alarm).toBe(state.now + 15 * MINUTE);
  });

  it("remembers a use that arrives while the Container is being stopped", async () => {
    const { state, idle, fire } = open();

    await idle.touch();
    state.duringStop = async () => {
      state.now += 1000;
      await idle.touch();
    };

    await fire(idle);

    // The Container stopped, and the use during it armed the next alarm, which finds it.
    expect(state.stops).toBe(1);
    expect(state.alarm).toBe(state.now + 15 * MINUTE);

    state.duringStop = undefined;
    await fire(idle);
    expect(state.stops).toBe(2);
  });

  it("snapshots the Container before it stops it", async () => {
    const { state, idle, fire } = open();

    await idle.touch();
    await fire(idle);

    expect(state.snapshots).toBe(1);
    expect(state.stops).toBe(1);
  });

  it("keeps the Container when a command arrives while its disk is being snapshotted, which stopping would kill", async () => {
    const { state, idle, fire } = open();

    await idle.touch();
    state.duringSnapshot = async () => {
      state.now += 5_000;
      await idle.begin();
    };

    await fire(idle);

    expect(state.snapshots).toBe(1);
    expect(state.stops).toBe(0);

    // The command is still running: the next alarm waits again, and stops nothing until it ends.
    state.duringSnapshot = undefined;
    await fire(idle);
    expect(state.stops).toBe(0);

    await idle.end();
    await fire(idle);
    expect(state.stops).toBe(1);
  });

  it("keeps the Container when a use arrives during the snapshot, and the next alarm counts from it", async () => {
    const { state, idle, fire } = open();

    await idle.touch();
    state.duringSnapshot = async () => {
      state.now += 5_000;
      await idle.touch();
    };

    await fire(idle);

    expect(state.stops).toBe(0);
    expect(state.alarm).toBe(state.now + 15 * MINUTE);

    state.duringSnapshot = undefined;
    await fire(idle);
    expect(state.stops).toBe(1);
  });

  it("keeps the Container, waiting again at each alarm, while a command runs", async () => {
    const { state, idle, fire } = open();

    await idle.begin();

    for (let alarm = 0; alarm < 3; alarm++) {
      await fire(idle);
      expect(state.stops).toBe(0);
      expect(state.alarm).toBe(state.now + 15 * MINUTE);
    }

    // The end of the command is a use: the idle time counts from it.
    state.now += 10 * MINUTE;
    await idle.end();
    await fire(idle);
    expect(state.stops).toBe(0);

    await fire(idle);
    expect(state.stops).toBe(1);
  });

  it("keeps the Container until the last of several commands ends", async () => {
    const { state, idle, fire } = open();

    await idle.begin();
    await idle.begin();
    await idle.end();
    await fire(idle);
    expect(state.stops).toBe(0);

    await idle.end();
    await fire(idle);
    expect(state.stops).toBe(1);
  });
});
