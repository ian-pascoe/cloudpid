// The agent's Container resize (docs/spec.md → Container and Toolchains → Resize by the agent): refused above the size
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
    const { state, resizes } = open({}, { launched: "custom-1" });

    expect(await resizes.resize("custom-2")).toEqual({
      outcome: "resized",
      wasRunning: true,
      previous: "custom-1",
      next: "custom-2",
      environment: "custom-1",
      snapshotted: true,
    });
    expect(state.events).toEqual(["snapshot", "record custom-2", "stop"]);
    expect(await resizes.recorded()).toBe("custom-2");
  });

  it("still stops the Container when the snapshot could not be taken, and says so", async () => {
    const { state, resizes } = open({}, { launched: "custom-1" });

    state.snapshot = "failed";

    expect(await resizes.resize("custom-2")).toMatchObject({
      outcome: "resized",
      wasRunning: true,
      snapshotted: false,
    });
    expect(state.events).toEqual(["snapshot", "record custom-2", "stop"]);
  });

  it("refuses a size above the Environment's size limit, and stops and records nothing", async () => {
    const { state, resizes } = open({ maxInstance: "custom-2" }, { launched: "custom-1" });

    expect(await resizes.resize("standard-3")).toEqual({ outcome: "refused", limit: "custom-2" });
    expect(state.events).toEqual([]);
    expect(state.running).toBe(true);
  });

  it("orders the sizes by memory, then vCPU: standard-2 fits under custom-2, standard-1 does not under custom-1", async () => {
    expect(await open({ maxInstance: "custom-2" }).resizes.resize("standard-2")).toMatchObject({
      outcome: "resized",
    });
    expect(await open({ maxInstance: "custom-1" }).resizes.resize("standard-1")).toEqual({
      outcome: "refused",
      limit: "custom-1",
    });
  });

  it("puts custom-3 (9 GiB) above the default limit and standard-3, and under a custom-3 or standard-4 limit", async () => {
    expect(await open().resizes.resize("custom-3")).toEqual({
      outcome: "refused",
      limit: "custom-2",
    });
    expect(await open({ maxInstance: "standard-3" }).resizes.resize("custom-3")).toEqual({
      outcome: "refused",
      limit: "standard-3",
    });

    for (const maxInstance of ["custom-3", "standard-4"] as const) {
      expect(await open({ maxInstance }).resizes.resize("custom-3")).toMatchObject({
        outcome: "resized",
        next: "custom-3",
      });
    }
  });

  it("leaves a Container that already runs on the size running, keeping the size for a restart", async () => {
    const { state, resizes } = open({}, { launched: "custom-2" });

    expect(await resizes.resize("custom-2")).toEqual({ outcome: "unchanged", size: "custom-2" });
    expect(state.events).toEqual(["record custom-2"]);
    expect(state.running).toBe(true);
  });

  it("goes back to the Environment's size by forgetting the recorded one", async () => {
    const { state, resizes } = open({}, { launched: "custom-2" });

    state.recorded = "custom-2";

    expect(await resizes.resize("custom-1")).toMatchObject({
      outcome: "resized",
      previous: "custom-2",
      next: "custom-1",
      environment: "custom-1",
    });
    expect(state.events).toEqual(["snapshot", "clear", "stop"]);
    expect(await resizes.recorded()).toBeUndefined();
  });

  it("only records the size when no Container runs, from the size the next launch would have had", async () => {
    const { state, resizes } = open();

    expect(await resizes.resize("standard-2")).toEqual({
      outcome: "resized",
      wasRunning: false,
      previous: "custom-1",
      next: "standard-2",
      environment: "custom-1",
      snapshotted: false,
    });
    expect(state.events).toEqual(["record standard-2"]);

    expect(await resizes.resize("custom-2")).toMatchObject({ previous: "standard-2" });
  });

  it("is forgotten when the idle stop stops a Container, and kept when its alarm finds none running", async () => {
    const { state, resizes } = open();

    await resizes.resize("custom-2");
    await resizes.stopIdle();

    expect(await resizes.recorded()).toBe("custom-2");

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

    await resizes.resize("custom-2");
    await resizes.forget();

    expect(await resizes.recorded()).toBeUndefined();
  });
});
