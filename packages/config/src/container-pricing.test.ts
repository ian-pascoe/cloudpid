import { describe, expect, it } from "vitest";
import { containerRates, usageSumsCost } from "./container-pricing.ts";
import { containerInstance, INSTANCE_RESOURCES } from "./container-settings.ts";

describe("INSTANCE_RESOURCES", () => {
  it("has the resources containerInstance starts a custom size with", () => {
    for (const type of ["cpu-1", "cpu-2", "cpu-3", "mem-4", "mem-8", "mem-12"] as const) {
      expect(INSTANCE_RESOURCES[type]).toEqual(containerInstance(type));
    }
  });
});

describe("usageSumsCost", () => {
  it("prices memory per GiB-second, disk per GB-second, CPU per second and egress per GB", () => {
    const cost = usageSumsCost({
      allocatedMemory: 2 ** 30 * 1000,
      allocatedDisk: 1e9 * 1000,
      cpuTimeSec: 1000,
      txBytes: 1e9,
    });

    expect(cost.memory).toBeCloseTo(0.0025, 10);
    expect(cost.disk).toBeCloseTo(0.00007, 10);
    expect(cost.cpu).toBeCloseTo(0.02, 10);
    expect(cost.egress).toBeCloseTo(0.025, 10);
  });
});

describe("containerRates", () => {
  it("prices cpu-2's memory and disk at about 5.5 cents a running hour, its CPU at 14.4 cents a busy hour", () => {
    const rates = containerRates("cpu-2");

    expect((rates.memory + rates.disk) * 3600).toBeCloseTo(0.05702, 5);
    expect(rates.cpu * 3600).toBeCloseTo(0.144, 5);
  });

  it("prices cpu-1's memory and disk at 3 cents a running hour, about half of cpu-2's, its CPU at 7.2 cents a busy hour", () => {
    const rates = containerRates("cpu-1");

    expect((rates.memory + rates.disk) * 3600).toBeCloseTo(0.03002, 5);
    expect(rates.cpu * 3600).toBeCloseTo(0.072, 5);
    expect(rates.memory).toBe(containerRates("cpu-2").memory / 2);
  });

  it("prices cpu-3's memory and disk at about 8.4 cents a running hour, its CPU at 21.6 cents a busy hour", () => {
    const rates = containerRates("cpu-3");

    expect((rates.memory + rates.disk) * 3600).toBeCloseTo(0.08402, 5);
    expect(rates.cpu * 3600).toBeCloseTo(0.216, 5);
    expect(rates.memory).toBeCloseTo(containerRates("cpu-1").memory * 3, 12);
  });

  it.each([
    ["mem-4", 0.03902, 0.072],
    ["mem-8", 0.07502, 0.072],
    ["mem-12", 0.11102, 0.144],
  ] as const)(
    "prices %s's memory and disk at %d a running hour, its CPU at %d a busy hour",
    (type, running, busy) => {
      const rates = containerRates(type);

      expect((rates.memory + rates.disk) * 3600).toBeCloseTo(running, 5);
      expect(rates.cpu * 3600).toBeCloseTo(busy, 5);
    },
  );

  it("prices mem-12's memory as standard-4's, with half its CPU", () => {
    expect(containerRates("mem-12").memory).toBe(containerRates("standard-4").memory);
    expect(containerRates("mem-12").cpu).toBe(containerRates("standard-4").cpu / 2);
  });

  it("prices standard-2's memory as cpu-2's, with half its CPU", () => {
    expect(containerRates("standard-2").memory).toBe(containerRates("cpu-2").memory);
    expect(containerRates("standard-2").cpu).toBe(containerRates("cpu-2").cpu / 2);
  });
});
