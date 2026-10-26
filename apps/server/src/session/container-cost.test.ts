import type { ContainerUsage } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { sumContainerUsage } from "./container-cost.ts";

const usage = (overrides: Partial<ContainerUsage> = {}): ContainerUsage => ({
  instance: "cpu-2",
  runSeconds: 100,
  cpuSeconds: 10,
  egressBytes: 1000,
  memory: 1,
  disk: 0.5,
  cpu: 2,
  egress: 0.1,
  reportedThrough: 500,
  asOf: 10_000,
  running: false,
  busy: false,
  rates: { memory: 0, disk: 0, cpu: 0 },
  until: null,
  ...overrides,
});

describe("the cost of a Session's Containers, its Subagent Workspaces' included", () => {
  it("is the Session's Workspace's alone when it has no Subagent Workspace", () => {
    const own = usage();

    expect(sumContainerUsage([own])).toEqual(own);
    expect(sumContainerUsage([])).toBeNull();
  });

  it("names the size as it is now when a Workspace DO from before the rename reports an old name", () => {
    // SAFETY: what a Workspace DO still running the release before the rename answers over RPC.
    const old = usage({ instance: "custom-2" as ContainerUsage["instance"] });

    expect(sumContainerUsage([old])?.instance).toBe("cpu-2");
    expect(sumContainerUsage([old, usage({ instance: "mem-8" })])?.instance).toBe("cpu-2");
  });

  it("sums the amounts, and grows at the rates of the Containers that still run", () => {
    const summed = sumContainerUsage([
      usage({ instance: "cpu-1" }),
      usage({
        asOf: 8_000,
        running: true,
        busy: true,
        rates: { memory: 0.01, disk: 0.001, cpu: 0.1 },
        until: 60_000,
        reportedThrough: 300,
      }),
    ]);

    expect(summed).toMatchObject({
      instance: "cpu-1",
      asOf: 10_000,
      // The second ran 2 s more at its rates before the first's reading.
      runSeconds: 202,
      egressBytes: 2000,
      memory: 2.02,
      cpu: 4.2,
      reportedThrough: 300,
      running: true,
      busy: true,
      rates: { memory: 0.01, disk: 0.001, cpu: 0.1 },
      until: 60_000,
    });
    expect(summed?.disk).toBeCloseTo(1.002);
  });

  it("stops growing a Container past its idle stop", () => {
    const summed = sumContainerUsage([
      usage(),
      usage({ asOf: 5_000, running: true, rates: { memory: 1, disk: 0, cpu: 0 }, until: 6_000 }),
    ]);

    expect(summed).toMatchObject({ memory: 3, running: false, until: null });
  });
});
