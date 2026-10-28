// Each Container launch (docs/architecture/container.md → Container settings, Snapshots): the instance type, idle
// time and Container-only paths are the Workspace's settings at that moment, kept for as long as that Container runs; a
// snapshot of the image's Toolchains is restored when there is one, and a restore that does not come up falls back to
// the image.
// @effect-diagnostics asyncFunction:off newPromise:off preferEffectArray:off
import type { IWorkspaceContainerAPI } from "@cloudflare/computer/backends/container";
import {
  DEFAULT_CONTAINER_SETTINGS,
  type ContainerSettings,
  type InstanceType,
} from "@cloudpid/config";
import { describe, expect, it } from "vitest";
import type { EnvironmentBuild } from "./build-record.ts";
import type { ScanCoverage } from "./snapshots.ts";
import {
  ContainerLaunch,
  containerIgnore,
  currentLaunchRecord,
  type LaunchRecord,
  type StoredLaunchRecord,
} from "./launch.ts";

type Spec = Parameters<IWorkspaceContainerAPI["start"]>[0];

const SPEC: Spec = { env: { PORT: "8080" }, enableInternet: true, name: "WorkspaceContainer" };

/** The built-in Container-only paths of the fake: the Workspace's own come after them. */
const BUILT_IN = ["**/node_modules"];

/** A launch's spec, as computer's `ContainerBackend` builds it for the Container-only paths `ignore`. */
const specFor = (ignore: readonly string[]): Spec => ({
  ...SPEC,
  env: { ...SPEC.env, MOUNT_IGNORE: ignore.join(",") },
});

type Fake = {
  settings: ContainerSettings;
  /** The size the agent's resize recorded for the next launch, if any. */
  resized: InstanceType | undefined;
  running: boolean;
  /** What the platform answers `start` with. */
  outcome: "launched" | "adopted" | "relaunched";
  restorable: { id: string; image: string | undefined; covered?: ScanCoverage } | undefined;
  /** The image a launch would run now. */
  image: string | undefined;
  /** What `exitInfo` answers: the Container died, or null. */
  exit: { reason: string; exitedAt: number } | null;
  /** Makes `start` reject once for a snapshot. */
  rejectSnapshotStart: boolean;
  restores: number;
  takeImages: Array<string | undefined>;
  /** The Container-only paths each snapshot was labelled with. */
  takeIgnores: Array<readonly string[] | undefined>;
  /** What each snapshot's scan was told the unchanged files were shown clean of. */
  takeScanned: Array<ScanCoverage | undefined>;
  /** What a snapshot taken records its scan covered. */
  takeCovers: ScanCoverage | undefined;
  /** Holds a snapshot until released. */
  takeGate: Promise<void> | undefined;
  /** The Container-only paths each launch asked for a snapshot of. */
  restorableIgnores: Array<readonly string[] | undefined>;
  record: LaunchRecord | undefined;
  starts: Spec[];
  restarts: Spec[];
  forgotten: number;
  takes: string[];
  takeOutcome: "taken" | "skipped" | "failed";
  warnings: string[];
  infos: string[];
  now: number;
  /** The Environment's Build the Workspace was handed, if any. */
  build: EnvironmentBuild | undefined;
  /** The Build snapshots this Workspace will not try again. */
  failedBuilds: string[];
};

const DAY = 24 * 60 * 60_000;

const open = (
  settings: Partial<ContainerSettings> = {},
  labels?: Readonly<Record<string, string>>,
) => {
  const state: Fake = {
    settings: { ...DEFAULT_CONTAINER_SETTINGS, ...settings },
    resized: undefined,
    running: false,
    outcome: "launched",
    restorable: undefined,
    image: "img-1",
    exit: null,
    rejectSnapshotStart: false,
    restores: 0,
    takeImages: [],
    takeIgnores: [],
    takeScanned: [],
    takeCovers: undefined,
    takeGate: undefined,
    restorableIgnores: [],
    record: undefined,
    starts: [],
    restarts: [],
    forgotten: 0,
    takes: [],
    takeOutcome: "taken",
    warnings: [],
    infos: [],
    now: 9_000,
    build: undefined,
    failedBuilds: [],
  };

  const api: IWorkspaceContainerAPI = {
    start: async (spec: Spec) => {
      state.starts.push(spec);

      if (state.rejectSnapshotStart && spec.containerSnapshot !== undefined) {
        throw new Error("snapshot not found");
      }

      return { runtimeId: "r", clientSecret: "s", outcome: state.outcome };
    },
    restart: async (spec: Spec) => {
      state.restarts.push(spec);

      return { runtimeId: "r2", clientSecret: "s", outcome: "launched" as const };
    },
    status: async () => ({ running: state.running, exit: null }),
    exitInfo: async () => state.exit,
    interceptOutboundHttp: async () => undefined,
    interceptAllOutboundHttp: async () => undefined,
    setInactivityTimeout: async () => undefined,
    fetchPort: async () => {
      throw new Error("not used");
    },
    port: () => {
      throw new Error("not used");
    },
  };

  const make = () =>
    new ContainerLaunch({
      settings: async () => state.settings,
      resized: async () => state.resized,
      ignore: (settings) => [...BUILT_IN, ...settings.ignore],
      image: () => state.image,
      snapshots: {
        restorable: async (ignore) => {
          state.restorableIgnores.push(ignore);

          return state.restorable;
        },
        forget: async () => {
          state.forgotten++;
          state.restorable = undefined;
        },
        restored: async () => {
          state.restores++;
        },
        take: async (reason, image, ignore, scanned) => {
          state.takes.push(reason);
          state.takeImages.push(image);
          state.takeIgnores.push(ignore);
          state.takeScanned.push(scanned);
          await state.takeGate;

          return state.takeOutcome;
        },
        coverage: async () => state.takeCovers,
        capture: async (reason, image) => {
          state.takes.push(reason);
          state.takeImages.push(image);

          return state.takeOutcome === "taken"
            ? {
                outcome: "taken",
                id: "build-snap",
                size: 5,
                tookMs: 1,
                scope: "whole",
                covered: undefined,
              }
            : { outcome: state.takeOutcome, reason: "the platform refused" };
        },
      },
      builds: {
        current: async () =>
          state.build !== undefined && !state.failedBuilds.includes(state.build.snapshot.id)
            ? state.build
            : undefined,
        failed: async (id) => {
          state.failedBuilds.push(id);
        },
      },
      load: async () => state.record,
      save: async (record) => {
        state.record = record;
      },
      running: () => state.running,
      now: () => state.now,
      warn: (message) => state.warnings.push(message),
      info: (message) => state.infos.push(message),
      labels,
    });

  const launch = make();

  return { state, api, launch, make, container: launch.wrap(api) };
};

describe("a launch", () => {
  it("carries the Workspace's labels, on a start and on computer's restart", async () => {
    const { state, container } = open({}, { "cloudpid-ws": "abc" });

    await container.start({ ...SPEC, labels: { other: "1" } });
    await container.restart(SPEC);

    expect(state.starts[0]?.labels).toEqual({ other: "1", "cloudpid-ws": "abc" });
    expect(state.restarts[0]?.labels).toEqual({ "cloudpid-ws": "abc" });
  });

  it("adds no labels when the Workspace has none", async () => {
    const { state, container } = open();

    await container.start(SPEC);

    expect(state.starts[0]).not.toHaveProperty("labels");
  });

  it("starts on the instance type of the Workspace's settings", async () => {
    const { state, container } = open({ instance: "standard-4" });

    await container.start(SPEC);

    expect(state.starts[0]?.instance).toBe("standard-4");
    expect(state.starts[0]?.env).toEqual(SPEC.env);
  });

  it("starts a Workspace with no saved settings on the 1 vCPU / 3 GiB custom size, as resources", async () => {
    const { state, container } = open();

    await container.start(SPEC);

    expect(state.starts[0]?.instance).toEqual({ vcpu: 1, memoryMib: 3072, diskMb: 12_000 });
    expect(state.record?.instance).toBe("cpu-1");
  });

  it("keeps a Workspace that saved cpu-2, the former default, on it, as resources", async () => {
    const { state, container } = open({ instance: "cpu-2" });

    await container.start(SPEC);

    expect(state.starts[0]?.instance).toEqual({ vcpu: 2, memoryMib: 6144, diskMb: 12_000 });
    expect(state.record?.instance).toBe("cpu-2");
  });

  it("keeps a Workspace that saved standard-2 on it, as the named type", async () => {
    const { state, container } = open({ instance: "standard-2" });

    await container.start(SPEC);

    expect(state.starts[0]?.instance).toBe("standard-2");
    expect(state.record?.instance).toBe("standard-2");
  });

  it("does not relaunch a Container running on standard-2 when the default changed meanwhile", async () => {
    const { state, api, container, make } = open({ instance: "standard-2" });

    await container.start(SPEC);

    // The deploy moves the default and the Workspace's setting follows it (the saved one is dropped), while it runs.
    state.running = true;
    state.outcome = "adopted";
    state.settings = DEFAULT_CONTAINER_SETTINGS;
    await container.start(SPEC);

    // Neither the reconnect nor an evicted Workspace DO asks for anything but what the Container launched with.
    await make().wrap(api).start(SPEC);
    await container.restart(SPEC);

    expect(state.starts.map((spec) => spec.instance)).toEqual([
      "standard-2",
      "standard-2",
      "standard-2",
    ]);
    expect(state.restarts[0]?.instance).toBe("standard-2");
    expect(state.record?.instance).toBe("standard-2");
  });

  it("reads a launch record kept before the sizes were renamed under the new name", () => {
    const stored: StoredLaunchRecord = {
      instance: "custom-2",
      idleMinutes: 2,
      needsSnapshot: false,
      restoredFrom: undefined,
      image: "img-1",
      launchedAt: 1,
    };

    expect(currentLaunchRecord(stored)).toEqual({ ...stored, instance: "cpu-2" });
    expect(currentLaunchRecord({ ...stored, instance: "mem-8" })?.instance).toBe("mem-8");
    expect(currentLaunchRecord(undefined)).toBeUndefined();
  });

  it("adopts a Container launched on custom-2 before the rename with cpu-2's resources, so it is not relaunched", async () => {
    const { state, container } = open({ instance: "cpu-2" });

    state.record = currentLaunchRecord({
      instance: "custom-2",
      idleMinutes: 2,
      needsSnapshot: false,
      restoredFrom: undefined,
      image: "img-1",
      ignore: [...BUILT_IN],
      launchedAt: 1,
    });
    state.running = true;
    state.outcome = "adopted";
    await container.start(specFor(BUILT_IN));

    expect(state.starts[0]?.instance).toEqual({ vcpu: 2, memoryMib: 6144, diskMb: 12_000 });
    expect(state.record?.instance).toBe("cpu-2");
  });

  it("starts on a mem- size as its resources", async () => {
    const { state, container } = open({ instance: "mem-12", maxInstance: "mem-12" });

    await container.start(SPEC);

    expect(state.starts[0]?.instance).toEqual({ vcpu: 2, memoryMib: 12_288, diskMb: 12_000 });
    expect(state.record?.instance).toBe("mem-12");
  });

  it("restores a snapshot taken on standard-2 on the new default size", async () => {
    const { state, container } = open();

    state.restorable = { id: "snap-from-standard-2", image: "img-1" };
    await container.start(SPEC);

    expect(state.starts[0]?.containerSnapshot).toEqual({ id: "snap-from-standard-2" });
    expect(state.starts[0]?.instance).toEqual({ vcpu: 1, memoryMib: 3072, diskMb: 12_000 });
    expect(state.record?.restoredFrom).toBe("snap-from-standard-2");
  });

  it("uses the settings as they are at the launch: a change applies at the next one", async () => {
    const { state, container } = open({ instance: "basic" });

    await container.start(SPEC);
    state.running = false;
    state.settings = { ...state.settings, instance: "standard-3" };
    await container.start(SPEC);

    expect(state.starts.map((spec) => spec.instance)).toEqual(["basic", "standard-3"]);
  });

  it("restores the snapshot when there is one, and then needs none after the install", async () => {
    const { state, container } = open();

    state.restorable = { id: "snap-7", image: "img-1" };
    await container.start(SPEC);

    expect(state.starts[0]?.containerSnapshot).toEqual({ id: "snap-7" });
    expect(state.record?.needsSnapshot).toBe(false);
    expect(state.record?.restoredFrom).toBe("snap-7");
  });

  describe("what the files it has not changed since it started were shown clean of", () => {
    const COVERED: ScanCoverage = { at: 1_000, searched: ["digest-a"] };
    const OWN: ScanCoverage = { at: 2_000, searched: ["digest-b"] };

    it("is the restored snapshot's, which the scan before its next snapshot is given", async () => {
      const { state, container, launch } = open();

      state.restorable = { id: "snap-7", image: "img-1", covered: COVERED };
      await container.start(SPEC);

      expect(state.record?.scanned).toEqual(COVERED);

      state.running = true;
      state.takeCovers = OWN;
      await launch.snapshot("idle");

      expect(state.takeScanned).toEqual([COVERED]);
      // Then that snapshot's, for one after it.
      expect(state.record?.scanned).toEqual(OWN);
    });

    it("is nothing for a Container started from the image, until its first snapshot", async () => {
      const { state, container, launch } = open();

      await container.start(SPEC);
      state.running = true;
      state.takeCovers = OWN;
      await launch.afterInstall(true);

      expect(state.takeScanned).toEqual([undefined]);
      expect(state.record).toMatchObject({ scanned: OWN, needsSnapshot: false });

      await launch.snapshot("idle");

      expect(state.takeScanned).toEqual([undefined, OWN]);
    });

    it("is nothing for a Container started from the Environment's Build", async () => {
      const { state, container, launch } = open();

      state.build = build();
      await container.start(specFor(BUILT_IN));

      expect(state.record?.restoredFrom).toBe("build-1");
      expect(state.record?.scanned).toBeUndefined();

      state.running = true;
      await launch.afterInstall(true);

      expect(state.takeScanned).toEqual([undefined]);
    });

    it("is kept no longer than a snapshot that was not taken leaves it", async () => {
      const { state, container, launch } = open();

      state.restorable = { id: "snap-7", image: "img-1", covered: COVERED };
      await container.start(SPEC);
      state.running = true;
      state.takeOutcome = "skipped";
      state.takeCovers = OWN;
      await launch.snapshot("idle");

      expect(state.record?.scanned).toEqual(COVERED);
    });

    it("is kept for a Container adopted as it runs", async () => {
      const { state, container } = open();

      state.restorable = { id: "snap-7", image: "img-1", covered: COVERED };
      await container.start(SPEC);
      state.running = true;
      state.outcome = "adopted";
      await container.start(SPEC);

      expect(state.record?.scanned).toEqual(COVERED);
    });

    it("is nothing when the platform refuses the snapshot and the Container starts from the image", async () => {
      const { state, container } = open();

      state.restorable = { id: "snap-7", image: "img-1", covered: COVERED };
      state.rejectSnapshotStart = true;
      await container.start(SPEC);

      expect(state.record?.restoredFrom).toBeUndefined();
      expect(state.record?.scanned).toBeUndefined();
    });

    it("is not given to another Container launched while the snapshot was taken", async () => {
      const { state, container, launch } = open();

      await container.start(SPEC);
      state.running = true;

      let release: () => void = () => undefined;

      state.takeGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      state.takeCovers = OWN;

      const taking = launch.snapshot("idle");

      await Promise.resolve();

      // The Container dies meanwhile, and the next one starts from an older snapshot.
      state.running = false;
      state.now += 1;
      state.restorable = { id: "snap-old", image: "img-1", covered: COVERED };
      await container.start(SPEC);
      release();
      await taking;

      expect(state.record?.restoredFrom).toBe("snap-old");
      expect(state.record?.scanned).toEqual(COVERED);
    });

    it("is forgotten when computer restarts the Container from the image", async () => {
      const { state, container, launch } = open();

      await container.start(SPEC);
      state.running = true;
      state.takeCovers = OWN;
      await launch.afterInstall(true);

      expect(state.record?.scanned).toEqual(OWN);

      // A later restart (a health probe that failed) starts it from the image again.
      await container.restart(SPEC);

      expect(state.record?.scanned).toBeUndefined();

      // And so does one after a restore that did not come up.
      const restored = open();

      restored.state.restorable = { id: "snap-7", image: "img-1", covered: COVERED };
      await restored.container.start(SPEC);
      await restored.container.restart(SPEC);

      expect(restored.state.record?.scanned).toBeUndefined();
    });
  });

  it("starts from the image without a snapshot, and wants one after the install", async () => {
    const { state, container } = open();

    await container.start(SPEC);

    expect(state.starts[0]?.containerSnapshot).toBeUndefined();
    expect(state.record?.needsSnapshot).toBe(true);
  });

  it("keeps the instance type and idle time it launched with while that Container runs", async () => {
    const { state, container, launch } = open({ instance: "basic", idleMinutes: 5 });

    await container.start(SPEC);
    expect(await launch.idleMs()).toBe(5 * 60_000);

    // The owner changes the settings, and the Workspace DO reconnects to the Container that still runs.
    state.running = true;
    state.outcome = "adopted";
    state.settings = { ...state.settings, instance: "standard-4", idleMinutes: 60 };
    await container.start(SPEC);

    expect(state.starts[1]?.instance).toBe("basic");
    expect(await launch.idleMs()).toBe(5 * 60_000);
  });

  it("reads the idle time of a running Container from what it launched with, after an eviction", async () => {
    const { state, container, make } = open({ idleMinutes: 5 });

    await container.start(SPEC);
    state.running = true;

    const evicted = make();

    expect(await evicted.idleMs()).toBe(5 * 60_000);
  });

  it("applies the new idle time at the next launch", async () => {
    const { state, container, launch } = open({ idleMinutes: 5 });

    await container.start(SPEC);
    state.running = false;
    state.settings = { ...state.settings, idleMinutes: 90 };
    await container.start(SPEC);

    expect(await launch.idleMs()).toBe(90 * 60_000);
  });

  it("falls back to the default idle time before any launch", async () => {
    const { launch } = open();

    expect(await launch.idleMs()).toBe(DEFAULT_CONTAINER_SETTINGS.idleMinutes * 60_000);
  });

  it("starts a Container found running with no launch on record on standard-2, so it is adopted", async () => {
    const { state, container } = open({ instance: "standard-4" });

    state.running = true;
    state.outcome = "adopted";
    await container.start(SPEC);

    // standard-2 was every Workspace's default when launches began to be recorded; today's default would relaunch it.
    expect(state.starts[0]?.instance).toBe("standard-2");
    expect(state.record?.instance).toBe("standard-2");
    expect(state.record?.needsSnapshot).toBe(false);
  });
});

describe("a launch after the agent's resize", () => {
  it("starts on the size the resize recorded instead of the settings', and records it", async () => {
    const { state, container } = open({ instance: "cpu-1" });

    state.resized = "cpu-2";
    state.restorable = { id: "snap-resize", image: "img-1" };
    await container.start(SPEC);

    expect(state.starts[0]?.instance).toEqual({ vcpu: 2, memoryMib: 6144, diskMb: 12_000 });
    expect(state.starts[0]?.containerSnapshot).toEqual({ id: "snap-resize" });
    expect(state.record?.instance).toBe("cpu-2");
  });

  it("keeps the size the running Container launched with on a reconnect, whatever was recorded since", async () => {
    const { state, container } = open({ instance: "cpu-1" });

    await container.start(SPEC);
    state.running = true;
    state.outcome = "adopted";
    state.resized = "cpu-2";
    await container.start(SPEC);

    expect(state.starts[1]?.instance).toEqual({ vcpu: 1, memoryMib: 3072, diskMb: 12_000 });
  });

  it("uses the recorded size for computer's restart of a launch with no record", async () => {
    const { state, container } = open({ instance: "cpu-1" });

    state.resized = "standard-3";
    state.settings = { ...state.settings, maxInstance: "standard-4" };
    await container.restart(SPEC);

    expect(state.restarts[0]?.instance).toBe("standard-3");
  });

  it("ignores a recorded size above the size limit the settings have now", async () => {
    const { state, container } = open({ instance: "cpu-1", maxInstance: "cpu-1" });

    state.resized = "cpu-2";
    await container.start(SPEC);

    expect(state.record?.instance).toBe("cpu-1");
  });
});

describe("containerIgnore", () => {
  it("is the built-in paths, then the Workspace's own", () => {
    expect(containerIgnore(["**/node_modules", "**/.cache"], ["/data"])).toEqual([
      "**/node_modules",
      "**/.cache",
      "/data",
    ]);
  });

  it("keeps only the last of a pattern given twice, which decides what it matches (the last match wins)", () => {
    expect(
      containerIgnore(["**/node_modules", "**/.cache"], ["!**/node_modules", "**/node_modules"]),
    ).toEqual(["**/.cache", "!**/node_modules", "**/node_modules"]);
  });
});

describe("the Container-only paths of a launch", () => {
  it("are the built-in ones and then the Workspace's, as its settings are when it launches", async () => {
    const { launch } = open({ ignore: ["/data"] });

    expect(await launch.ignore()).toEqual(["**/node_modules", "/data"]);
  });

  it("are what the running Container launched with, whatever the settings say now, after an eviction too", async () => {
    const { state, container, launch, make } = open({ ignore: ["/data"] });

    await container.start(specFor((await launch.ignore()) ?? []));
    state.running = true;
    state.settings = { ...state.settings, ignore: ["/other"] };

    expect(await launch.ignore()).toEqual(["**/node_modules", "/data"]);
    expect(await make().ignore()).toEqual(["**/node_modules", "/data"]);

    state.running = false;

    expect(await launch.ignore()).toEqual(["**/node_modules", "/other"]);
  });

  it("are the built-in ones for a Container found running with no launch on record", async () => {
    const { state, launch } = open({ ignore: ["/data"] });

    state.running = true;

    expect(await launch.ignore()).toEqual(["**/node_modules"]);
  });

  it("restore only a snapshot taken with the same paths, and label the next one with them", async () => {
    const { state, container, launch } = open({ ignore: ["/data"] });

    await container.start(specFor(["**/node_modules", "/data"]));
    state.running = true;
    await launch.snapshot("idle");

    expect(state.restorableIgnores).toEqual([["**/node_modules", "/data"]]);
    expect(state.takeIgnores).toEqual([["**/node_modules", "/data"]]);
  });

  it("are none where the launch has none (the local Container, which cannot keep any)", async () => {
    const { state, container, launch } = open();

    await container.start(SPEC);
    state.running = true;
    await launch.snapshot("idle");

    expect(state.restorableIgnores).toEqual([undefined]);
    expect(state.takeIgnores).toEqual([undefined]);
  });
});

describe("a restart with no launch on record", () => {
  it("keeps a running Container on standard-2, the default when launches began to be recorded", async () => {
    const { state, container } = open();

    state.running = true;
    await container.restart(SPEC);

    expect(state.restarts[0]?.instance).toBe("standard-2");
  });

  it("uses the Workspace's settings when nothing runs", async () => {
    const { state, container } = open({ instance: "standard-3" });

    await container.restart(SPEC);

    expect(state.restarts[0]?.instance).toBe("standard-3");
  });
});

describe("a restart after the Container did not come up", () => {
  it("starts it from the image again, on the same instance, and forgets the snapshot of a Container that died", async () => {
    const { state, container } = open({ instance: "standard-3" });

    state.restorable = { id: "snap-bad", image: "img-1" };
    await container.start(SPEC);
    state.exit = { reason: "exited with 1", exitedAt: 1 };
    await container.restart(SPEC);

    expect(state.restarts[0]?.instance).toBe("standard-3");
    expect(state.restarts[0]?.containerSnapshot).toBeUndefined();
    expect(state.forgotten).toBe(1);
    expect(state.record?.needsSnapshot).toBe(true);
    expect(state.warnings.join("\n")).toContain("snap-bad");
  });

  it("keeps the snapshot of a Container that was only slow to answer, and still starts from the image", async () => {
    const { state, container } = open();

    state.restorable = { id: "snap-slow", image: "img-1" };
    await container.start(SPEC);
    await container.restart(SPEC);

    expect(state.restarts[0]?.containerSnapshot).toBeUndefined();
    expect(state.forgotten).toBe(0);
    expect(state.record?.needsSnapshot).toBe(true);
    expect(state.record?.restoredFrom).toBeUndefined();
  });

  it("forgets nothing when the first start was from the image", async () => {
    const { state, container } = open();

    await container.start(SPEC);
    await container.restart(SPEC);

    expect(state.forgotten).toBe(0);
    expect(state.restarts[0]?.containerSnapshot).toBeUndefined();
  });
});

/** An Environment's Build taken on image `img-1` with the fake's built-in paths and none of the Environment's own. */
const build = (overrides: Partial<EnvironmentBuild> = {}): EnvironmentBuild => ({
  key: "k1",
  snapshot: { id: "build-1", size: 1e9 },
  image: "img-1",
  ignore: BUILT_IN,
  commits: { app: "abc" },
  finishedAt: 9_000,
  ...overrides,
});

describe("a launch from the Environment's Build", () => {
  it("starts a Workspace with no snapshot of its own from its Environment's Build, with computerd's store reset", async () => {
    const { state, container } = open();

    state.build = build();
    await container.start(specFor(BUILT_IN));

    expect(state.starts[0]?.containerSnapshot).toEqual({ id: "build-1" });
    expect(state.starts[0]?.env).toEqual({
      ...specFor(BUILT_IN).env,
      CLOUDPID_RESET_STORE: "1",
    });
    // Its own install snapshot is still taken, labelled with the Build's image.
    expect(state.record).toMatchObject({
      needsSnapshot: true,
      restoredFrom: "build-1",
      image: "img-1",
      resetStore: true,
    });
    // The Workspace's own snapshot's lifetime is not the Build's.
    expect(state.restores).toBe(0);
    // The log says what it started from.
    expect(state.infos).toContainEqual(
      expect.stringContaining("Build build-1, with computerd's store reset"),
    );
  });

  it("prefers the Workspace's own snapshot, which has its files", async () => {
    const { state, container } = open();

    state.build = build();
    state.restorable = { id: "own", image: "img-1" };
    await container.start(specFor(BUILT_IN));

    expect(state.starts[0]?.containerSnapshot).toEqual({ id: "own" });
    expect(state.starts[0]?.env).toEqual(specFor(BUILT_IN).env);
  });

  it("starts from the image when the Build is of another image, other paths, or near the end of its lifetime", async () => {
    for (const stale of [
      build({ image: "img-0" }),
      build({ ignore: [...BUILT_IN, "/data"] }),
      build({ ignore: null }),
      build({ finishedAt: 9_000 - 29.5 * DAY }),
    ]) {
      const { state, container } = open();

      state.build = stale;
      await container.start(specFor(BUILT_IN));

      expect(state.starts[0]?.containerSnapshot).toBeUndefined();
      expect(state.starts[0]?.env).toEqual(specFor(BUILT_IN).env);
      expect(state.record?.resetStore).toBeFalsy();
      expect(state.infos).toContainEqual(expect.stringContaining("build-1 is not used"));
      expect(state.infos).toContainEqual(expect.stringContaining("from the image"));
    }
  });

  it("asks for the store reset again when it reconnects to the Container that started from the Build, so it is adopted", async () => {
    const { state, api, container, make } = open();

    state.build = build();
    await container.start(specFor(BUILT_IN));
    state.running = true;
    state.outcome = "adopted";
    await container.start(specFor(BUILT_IN));
    await make().wrap(api).start(specFor(BUILT_IN));

    expect(state.starts.map((spec) => spec.env?.["CLOUDPID_RESET_STORE"])).toEqual(["1", "1", "1"]);
    expect(state.starts[1]?.containerSnapshot).toBeUndefined();
  });

  it("falls back to the image when the platform refuses the Build, and does not try that Build again", async () => {
    const { state, container } = open();

    state.build = build();
    state.rejectSnapshotStart = true;
    await container.start(specFor(BUILT_IN));

    expect(state.starts).toHaveLength(2);
    expect(state.starts[1]?.containerSnapshot).toBeUndefined();
    expect(state.starts[1]?.env).toEqual(specFor(BUILT_IN).env);
    expect(state.failedBuilds).toEqual(["build-1"]);
    expect(state.forgotten).toBe(0);
    expect(state.record).toMatchObject({ needsSnapshot: true, image: "img-1" });
    expect(state.record?.resetStore).toBeFalsy();
    expect(state.warnings.join("\n")).toContain("build-1");

    state.running = false;
    state.rejectSnapshotStart = false;
    await container.start(specFor(BUILT_IN));

    expect(state.starts[2]?.containerSnapshot).toBeUndefined();
  });

  it("falls back to the image when the Container started from the Build does not come up, and does not try that Build again", async () => {
    const { state, container } = open();

    state.build = build();
    await container.start(specFor(BUILT_IN));
    await container.restart(specFor(BUILT_IN));

    expect(state.restarts[0]?.containerSnapshot).toBeUndefined();
    expect(state.restarts[0]?.env).toEqual(specFor(BUILT_IN).env);
    expect(state.failedBuilds).toEqual(["build-1"]);
    expect(state.forgotten).toBe(0);
    expect(state.record).toMatchObject({ needsSnapshot: true, image: "img-1" });
    expect(state.record?.restoredFrom).toBeUndefined();
    expect(state.record?.resetStore).toBeFalsy();
  });
});

describe("a Build's snapshot", () => {
  it("is labelled with the image and Container-only paths the Container launched with, and not kept as the Workspace's", async () => {
    const { state, container, launch } = open();

    await container.start(specFor(BUILT_IN));

    expect(await launch.captureBuild()).toEqual({
      ok: true,
      snapshot: { id: "build-snap", size: 5 },
      image: "img-1",
      ignore: BUILT_IN,
    });
    expect(state.takes).toEqual(["build"]);

    state.takeOutcome = "failed";

    expect(await launch.captureBuild()).toEqual({ ok: false, reason: "the platform refused" });
  });
});

describe("a start the platform rejects for the snapshot", () => {
  it("is retried once from the image, and the snapshot is forgotten", async () => {
    const { state, container } = open({ instance: "standard-3" });

    state.restorable = { id: "snap-gone", image: "img-1" };
    state.rejectSnapshotStart = true;

    await container.start(SPEC);

    expect(state.starts).toHaveLength(2);
    expect(state.starts[1]?.containerSnapshot).toBeUndefined();
    expect(state.starts[1]?.instance).toBe("standard-3");
    expect(state.forgotten).toBe(1);
    expect(state.record).toMatchObject({ needsSnapshot: true, image: "img-1" });
    expect(state.record?.restoredFrom).toBeUndefined();
    expect(state.warnings.join("\n")).toContain("snap-gone");
  });

  it("is not retried when it was a start from the image that was rejected", async () => {
    const { state, api } = open();

    api.start = async () => {
      throw new Error("no capacity");
    };

    await expect(
      new ContainerLaunch({
        settings: async () => state.settings,
        resized: async () => undefined,
        ignore: () => undefined,
        image: () => state.image,
        snapshots: {
          restorable: async () => undefined,
          restored: async () => undefined,
          coverage: async () => undefined,
          forget: async () => undefined,
          take: async () => "taken",
          capture: async () => ({ outcome: "skipped", reason: "not used" }),
        },
        load: async () => undefined,
        save: async () => undefined,
        running: () => false,
        now: () => 1,
        warn: () => undefined,
        info: () => undefined,
      })
        .wrap(api)
        .start(SPEC),
    ).rejects.toThrow("no capacity");
  });
});

describe("the image a Container runs", () => {
  it("is the deployed one for a launch from the image", async () => {
    const { state, container } = open();

    await container.start(SPEC);

    expect(state.record?.image).toBe("img-1");
  });

  it("is the snapshot's for a restore, and the restore begins the snapshot's lifetime again", async () => {
    const { state, container } = open();

    state.restorable = { id: "snap-1", image: "img-1" };
    await container.start(SPEC);

    expect(state.record?.image).toBe("img-1");
    expect(state.restores).toBe(1);
  });

  it("is the deployed one again after a restart from the image", async () => {
    const { state, container } = open();

    state.restorable = { id: "snap-1", image: "img-1" };
    await container.start(SPEC);
    state.image = "img-2";
    await container.restart(SPEC);

    expect(state.record?.image).toBe("img-2");
  });

  it("is what a snapshot of a Container that outlived a deploy is labelled with, not the deployed image", async () => {
    const { state, container, make } = open();

    await container.start(SPEC);
    state.running = true;
    // A deploy changed the image; the Container is still on img-1.
    state.image = "img-2";

    await make().snapshot("idle");

    expect(state.takeImages).toEqual(["img-1"]);
  });

  it("is not known for a Container found running with no launch on record, which gets no snapshot", async () => {
    const { state, container, launch } = open();

    state.running = true;
    state.outcome = "adopted";
    await container.start(SPEC);

    expect(await launch.snapshot("idle")).toBe("skipped");
    expect(state.takes).toEqual([]);
  });
});

describe("afterInstall", () => {
  it("snapshots a Container that was started from the image when the bootstrap installed something", async () => {
    const { state, container, launch } = open();

    await container.start(SPEC);
    await launch.afterInstall(true);

    expect(state.takes).toEqual(["install"]);
    expect(state.record?.needsSnapshot).toBe(false);
  });

  it("skips the snapshot when the bootstrap installed nothing, leaving the Container to the idle stop's", async () => {
    const { state, container, launch } = open();

    await container.start(SPEC);
    await launch.afterInstall(false);

    expect(state.takes).toEqual([]);
    expect(state.infos.join("\n")).toContain("installed nothing");
  });

  it("does not snapshot again for the same Container", async () => {
    const { state, container, launch } = open();

    await container.start(SPEC);
    await launch.afterInstall(true);
    await launch.afterInstall(true);

    expect(state.takes).toEqual(["install"]);
  });

  it("leaves a Container restored from a snapshot to the idle stop's", async () => {
    const { state, container, launch } = open();

    state.restorable = { id: "snap-1", image: "img-1" };
    await container.start(SPEC);
    await launch.afterInstall(true);

    expect(state.takes).toEqual([]);
  });

  it("tries again after the next install when the snapshot was not taken, though that one installs nothing", async () => {
    const { state, container, launch } = open();

    await container.start(SPEC);
    state.takeOutcome = "failed";
    await launch.afterInstall(true);

    expect(state.record?.needsSnapshot).toBe(true);

    // The next bootstrap in the same Container (after an eviction) finds the Toolchains the first one installed.
    state.takeOutcome = "taken";
    await launch.afterInstall(false);

    expect(state.takes).toEqual(["install", "install"]);
    expect(state.record?.needsSnapshot).toBe(false);
  });

  it("finds the launch on record after an eviction", async () => {
    const { state, container, make } = open();

    await container.start(SPEC);
    state.running = true;

    await make().afterInstall(true);

    expect(state.takes).toEqual(["install"]);
  });
});
