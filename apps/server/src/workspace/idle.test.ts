// The Container's idle stop (docs/architecture/container.md): a Workspace stops its Container once no command
// has used it for the idle time. The Workspace DO's alarm and storage are faked; the clock is a number the test moves.
// @effect-diagnostics asyncFunction:off
import { describe, expect, it } from "vitest";
import { CONTAINER_HOLD_CAP_MS, type ContainerHold, type HeldStop, IdleStop } from "./idle.ts";

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
  /** The last activity stored. */
  activity: number | undefined;
  /** Whether a Container runs. */
  running: boolean;
  /** The held stops reported. */
  held: HeldStop[];
  /** How many times something that may change the disk was told on (`wrote`). */
  writes: number;
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
    activity: undefined,
    running: true,
    held: [],
    writes: 0,
  };

  const make = () =>
    new IdleStop({
      idleMs: async () => idle.ms,
      now: () => state.now,
      load: async () => state.saved,
      save: async (at) => {
        state.saved = at;
      },
      loadActivity: async () => state.activity,
      saveActivity: async (at) => {
        state.activity = at;
      },
      running: () => state.running,
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
      held: async (stop) => {
        state.held.push(stop);
      },
      wrote: async () => {
        state.writes++;
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

  it("does not stop a Container whose own idle time is longer than the default it was armed with", async () => {
    const { state, idle, setIdle, fire } = open(5 * MINUTE);

    // The first use comes before the launch is recorded, so it sees the default (5 minutes here).
    await idle.touch();

    const lastUse = state.now;

    expect(state.alarm).toBe(lastUse + 5 * MINUTE);

    // The launch is recorded with the Workspace's own, longer time.
    setIdle(90 * MINUTE);
    await fire(idle);

    // The first alarm finds the Container not yet due, and waits for the rest of the 90.
    expect(state.stops).toBe(0);
    expect(state.snapshots).toBe(0);
    expect(state.alarm).toBe(lastUse + 90 * MINUTE);

    await fire(idle);

    expect(state.stops).toBe(1);
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
    let command: ContainerHold | undefined;

    await idle.touch();
    state.duringSnapshot = async () => {
      state.now += 5_000;
      command = idle.hold();
      await command.begun;
    };

    await fire(idle);

    expect(state.snapshots).toBe(1);
    expect(state.stops).toBe(0);

    // The command is still running: the next alarm waits again, and stops nothing until it ends.
    state.duringSnapshot = undefined;
    await fire(idle);
    expect(state.stops).toBe(0);

    await command?.end();
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
    const command = idle.hold();

    await command.begun;

    for (let alarm = 0; alarm < 3; alarm++) {
      await fire(idle);
      expect(state.stops).toBe(0);
      expect(state.alarm).toBe(state.now + 15 * MINUTE);
    }

    // The end of the command is a use: the idle time counts from it.
    state.now += 10 * MINUTE;
    await command.end();
    await fire(idle);
    expect(state.stops).toBe(0);

    await fire(idle);
    expect(state.stops).toBe(1);
  });

  it("keeps the Container until the last of several commands ends", async () => {
    const { state, idle, fire } = open();

    const first = idle.hold();
    const second = idle.hold();

    await first.end();
    // A hold ends once: ending it again releases nothing.
    await first.end();
    await fire(idle);
    expect(state.stops).toBe(0);

    await second.end();
    await fire(idle);
    expect(state.stops).toBe(1);
  });

  describe("stopping now, as a spare Workspace does once it is prepared", () => {
    it("snapshots and stops the Container though it was just used", async () => {
      const { state, idle } = open();

      await idle.hold().end();
      await idle.stop();

      expect(state.snapshots).toBe(1);
      expect(state.stops).toBe(1);
    });

    it("keeps the Container while a command runs", async () => {
      const { state, idle } = open();

      idle.hold();
      await idle.stop();

      expect(state.snapshots).toBe(0);
      expect(state.stops).toBe(0);
    });

    it("keeps the Container when a use arrives during the snapshot, leaving the alarm to it", async () => {
      const { state, idle, fire } = open();

      await idle.touch();
      state.duringSnapshot = async () => {
        state.now += 5_000;
        await idle.touch();
      };

      await idle.stop();

      expect(state.stops).toBe(0);

      state.duringSnapshot = undefined;
      state.now += 15 * MINUTE;
      await fire(idle);
      expect(state.stops).toBe(1);
    });
  });
});

describe("IdleStop's hold cap", () => {
  /** Fire every alarm due up to `until`, as the platform does; the clock ends at `until`. */
  const runUntil = async (
    { state, fire }: ReturnType<typeof open>,
    idle: IdleStop,
    until: number,
  ) => {
    while (state.alarm !== undefined && state.alarm <= until) await fire(idle);

    state.now = Math.max(state.now, until);
  };

  it("stops a Container a command handle never released holds, once the cap passes without activity", async () => {
    const fake = open(2 * MINUTE);
    const { state, idle } = fake;

    // The agent runs a command whose handle is never disposed: its start is the last activity.
    await idle.noteActivity();

    const lastActivity = state.now;

    await idle.hold().begun;

    await runUntil(fake, idle, lastActivity + CONTAINER_HOLD_CAP_MS - 1);
    expect(state.stops).toBe(0);

    await runUntil(fake, idle, lastActivity + CONTAINER_HOLD_CAP_MS + 2 * MINUTE);

    // Snapshotted first, so the next command starts the Container from the snapshot, and reported for the notice.
    expect(state.snapshots).toBe(1);
    expect(state.stops).toBe(1);
    expect(state.held).toEqual([
      { at: lastActivity + CONTAINER_HOLD_CAP_MS, lastActivity, holds: 1 },
    ]);
  });

  it("drops the holds it stopped, so a handle never released keeps no later Container", async () => {
    const fake = open(2 * MINUTE);
    const { state, idle } = fake;

    await idle.noteActivity();

    const leaked = idle.hold();

    await leaked.begun;
    await runUntil(fake, idle, state.now + CONTAINER_HOLD_CAP_MS + 2 * MINUTE);
    expect(state.stops).toBe(1);

    // The next command starts a Container; the old handle is disposed late, and must not end the new hold.
    await idle.noteActivity();

    const next = idle.hold();

    await next.begun;
    await leaked.end();
    await runUntil(fake, idle, state.now + 10 * MINUTE);
    expect(state.stops).toBe(1);

    await next.end();
    await runUntil(fake, idle, state.now + 2 * MINUTE);
    expect(state.stops).toBe(2);
    expect(state.held).toHaveLength(1);
  });

  it("stops a Container an open Container preview keeps, by its socket and its requests, once the cap passes", async () => {
    const fake = open(2 * MINUTE);
    const { state, idle } = fake;

    await idle.noteActivity();

    const lastActivity = state.now;

    // The page's carried socket holds the Container, and its dev server's pings are uses every 30 s.
    await idle.hold().begun;

    while (state.stops === 0 && state.now < lastActivity + 2 * CONTAINER_HOLD_CAP_MS) {
      await idle.touch();
      await runUntil(fake, idle, state.now + 30_000);
    }

    expect(state.stops).toBe(1);
    expect(state.held).toEqual([
      { at: lastActivity + CONTAINER_HOLD_CAP_MS, lastActivity, holds: 1 },
    ]);
  });

  it("stops a Container a page's requests alone keep in use, once the cap passes", async () => {
    const fake = open(2 * MINUTE);
    const { state, idle } = fake;

    await idle.noteActivity();

    const lastActivity = state.now;

    while (state.stops === 0 && state.now < lastActivity + 2 * CONTAINER_HOLD_CAP_MS) {
      await idle.touch();
      await runUntil(fake, idle, state.now + 30_000);
    }

    expect(state.stops).toBe(1);
    expect(state.held).toEqual([
      { at: lastActivity + CONTAINER_HOLD_CAP_MS, lastActivity, holds: 0 },
    ]);
  });

  it("does not stop a long-running command while there is activity in the Workspace", async () => {
    const fake = open(2 * MINUTE);
    const { state, idle } = fake;

    await idle.noteActivity();

    const build = idle.hold();

    await build.begun;

    // Three hours of build, the Session's Run live meanwhile (its heartbeat is activity).
    for (let minute = 0; minute < 180; minute += 30) {
      await runUntil(fake, idle, state.now + 30 * MINUTE);
      await idle.noteActivity();
    }

    expect(state.stops).toBe(0);
    expect(state.snapshots).toBe(0);

    // The build ends, and the Container goes at its idle time.
    await build.end();
    await runUntil(fake, idle, state.now + 2 * MINUTE);
    expect(state.stops).toBe(1);
    expect(state.held).toEqual([]);
  });

  it("keeps the Container, holds and all, when activity comes while its disk is being snapshotted", async () => {
    const fake = open(2 * MINUTE);
    const { state, idle } = fake;

    await idle.noteActivity();

    const command = idle.hold();

    await command.begun;
    state.duringSnapshot = async () => {
      state.now += 5_000;
      await idle.noteActivity();
    };

    await runUntil(fake, idle, state.now + CONTAINER_HOLD_CAP_MS);
    expect(state.snapshots).toBe(1);
    expect(state.stops).toBe(0);
    expect(state.held).toEqual([]);

    // The command still holds it: no idle stop until it ends.
    state.duringSnapshot = undefined;
    await runUntil(fake, idle, state.now + 30 * MINUTE);
    expect(state.stops).toBe(0);

    await command.end();
    await runUntil(fake, idle, state.now + 2 * MINUTE);
    expect(state.stops).toBe(1);
  });

  it("only drops the holds when no Container runs at the cap", async () => {
    const fake = open(2 * MINUTE);
    const { state, idle } = fake;

    await idle.noteActivity();
    await idle.hold().begun;

    // A restart stopped the Container since.
    state.running = false;
    await runUntil(fake, idle, state.now + CONTAINER_HOLD_CAP_MS);

    expect(state.snapshots).toBe(0);
    expect(state.stops).toBe(0);
    expect(state.held).toEqual([]);
    expect(await idle.stopsBy()).not.toBeNull();
  });

  it("never stops a Container sooner than its own idle time, when that is longer than the cap", async () => {
    const idleMs = 2 * CONTAINER_HOLD_CAP_MS;
    const fake = open(idleMs);
    const { state, idle } = fake;

    await idle.noteActivity();
    await idle.touch();

    const lastUse = state.now;

    await runUntil(fake, idle, lastUse + idleMs - 1);
    expect(state.stops).toBe(0);

    await runUntil(fake, idle, lastUse + idleMs);
    expect(state.stops).toBe(1);
  });

  it("counts the cap from the stored activity when the object was evicted since", async () => {
    const fake = open(2 * MINUTE);
    const { state, idle, make } = fake;

    await idle.noteActivity();

    const lastActivity = state.now;

    // A page's requests keep the Container in use; the object is evicted and a new instance goes on.
    state.now += 30 * MINUTE;
    await idle.touch();

    const revived = make();

    while (state.stops === 0 && state.now < lastActivity + 2 * CONTAINER_HOLD_CAP_MS) {
      await revived.touch();
      await runUntil(fake, revived, state.now + 30_000);
    }

    expect(state.held[0]?.lastActivity).toBe(lastActivity);
  });

  it("knows the Container stops by the cap when that comes before its idle time", async () => {
    const { state, idle } = open(2 * MINUTE);

    await idle.noteActivity();

    const lastActivity = state.now;

    state.now = lastActivity + CONTAINER_HOLD_CAP_MS - MINUTE;
    await idle.touch();

    expect(await idle.stopsBy()).toBe(lastActivity + CONTAINER_HOLD_CAP_MS);
  });
});

describe("IdleStop's record of what may change the disk", () => {
  it("tells of a command as its hold begins, and knows it may write until it ends", async () => {
    const { state, make } = open();
    const idle = make();

    expect(idle.writing()).toBe(false);

    const hold = idle.hold();

    await hold.begun;

    expect(state.writes).toBe(1);
    expect(idle.writing()).toBe(true);

    await hold.end();

    expect(idle.writing()).toBe(false);
    expect(state.writes).toBe(1);
  });

  it("tells of nothing for a hold that does not write, which still keeps the Container", async () => {
    const { state, make, fire } = open();
    const idle = make();
    const hold = idle.hold({ writes: false });

    await hold.begun;

    expect(state.writes).toBe(0);
    expect(idle.writing()).toBe(false);

    state.now += 20 * MINUTE;
    await fire(idle);

    expect(state.stops).toBe(0);

    await hold.end();
  });

  it("knows a write holds while another hold that does not write ends", async () => {
    const { make } = open();
    const idle = make();
    const command = idle.hold();
    const socket = idle.hold({ writes: false });

    await Promise.all([command.begun, socket.begun]);
    await socket.end();

    expect(idle.writing()).toBe(true);

    await command.end();

    expect(idle.writing()).toBe(false);
  });

  it("passes on what the bootstrap and the scripts tell of", async () => {
    const { state, make } = open();

    await make().noteWrite();

    expect(state.writes).toBe(1);
  });

  it("drops the writing holds with the others at a held stop", async () => {
    const { state, make, fire } = open();
    const idle = make();

    await idle.noteActivity();
    await idle.hold().begun;

    state.now += CONTAINER_HOLD_CAP_MS;
    await fire(idle);

    expect(state.held).toHaveLength(1);
    expect(idle.writing()).toBe(false);
  });
});

describe("IdleStop's reports to the usage ledger", () => {
  const reporting = () => {
    const busy: boolean[] = [];
    const state = { now: 1_000_000, uses: 0, busy };

    const idle = new IdleStop({
      idleMs: async () => 15 * MINUTE,
      now: () => state.now,
      load: async () => undefined,
      save: async () => undefined,
      setAlarm: async () => undefined,
      snapshot: async () => undefined,
      stop: async () => undefined,
      used: () => {
        state.uses++;
      },
      busy: (busy) => {
        state.busy.push(busy);
      },
    });

    return { state, idle };
  };

  it("reports every use, and when commands begin to run and the last one ends", async () => {
    const { state, idle } = reporting();

    const first = idle.hold();
    const second = idle.hold();

    await first.begun;
    await second.begun;
    await first.end();
    await second.end();
    await second.end();

    expect(state.uses).toBe(5);
    expect(state.busy).toEqual([true, false]);
  });

  it("knows when the Container stops at the latest: none while a command runs, else the idle time after its last use", async () => {
    const { state, idle } = reporting();

    expect(await idle.stopsBy()).toBeNull();

    const command = idle.hold();

    await command.begun;

    expect(await idle.stopsBy()).toBeNull();

    state.now += MINUTE;
    await command.end();

    expect(await idle.stopsBy()).toBe(state.now + 15 * MINUTE);
  });
});
