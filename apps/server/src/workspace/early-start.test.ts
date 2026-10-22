// The Container's early start (docs/spec.md → Backends): the Workspace connects its Container (launching or
// restoring it), pushes its files and runs the bootstrap, with no command, while the model works on its first response.
// The Container is faked; the idle stop is the real one, over a fake clock and alarm.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off preferEffectArray:off
import { describe, expect, it } from "vitest";
import { IdleStop } from "./idle.ts";
import { ContainerEarlyStart, type EarlyStartDeps } from "./early-start.ts";

const MINUTE = 60_000;

/** A gate a fake step waits on until the test opens it. */
const gate = () => {
  let open: () => void = () => undefined;

  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { opened, open };
};

const setup = (overrides: Partial<EarlyStartDeps> = {}) => {
  const steps: string[] = [];
  const infos: string[] = [];
  const warnings: string[] = [];
  const clock = { now: 1_000_000 };
  const container = { running: false, stops: 0 };
  let alarm: number | undefined;

  const idle = new IdleStop({
    idleMs: async () => 15 * MINUTE,
    now: () => clock.now,
    load: async () => undefined,
    save: async () => undefined,
    setAlarm: async (at) => {
      alarm = at;
    },
    snapshot: async () => undefined,
    stop: async () => {
      container.stops++;
      container.running = false;
    },
  });

  const earlyStart = new ContainerEarlyStart({
    running: () => container.running,
    connect: async () => {
      steps.push("connect");
      container.running = true;

      return 0;
    },
    runBootstrap: async () => {
      steps.push("bootstrap");
    },
    idle: {
      touch: () => {
        steps.push("touch");

        return idle.touch();
      },
      begin: () => {
        steps.push("begin");

        return idle.begin();
      },
      end: () => {
        steps.push("end");

        return idle.end();
      },
    },
    now: () => clock.now,
    info: (message) => infos.push(message),
    warn: (message) => warnings.push(message),
    ...overrides,
  });

  return {
    earlyStart,
    idle,
    steps,
    infos,
    warnings,
    clock,
    container,
    alarm: () => alarm,
  };
};

describe("the Container's early start on a message", () => {
  it("connects the Container, then runs the bootstrap, as one use of it", async () => {
    const { earlyStart, steps, infos } = setup();

    await earlyStart.start();

    expect(steps).toEqual(["begin", "connect", "bootstrap", "end"]);
    expect(infos.join("\n")).toContain("workspace.container.early_start");
  });

  it("starts nothing while the Container is running, but counts the message as a use of it", async () => {
    const { earlyStart, steps, container } = setup();

    container.running = true;
    await earlyStart.start();

    expect(steps).toEqual(["touch"]);
  });

  it("keeps a running Container one idle time after a message that came near the end of the last", async () => {
    const { earlyStart, idle, clock, container } = setup();

    await earlyStart.start();

    // The model thinks past the idle time the Container's start began.
    clock.now += 14 * MINUTE;
    await earlyStart.start();
    clock.now += 2 * MINUTE;
    await idle.alarm();

    expect(container.stops).toBe(0);

    clock.now += 13 * MINUTE;
    await idle.alarm();

    expect(container.stops).toBe(1);
  });

  it("does nothing while a start is under way: one connect and one bootstrap", async () => {
    const bootstrapped = gate();

    const { earlyStart, steps } = setup({
      // `running` stays false until the start is done, as a launching Container may.
      running: () => false,
      runBootstrap: async () => {
        steps.push("bootstrap");
        await bootstrapped.opened;
      },
      connect: async () => {
        steps.push("connect");

        return 0;
      },
    });

    const first = earlyStart.start();

    const second = earlyStart.start();

    bootstrapped.open();
    await Promise.all([first, second]);

    expect(steps.filter((step) => step === "connect")).toHaveLength(1);
    expect(steps.filter((step) => step === "bootstrap")).toHaveLength(1);

    // Once it is over, a later message may start the Container again (it was stopped meanwhile, say).
    await earlyStart.start();

    expect(steps.filter((step) => step === "connect")).toHaveLength(2);
  });

  it("never fails: a start that fails is logged, and ends its use", async () => {
    const { earlyStart, steps, warnings } = setup({
      connect: async () => {
        throw new Error("no Container for you");
      },
    });

    await expect(earlyStart.start()).resolves.toBeUndefined();

    expect(steps).toEqual(["begin", "end"]);
    expect(warnings.join("\n")).toContain("no Container for you");
  });

  it("counts as use: the idle stop stops the Container one idle time after the start", async () => {
    const { earlyStart, idle, clock, container, alarm } = setup();

    await earlyStart.start();

    expect(alarm()).toBe(clock.now + 15 * MINUTE);

    clock.now += 15 * MINUTE;
    await idle.alarm();

    expect(container.stops).toBe(1);
  });

  it("keeps the Container while its bootstrap runs, however long", async () => {
    const bootstrapped = gate();

    const { earlyStart, idle, clock, container } = setup({
      runBootstrap: async () => {
        await bootstrapped.opened;
      },
    });

    const started = earlyStart.start();

    // Let the start reach the bootstrap.
    await new Promise((resolve) => setTimeout(resolve, 0));

    clock.now += 20 * MINUTE;
    await idle.alarm();

    expect(container.stops).toBe(0);

    bootstrapped.open();
    await started;

    clock.now += 15 * MINUTE;
    await idle.alarm();

    expect(container.stops).toBe(1);
  });
});
