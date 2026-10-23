// A spare Workspace's Durable Object preparing itself (docs/spec.md → Spare Workspace): the object's storage, alarm,
// idle stop and readying are faked; the clock is a number the test moves.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off
import { describe, expect, it } from "vitest";
import type { WorkspaceSetup } from "./prepare.ts";
import { SPARE_ATTEMPTS, SparePreparation, type SpareRequest } from "./spare.ts";

const setup: WorkspaceSetup = {
  repos: [{ name: "app", url: "https://github.com/acme/app.git" }],
  branch: "cloudpid/spare",
  base: null,
  settings: { idleMinutes: 30 },
};

type FakeState = {
  now: number;
  stored: SpareRequest | undefined;
  alarm: number | undefined;
  prepared: WorkspaceSetup[];
  /** Holds of the Container the idle stop counts. */
  running: number;
  /** `running` as it was when each readying began. */
  held: number[];
  stops: number;
  warnings: string[];
  infos: string[];
  /** Resolves the readying in flight, or fails it. */
  finish: ((failure?: Error) => void) | undefined;
};

/** A fake object: its stored request, its alarm, its idle stop, and a readying the test controls. */
const open = () => {
  const state: FakeState = {
    now: 1_000_000,
    stored: undefined,
    alarm: undefined,
    prepared: [],
    running: 0,
    held: [],
    stops: 0,
    warnings: [],
    infos: [],
    finish: undefined,
  };

  const make = () =>
    new SparePreparation({
      load: async () => state.stored,
      save: async (request) => {
        state.stored = request;
      },
      clear: async () => {
        state.stored = undefined;
      },
      wake: async (at) => {
        if (state.alarm === undefined || at < state.alarm) state.alarm = at;
      },
      prepare: (with_) => {
        state.prepared.push(with_);
        state.held.push(state.running);

        return new Promise<void>((resolve, reject) => {
          state.finish = (failure) => (failure === undefined ? resolve() : reject(failure));
        });
      },
      idle: {
        begin: async () => {
          state.running++;
        },
        end: async () => {
          state.running--;
        },
        stop: async () => {
          state.stops++;
        },
      },
      now: () => state.now,
      info: (message) => {
        state.infos.push(message);
      },
      warn: (message) => {
        state.warnings.push(message);
      },
    });

  /** Let the work the alarm started run as far as it can. */
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  return { state, spare: make(), make, settle };
};

describe("SparePreparation", () => {
  it("keeps the request and wakes the object at once, preparing nothing before the alarm", async () => {
    const { state, spare } = open();

    await spare.request(setup);

    expect(state.stored).toEqual({ setup, attempts: 0 });
    expect(state.alarm).toBe(state.now);
    expect(state.prepared).toEqual([]);
  });

  it("readies the spare at the alarm, holding the Container, then snapshots and stops it and forgets the request", async () => {
    const { state, spare, settle } = open();

    await spare.request(setup);
    await spare.alarm();
    await settle();

    // The alarm has answered; the readying goes on, with the Container held.
    expect(state.prepared).toEqual([setup]);
    expect(state.held).toEqual([1]);
    expect(state.stops).toBe(0);

    state.finish?.();
    await settle();

    expect(state.running).toBe(0);
    expect(state.stops).toBe(1);
    expect(state.stored).toBeUndefined();
  });

  it("leaves the Container to the idle stop when the spare was taken while it was prepared", async () => {
    const { state, spare, settle } = open();

    await spare.request(setup);
    await spare.alarm();
    await settle();
    // A Session took the spare and used its object.
    spare.noteUse();
    state.finish?.();
    await settle();

    expect(state.stops).toBe(0);
    expect(state.stored).toBeUndefined();
    expect(state.infos).toContainEqual(expect.stringContaining("taken"));
  });

  it("counts a use between the request and the alarm as taking it too", async () => {
    const { state, spare, settle } = open();

    await spare.request(setup);
    spare.noteUse();
    await spare.alarm();
    await settle();
    state.finish?.();
    await settle();

    expect(state.stops).toBe(0);
  });

  it("logs a readying that fails and leaves the spare as it is, for the Session that takes it", async () => {
    const { state, spare, settle } = open();

    await spare.request(setup);
    await spare.alarm();
    await settle();
    state.finish?.(new Error("could not clone"));
    await settle();

    expect(state.warnings).toHaveLength(1);
    expect(state.warnings[0]).toContain("could not clone");
    expect(state.stops).toBe(0);
    expect(state.running).toBe(0);
    expect(state.stored).toBeUndefined();
  });

  it("starts no second readying at an alarm while one runs", async () => {
    const { state, spare, settle } = open();

    await spare.request(setup);
    await spare.alarm();
    await settle();
    await spare.alarm();
    await settle();

    expect(state.prepared).toHaveLength(1);
  });

  it("does nothing at an alarm with no request: the idle stop's", async () => {
    const { state, spare } = open();

    await spare.alarm();

    expect(state.prepared).toEqual([]);
  });

  it("starts again in an object evicted midway, at its next alarm, a few times at most", async () => {
    const { state, spare, make, settle } = open();

    await spare.request(setup);
    await spare.alarm();
    await settle();

    // Evicted: a new instance over the same storage, its alarm (the idle stop's) firing later.
    for (let attempt = 1; attempt < SPARE_ATTEMPTS; attempt++) {
      await make().alarm();
      await settle();
    }

    expect(state.prepared).toHaveLength(SPARE_ATTEMPTS);

    await make().alarm();
    await settle();

    expect(state.prepared).toHaveLength(SPARE_ATTEMPTS);
    expect(state.stored).toBeUndefined();
    expect(state.warnings).toHaveLength(1);
  });

  it("brings an alarm set for later forward while a request waits for its own", async () => {
    const { state, spare, settle } = open();
    const later = state.now + 5 * 60_000;

    expect(await spare.alarmAt(later)).toBe(later);

    await spare.request(setup);

    expect(await spare.alarmAt(later)).toBe(state.now);

    await spare.alarm();
    await settle();

    expect(await spare.alarmAt(later)).toBe(later);
  });
});
