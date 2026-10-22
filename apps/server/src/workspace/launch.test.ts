// Each Container launch (docs/spec.md → Container and Toolchains → Size and idle, Snapshots): the instance type, idle
// time and Container-only paths are the Workspace's settings at that moment, kept for as long as that Container runs; a
// snapshot of the image's Toolchains is restored when there is one, and a restore that does not come up falls back to
// the image.
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import type { IWorkspaceContainerAPI } from "@cloudflare/computer/backends/container";
import { DEFAULT_WORKSPACE_SETTINGS, type WorkspaceSettings } from "@cloudpid/config";
import { describe, expect, it } from "vitest";
import { ContainerLaunch, containerIgnore, type LaunchRecord } from "./launch.ts";

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
  settings: WorkspaceSettings;
  running: boolean;
  /** What the platform answers `start` with. */
  outcome: "launched" | "adopted" | "relaunched";
  restorable: { id: string; image: string | undefined } | undefined;
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
  /** The Container-only paths each launch asked for a snapshot of. */
  restorableIgnores: Array<readonly string[] | undefined>;
  record: LaunchRecord | undefined;
  starts: Spec[];
  restarts: Spec[];
  forgotten: number;
  takes: string[];
  takeOutcome: "taken" | "skipped" | "failed";
  warnings: string[];
  now: number;
};

const open = (settings: Partial<WorkspaceSettings> = {}) => {
  const state: Fake = {
    settings: { ...DEFAULT_WORKSPACE_SETTINGS, ...settings },
    running: false,
    outcome: "launched",
    restorable: undefined,
    image: "img-1",
    exit: null,
    rejectSnapshotStart: false,
    restores: 0,
    takeImages: [],
    takeIgnores: [],
    restorableIgnores: [],
    record: undefined,
    starts: [],
    restarts: [],
    forgotten: 0,
    takes: [],
    takeOutcome: "taken",
    warnings: [],
    now: 9_000,
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
        take: async (reason, image, ignore) => {
          state.takes.push(reason);
          state.takeImages.push(image);
          state.takeIgnores.push(ignore);

          return state.takeOutcome;
        },
      },
      load: async () => state.record,
      save: async (record) => {
        state.record = record;
      },
      running: () => state.running,
      now: () => state.now,
      warn: (message) => state.warnings.push(message),
    });

  const launch = make();

  return { state, api, launch, make, container: launch.wrap(api) };
};

describe("a launch", () => {
  it("starts on the instance type of the Workspace's settings", async () => {
    const { state, container } = open({ instance: "standard-4" });

    await container.start(SPEC);

    expect(state.starts[0]?.instance).toBe("standard-4");
    expect(state.starts[0]?.env).toEqual(SPEC.env);
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

    expect(await launch.idleMs()).toBe(DEFAULT_WORKSPACE_SETTINGS.idleMinutes * 60_000);
  });

  it("starts a Container found running with no launch on record on the default instance, so it is adopted", async () => {
    const { state, container } = open({ instance: "standard-4" });

    state.running = true;
    state.outcome = "adopted";
    await container.start(SPEC);

    expect(state.starts[0]?.instance).toBe(DEFAULT_WORKSPACE_SETTINGS.instance);
    expect(state.record?.needsSnapshot).toBe(false);
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
        ignore: () => undefined,
        image: () => state.image,
        snapshots: {
          restorable: async () => undefined,
          restored: async () => undefined,
          forget: async () => undefined,
          take: async () => "taken",
        },
        load: async () => undefined,
        save: async () => undefined,
        running: () => false,
        now: () => 1,
        warn: () => undefined,
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
  it("snapshots a Container that was started from the image", async () => {
    const { state, container, launch } = open();

    await container.start(SPEC);
    await launch.afterInstall();

    expect(state.takes).toEqual(["install"]);
    expect(state.record?.needsSnapshot).toBe(false);
  });

  it("does not snapshot again for the same Container", async () => {
    const { state, container, launch } = open();

    await container.start(SPEC);
    await launch.afterInstall();
    await launch.afterInstall();

    expect(state.takes).toEqual(["install"]);
  });

  it("leaves a Container restored from a snapshot to the idle stop's", async () => {
    const { state, container, launch } = open();

    state.restorable = { id: "snap-1", image: "img-1" };
    await container.start(SPEC);
    await launch.afterInstall();

    expect(state.takes).toEqual([]);
  });

  it("tries again after the next install when the snapshot was not taken", async () => {
    const { state, container, launch } = open();

    await container.start(SPEC);
    state.takeOutcome = "failed";
    await launch.afterInstall();

    expect(state.record?.needsSnapshot).toBe(true);

    state.takeOutcome = "taken";
    await launch.afterInstall();

    expect(state.takes).toEqual(["install", "install"]);
    expect(state.record?.needsSnapshot).toBe(false);
  });

  it("finds the launch on record after an eviction", async () => {
    const { state, container, make } = open();

    await container.start(SPEC);
    state.running = true;

    await make().afterInstall();

    expect(state.takes).toEqual(["install"]);
  });
});
