// @effect-diagnostics asyncFunction:off newPromise:off globalTimers:off preferEffectArray:off
import { containerRates, type ContainerUsageSums, type InstanceType } from "@cloudpid/config";
import { describe, expect, it } from "vitest";
import type { AnalyticsWindow } from "./container-analytics.ts";
import {
  ContainerUsageLedger,
  type ContainerUsageRecord,
  REFRESH_MS,
  REPORT_LAG_MS,
  SETTLE_AFTER_MS,
} from "./container-usage.ts";

const MINUTE = 60_000;
const START = Date.UTC(2026, 9, 20, 12, 0, 0);

type Asked = { windows: ReadonlyArray<AnalyticsWindow> };

const harness = (
  options: {
    analytics?: (windows: ReadonlyArray<AnalyticsWindow>) => Promise<ContainerUsageSums[]>;
  } = {},
) => {
  let now = START;
  let running = false;
  let launch: { instance: InstanceType; launchedAt: number } | undefined;
  let stored: ContainerUsageRecord | undefined;
  const asked: Asked[] = [];
  const warnings: string[] = [];

  const make = () =>
    new ContainerUsageLedger({
      load: () => stored,
      save: (record) => {
        stored = record;
      },
      running: () => running,
      launch: async () => launch,
      until: async () => now + 5 * MINUTE,
      analytics:
        options.analytics === undefined
          ? undefined
          : (windows) => {
              asked.push({ windows });

              return options.analytics!(windows);
            },
      now: () => now,
      warn: (message) => warnings.push(message),
    });

  return {
    ledger: make(),
    /** A new instance over the same storage, as after an eviction. */
    reopen: make,
    asked,
    warnings,
    stored: () => stored,
    at: (offset: number) => {
      now = START + offset;
    },
    launch: (instance: InstanceType = "custom-2") => {
      running = true;
      launch = { instance, launchedAt: now };
    },
    die: () => {
      running = false;
    },
  };
};

/** Lets the background refresh land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ContainerUsageLedger without analytics", () => {
  it("has nothing to show before a Container ran", async () => {
    const { ledger } = harness();

    expect(await ledger.read()).toBeUndefined();
  });

  it("prices a running Container's memory and disk for the time since its launch", async () => {
    const h = harness();

    h.launch();
    await h.ledger.seen();
    h.at(10 * MINUTE);

    const usage = await h.ledger.read();
    const rates = containerRates("custom-2");

    expect(usage).toMatchObject({
      instance: "custom-2",
      running: true,
      busy: false,
      runSeconds: 600,
      cpuSeconds: 0,
      reportedThrough: null,
      rates,
      until: START + 15 * MINUTE,
    });
    expect(usage!.memory).toBeCloseTo(600 * rates.memory, 12);
    expect(usage!.disk).toBeCloseTo(600 * rates.disk, 12);
  });

  it("estimates CPU as every vCPU busy while commands run", async () => {
    const h = harness();

    h.launch();
    await h.ledger.seen();
    h.at(MINUTE);
    await h.ledger.busy(true);
    h.at(2 * MINUTE);

    expect(await h.ledger.read()).toMatchObject({ busy: true, until: null, cpuSeconds: 120 });

    h.at(3 * MINUTE);
    await h.ledger.busy(false);

    const usage = await h.ledger.read();

    expect(usage).toMatchObject({ busy: false, cpuSeconds: 240 });
    expect(usage!.cpu).toBeCloseTo(120 * containerRates("custom-2").cpu, 12);
  });

  it("ends a run when the Container is stopped, and keeps it across an eviction", async () => {
    const h = harness();

    h.launch();
    await h.ledger.seen();
    h.at(10 * MINUTE);
    h.die();
    await h.ledger.stopped();
    h.at(60 * MINUTE);

    const usage = await h.reopen().read();

    expect(usage).toMatchObject({ running: false, runSeconds: 600, until: null });
    expect(usage!.rates).toEqual({ memory: 0, disk: 0, cpu: 0 });
  });

  it("ends the run of a Container that went away on its own at its last sighting", async () => {
    const h = harness();

    h.launch();
    await h.ledger.seen();
    h.at(4 * MINUTE);
    await h.ledger.seen();
    h.at(20 * MINUTE);
    h.die();

    expect(await h.ledger.read()).toMatchObject({ running: false, runSeconds: 240 });
  });

  it("counts each launch as its own run, per size", async () => {
    const h = harness();

    h.launch("standard-2");
    await h.ledger.seen();
    h.at(10 * MINUTE);
    h.die();
    await h.ledger.stopped();
    h.at(30 * MINUTE);
    h.launch("custom-2");
    await h.ledger.seen();
    h.at(40 * MINUTE);

    const usage = await h.ledger.read();

    expect(usage).toMatchObject({ instance: "custom-2", runSeconds: 1200 });
    expect(usage!.memory).toBeCloseTo(
      600 * containerRates("standard-2").memory + 600 * containerRates("custom-2").memory,
      12,
    );
  });

  it("ends a run at the next launch's sighting when its stop was missed", async () => {
    const h = harness();

    h.launch();
    await h.ledger.seen();
    h.at(5 * MINUTE);
    await h.ledger.seen();
    h.at(10 * MINUTE);
    h.launch();
    h.at(11 * MINUTE);

    // The first run to its last sighting (5 min), the second from its launch (1 min).
    expect(await h.ledger.read()).toMatchObject({ runSeconds: 360 });
  });
});

describe("ContainerUsageLedger with analytics", () => {
  const sums = (cpuTimeSec: number): ContainerUsageSums => ({
    cpuTimeSec,
    allocatedMemory: 2 ** 30 * 100,
    allocatedDisk: 1e9 * 100,
    txBytes: 1e6,
  });

  it("asks from the first run to a few minutes ago, and estimates the time since", async () => {
    const h = harness({ analytics: async (windows) => windows.map(() => sums(42)) });

    h.launch();
    await h.ledger.seen();
    h.at(20 * MINUTE);

    // The first read only starts the question.
    expect(await h.ledger.read()).toMatchObject({ reportedThrough: null, runSeconds: 1200 });
    expect(h.asked).toEqual([
      { windows: [{ from: START, to: START + 20 * MINUTE - REPORT_LAG_MS }] },
    ]);

    await settle();

    const usage = await h.ledger.read();
    const rates = containerRates("custom-2");
    const since = REPORT_LAG_MS / 1000;

    expect(usage).toMatchObject({
      reportedThrough: START + 15 * MINUTE,
      runSeconds: 1200,
      cpuSeconds: 42,
      egressBytes: 1e6,
    });
    expect(usage!.memory).toBeCloseTo(100 * 0.0000025 + since * rates.memory, 12);
    expect(usage!.cpu).toBeCloseTo(42 * 0.00002, 12);
    expect(usage!.egress).toBeCloseTo(0.001 * 0.025, 12);
  });

  it("asks at most once a minute", async () => {
    const h = harness({ analytics: async (windows) => windows.map(() => sums(1)) });

    h.launch();
    await h.ledger.seen();
    h.at(20 * MINUTE);
    await h.ledger.read();
    await settle();
    h.at(20 * MINUTE + REFRESH_MS / 2);
    await h.ledger.read();

    expect(h.asked).toHaveLength(1);

    h.at(20 * MINUTE + REFRESH_MS);
    await h.ledger.read();

    expect(h.asked).toHaveLength(2);
  });

  it("settles what is over an hour old, and asks only for what is after it from then on", async () => {
    const h = harness({ analytics: async (windows) => windows.map(() => sums(10)) });

    h.launch();
    await h.ledger.seen();
    h.at(90 * MINUTE);
    await h.ledger.read();
    await settle();

    const settledTo = START + 90 * MINUTE - SETTLE_AFTER_MS;

    expect(h.asked[0]!.windows).toEqual([
      { from: START, to: settledTo },
      { from: settledTo, to: START + 90 * MINUTE - REPORT_LAG_MS },
    ]);
    expect(h.stored()?.reported?.settledThrough).toBe(settledTo);
    expect((await h.ledger.read())?.cpuSeconds).toBe(20);

    h.at(92 * MINUTE);
    await h.ledger.read();
    await settle();

    expect(h.asked[1]!.windows).toEqual([
      { from: settledTo, to: START + 32 * MINUTE },
      { from: START + 32 * MINUTE, to: START + 87 * MINUTE },
    ]);
    // Settled twice (10 + 10) and the fresh part once.
    expect((await h.ledger.read())?.cpuSeconds).toBe(30);
  });

  it("keeps estimating when the analytics fail, and warns once", async () => {
    const h = harness({
      analytics: async () => {
        throw new Error("403 Forbidden");
      },
    });

    h.launch();
    await h.ledger.seen();
    h.at(20 * MINUTE);
    await h.ledger.read();
    await settle();
    h.at(22 * MINUTE);
    await h.ledger.read();
    await settle();

    expect(h.warnings).toHaveLength(1);
    expect(await h.ledger.read()).toMatchObject({ reportedThrough: null, runSeconds: 1320 });
  });
});
