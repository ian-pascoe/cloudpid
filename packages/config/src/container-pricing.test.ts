import { describe, expect, it } from "vitest";
import { containerRates, usageSumsCost } from "./container-pricing.ts";

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

  it("prices mem-12's memory as standard-4's, with half its CPU", () => {
    expect(containerRates("mem-12").memory).toBe(containerRates("standard-4").memory);
    expect(containerRates("mem-12").cpu).toBe(containerRates("standard-4").cpu / 2);
  });
});
