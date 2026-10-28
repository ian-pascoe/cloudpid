// The agent's Container resize (docs/architecture/container.md → Resize by the agent): refused above the size
// limit, a running Container snapshotted and stopped, and the size recorded for the next launch only.
// @effect-diagnostics asyncFunction:off
import {
  DEFAULT_CONTAINER_SETTINGS,
  type ContainerSettings,
  type InstanceType,
} from "@cloudpid/config";
import { describe, expect, it } from "vitest";
import { ContainerResizes } from "./resize.ts";
import type { SnapshotOutcome } from "./snapshots.ts";

type Fake = {
  settings: ContainerSettings;
  running: boolean;
  /** The size the running Container launched with. */
  launched: InstanceType | undefined;
  /** The size recorded for the next launch. */
  recorded: InstanceType | undefined;
  snapshot: SnapshotOutcome;
  /** What was done, in order. */
  events: string[];
};

const open = (
  settings: Partial<ContainerSettings> = {},
  running?: { readonly launched: InstanceType | undefined },
) => {
  const state: Fake = {
    settings: { ...DEFAULT_CONTAINER_SETTINGS, ...settings },
    running: running !== undefined,
    launched: running?.launched,
    recorded: undefined,
    snapshot: "taken",
    events: [],
  };

  const resizes = new ContainerResizes({
    settings: async () => state.settings,
    running: () => state.running,
    launched: async () => state.launched,
    load: async () => state.recorded,
    save: async (size) => {
      state.events.push(`record ${size}`);
      state.recorded = size;
    },
    clear: async () => {
      state.events.push("clear");
      state.recorded = undefined;
    },
    snapshot: async () => {
      state.events.push("snapshot");

      return state.snapshot;
    },
    stop: async () => {
      state.events.push("stop");
      state.running = false;
    },
    info: () => undefined,
  });

  return { state, resizes };
};

describe("a Container resize", () => {
  it("snapshots a running Container, records the size, then stops it", async () => {
    const { state, resizes } = open({}, { launched: "cpu-1" });

    expect(await resizes.resize("cpu-2")).toEqual({
      outcome: "resized",
      wasRunning: true,
      previous: "cpu-1",
      next: "cpu-2",
      environment: "cpu-1",
      snapshotted: true,
    });
    expect(state.events).toEqual(["snapshot", "record cpu-2", "stop"]);
    expect(await resizes.recorded()).toBe("cpu-2");
  });

  it("still stops the Container when the snapshot could not be taken, and says so", async () => {
    const { state, resizes } = open({}, { launched: "cpu-1" });

    state.snapshot = "failed";

    expect(await resizes.resize("cpu-2")).toMatchObject({
      outcome: "resized",
      wasRunning: true,
      snapshotted: false,
    });
    expect(state.events).toEqual(["snapshot", "record cpu-2", "stop"]);
  });

  it("refuses a size above the Environment's size limit, and stops and records nothing", async () => {
    const { state, resizes } = open({ maxInstance: "cpu-2" }, { launched: "cpu-1" });

    expect(await resizes.resize("standard-3")).toEqual({ outcome: "refused", limit: "cpu-2" });
    expect(state.events).toEqual([]);
    expect(state.running).toBe(true);
  });

  it("orders the sizes by memory, then vCPU: standard-2 fits under cpu-2, standard-1 does not under cpu-1", async () => {
    expect(await open({ maxInstance: "cpu-2" }).resizes.resize("standard-2")).toMatchObject({
      outcome: "resized",
    });
    expect(await open({ maxInstance: "cpu-1" }).resizes.resize("standard-1")).toEqual({
      outcome: "refused",
      limit: "cpu-1",
    });
  });

  it("puts cpu-3 (9 GiB) above the default limit and standard-3, and under a cpu-3 or standard-4 limit", async () => {
    expect(await open().resizes.resize("cpu-3")).toEqual({
      outcome: "refused",
      limit: "cpu-2",
    });
    expect(await open({ maxInstance: "standard-3" }).resizes.resize("cpu-3")).toEqual({
      outcome: "refused",
      limit: "standard-3",
    });

    for (const maxInstance of ["cpu-3", "standard-4"] as const) {
      expect(await open({ maxInstance }).resizes.resize("cpu-3")).toMatchObject({
        outcome: "resized",
        next: "cpu-3",
      });
    }
  });

  it("puts mem-4 above standard-1, mem-8 above cpu-2 and mem-12 above cpu-3, under the next standard size", async () => {
    expect(await open({ maxInstance: "standard-1" }).resizes.resize("mem-4")).toEqual({
      outcome: "refused",
      limit: "standard-1",
    });
    expect(await open({ maxInstance: "standard-2" }).resizes.resize("mem-4")).toMatchObject({
      outcome: "resized",
    });
    expect(await open().resizes.resize("mem-8")).toEqual({ outcome: "refused", limit: "cpu-2" });
    expect(await open({ maxInstance: "standard-3" }).resizes.resize("mem-8")).toMatchObject({
      outcome: "resized",
    });
    expect(await open({ maxInstance: "cpu-3" }).resizes.resize("mem-12")).toEqual({
      outcome: "refused",
      limit: "cpu-3",
    });
    expect(await open({ maxInstance: "standard-4" }).resizes.resize("mem-12")).toMatchObject({
      outcome: "resized",
    });
  });

  it("leaves a Container that already runs on the size running, keeping the size for a restart", async () => {
    const { state, resizes } = open({}, { launched: "cpu-2" });

    expect(await resizes.resize("cpu-2")).toEqual({ outcome: "unchanged", size: "cpu-2" });
    expect(state.events).toEqual(["record cpu-2"]);
    expect(state.running).toBe(true);
  });

  it("goes back to the Environment's size by forgetting the recorded one", async () => {
    const { state, resizes } = open({}, { launched: "cpu-2" });

    state.recorded = "cpu-2";

    expect(await resizes.resize("cpu-1")).toMatchObject({
      outcome: "resized",
      previous: "cpu-2",
      next: "cpu-1",
      environment: "cpu-1",
    });
    expect(state.events).toEqual(["snapshot", "clear", "stop"]);
    expect(await resizes.recorded()).toBeUndefined();
  });

  it("only records the size when no Container runs, from the size the next launch would have had", async () => {
    const { state, resizes } = open();

    expect(await resizes.resize("standard-2")).toEqual({
      outcome: "resized",
      wasRunning: false,
      previous: "cpu-1",
      next: "standard-2",
      environment: "cpu-1",
      snapshotted: false,
    });
    expect(state.events).toEqual(["record standard-2"]);

    expect(await resizes.resize("cpu-2")).toMatchObject({ previous: "standard-2" });
  });

  it("is forgotten when the idle stop stops a Container, and kept when its alarm finds none running", async () => {
    const { state, resizes } = open();

    await resizes.resize("cpu-2");
    await resizes.stopIdle();

    expect(await resizes.recorded()).toBe("cpu-2");

    // The next command started a Container on that size, which the idle stop then stops. The size is forgotten before
    // the stop, so a resize that lands while the Container is being destroyed is kept.
    state.running = true;
    state.events = [];
    await resizes.stopIdle();

    expect(state.running).toBe(false);
    expect(state.events).toEqual(["clear", "stop"]);
    expect(await resizes.recorded()).toBeUndefined();
  });

  it("is forgotten by the owner's restart, whatever runs", async () => {
    const { resizes } = open();

    await resizes.resize("cpu-2");
    await resizes.forget();

    expect(await resizes.recorded()).toBeUndefined();
  });
});
