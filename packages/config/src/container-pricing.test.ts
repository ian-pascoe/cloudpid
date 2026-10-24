import { describe, expect, it } from "vitest";
import { containerRates, INSTANCE_RESOURCES, usageSumsCost } from "./container-pricing.ts";
import { containerInstance } from "./container-settings.ts";

describe("INSTANCE_RESOURCES", () => {
  it("has the resources containerInstance starts a custom size with", () => {
    expect(INSTANCE_RESOURCES["custom-1"]).toEqual(containerInstance("custom-1"));
    expect(INSTANCE_RESOURCES["custom-2"]).toEqual(containerInstance("custom-2"));
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
  it("prices custom-2's memory and disk at about 5.5 cents a running hour, its CPU at 14.4 cents a busy hour", () => {
    const rates = containerRates("custom-2");

    expect((rates.memory + rates.disk) * 3600).toBeCloseTo(0.05702, 5);
    expect(rates.cpu * 3600).toBeCloseTo(0.144, 5);
  });

  it("prices custom-1's memory and disk at 3 cents a running hour, about half of custom-2's, its CPU at 7.2 cents a busy hour", () => {
    const rates = containerRates("custom-1");

    expect((rates.memory + rates.disk) * 3600).toBeCloseTo(0.03002, 5);
    expect(rates.cpu * 3600).toBeCloseTo(0.072, 5);
    expect(rates.memory).toBe(containerRates("custom-2").memory / 2);
  });

  it("prices standard-2's memory as custom-2's, with half its CPU", () => {
    expect(containerRates("standard-2").memory).toBe(containerRates("custom-2").memory);
    expect(containerRates("standard-2").cpu).toBe(containerRates("custom-2").cpu / 2);
  });
});
