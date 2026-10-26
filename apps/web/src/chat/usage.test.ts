import type { ContainerUsage, ContextUsage, SessionUsage } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { contextLevel, contextPercent, liveContainerUsage, totalSpend } from "./usage.ts";

const context = (tokens: number, compactAt: number | null = 160_000): ContextUsage => ({
  tokens,
  contextWindow: 200_000,
  compactAt,
  parts: { system: 0, user: tokens, assistant: 0, tools: 0 },
});

describe("how full the context is", () => {
  it("is the share of the window used, whole and within 0 to 100", () => {
    expect(contextPercent(context(0))).toBe(0);
    expect(contextPercent(context(50_000))).toBe(25);
    expect(contextPercent(context(1_001))).toBe(1);
    expect(contextPercent(context(250_000))).toBe(100);
    expect(contextPercent({ ...context(10), contextWindow: 0 })).toBe(0);
  });

  it("is near from 85% of where compaction starts, and full at it", () => {
    expect(contextLevel(context(100_000))).toBe("ok");
    expect(contextLevel(context(136_000))).toBe("near");
    expect(contextLevel(context(160_000))).toBe("full");
  });

  it("is measured against the window when automatic compaction is off", () => {
    expect(contextLevel(context(160_000, null))).toBe("ok");
    expect(contextLevel(context(170_000, null))).toBe("near");
    expect(contextLevel(context(200_000, null))).toBe("full");
  });
});

const AS_OF = 1_700_000_000_000;

const container = (fields: Partial<ContainerUsage> = {}): ContainerUsage => ({
  instance: "cpu-2",
  runSeconds: 600,
  cpuSeconds: 30,
  egressBytes: 1_000_000,
  memory: 0.01,
  disk: 0.001,
  cpu: 0.002,
  egress: 0.0001,
  reportedThrough: AS_OF - 300_000,
  asOf: AS_OF,
  running: true,
  busy: false,
  rates: { memory: 0.00001, disk: 0.000001, cpu: 0.00004 },
  until: AS_OF + 60_000,
  ...fields,
});

describe("liveContainerUsage", () => {
  it("adds memory and disk for the time a running Container has run since its reading", () => {
    const live = liveContainerUsage(container(), AS_OF + 10_000);

    expect(live.memory).toBeCloseTo(0.01 + 10 * 0.00001, 12);
    expect(live.disk).toBeCloseTo(0.001 + 10 * 0.000001, 12);
    expect(live.cpu).toBe(0.002);
    expect(live.runSeconds).toBe(610);
    expect(live.total).toBeCloseTo(live.memory + live.disk + live.cpu + 0.0001, 12);
    expect(live.growing).toBe(true);
  });

  it("stops at the idle stop", () => {
    const live = liveContainerUsage(container(), AS_OF + 120_000);

    expect(live.runSeconds).toBe(660);
    expect(live.growing).toBe(false);
  });

  it("adds every vCPU while a command runs, with no idle stop in sight", () => {
    const live = liveContainerUsage(container({ busy: true, until: null }), AS_OF + 10_000);

    expect(live.cpu).toBeCloseTo(0.002 + 10 * 0.00004, 12);
    expect(live.cpuSeconds).toBe(30 + 10 * 2);
    expect(live.growing).toBe(true);
  });

  it("adds nothing once no Container runs", () => {
    const stopped = container({ running: false, until: null });
    const live = liveContainerUsage(stopped, AS_OF + 600_000);

    expect(live.runSeconds).toBe(600);
    expect(live.total).toBeCloseTo(0.01 + 0.001 + 0.002 + 0.0001, 12);
    expect(live.growing).toBe(false);
  });
});

describe("totalSpend", () => {
  const usage: SessionUsage = {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: 0.5,
    limit: null,
  };

  it("is the models' cost without a Container", () => {
    expect(totalSpend(usage, AS_OF)).toBe(0.5);
  });

  it("adds the Containers' cost at the moment", () => {
    expect(totalSpend({ ...usage, container: container({ running: false }) }, AS_OF)).toBeCloseTo(
      0.5 + 0.0131,
      12,
    );
  });
});
