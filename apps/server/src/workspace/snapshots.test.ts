// The Container's disk snapshots (docs/spec.md → Container and Toolchains → Snapshots): when one is taken, what
// stops it, and when a taken one is offered back. The Container, its storage and the clock are fakes.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off preferEffectArray:off preferEffectRecord:off
import { describe, expect, it } from "vitest";
import { ContainerSnapshots, scanContainerDisk, type SnapshotRecord } from "./snapshots.ts";

type Fake = {
  running: boolean;
  image: string | undefined;
  stored: SnapshotRecord | undefined;
  taken: string[];
  scans: string[];
  warnings: string[];
  notes: string[];
  /** Paths the scan finds the secret in. */
  leaks: string[];
  scanFails: boolean;
  snapshotFails: boolean;
  /** Holds the snapshot call until released. */
  gate: Promise<void> | undefined;
  now: number;
};

const SECRET = "ghp_test_secret_value";

const open = (
  overrides: { enabled?: boolean; secret?: string | undefined; timeoutMs?: number } = {},
) => {
  const state: Fake = {
    running: true,
    image: "registry/image@sha256:one",
    stored: undefined,
    taken: [],
    scans: [],
    warnings: [],
    notes: [],
    leaks: [],
    scanFails: false,
    snapshotFails: false,
    gate: undefined,
    now: 5_000,
  };

  const snapshots = new ContainerSnapshots({
    enabled: overrides.enabled ?? true,
    secret: "secret" in overrides ? overrides.secret : SECRET,
    timeoutMs: overrides.timeoutMs ?? 1_000,
    image: () => state.image,
    running: () => state.running,
    snapshot: async (name) => {
      await state.gate;

      if (state.snapshotFails) throw new Error("the platform refused");

      state.taken.push(name);

      return { id: `snap-${state.taken.length}`, size: 1234 };
    },
    scan: async (secret) => {
      state.scans.push(secret);

      if (state.scanFails) throw new Error("exec is not available");

      return state.leaks;
    },
    load: async () => state.stored,
    save: async (record) => {
      state.stored = record;
    },
    clear: async () => {
      state.stored = undefined;
    },
    now: () => state.now,
    warn: (message) => state.warnings.push(message),
    info: (message) => state.notes.push(message),
  });

  return { state, snapshots };
};

describe("ContainerSnapshots.take", () => {
  it("snapshots the running Container and keeps the handle with the image it came from", async () => {
    const { state, snapshots } = open();

    expect(await snapshots.take("install")).toBe("taken");

    expect(state.taken).toHaveLength(1);
    expect(state.stored).toEqual({
      id: "snap-1",
      size: 1234,
      takenAt: 5_000,
      tookMs: 0,
      image: "registry/image@sha256:one",
      reason: "install",
    });
  });

  it("replaces the previous snapshot: only the latest is restored", async () => {
    const { state, snapshots } = open();

    await snapshots.take("install");
    await snapshots.take("idle");

    expect(state.stored?.id).toBe("snap-2");
    expect(state.stored?.reason).toBe("idle");
  });

  it("does nothing when the Container is not running", async () => {
    const { state, snapshots } = open();

    state.running = false;

    expect(await snapshots.take("idle")).toBe("skipped");
    expect(state.taken).toHaveLength(0);
  });

  it("does nothing where snapshots are off (the local Container has no real mount)", async () => {
    const { state, snapshots } = open({ enabled: false });

    expect(await snapshots.take("install")).toBe("skipped");
    expect(state.taken).toHaveLength(0);
    expect(state.scans).toHaveLength(0);
  });

  it("scans the Container's disk for the GitHub token first, and snapshots nothing that holds it", async () => {
    const { state, snapshots } = open();

    state.leaks = ["/root/.netrc"];

    expect(await snapshots.take("idle")).toBe("skipped");

    expect(state.scans).toEqual([SECRET]);
    expect(state.taken).toHaveLength(0);
    // The warning names the file and never the value.
    expect(state.warnings.join("\n")).toContain("/root/.netrc");
    expect(state.warnings.join("\n")).not.toContain(SECRET);
  });

  it("keeps an earlier snapshot when a later disk holds the token, which only the newer one would have", async () => {
    const { state, snapshots } = open();

    await snapshots.take("install");
    state.leaks = ["/tmp/credentials"];
    await snapshots.take("idle");

    expect(state.stored?.id).toBe("snap-1");
  });

  it("does not snapshot when the scan cannot run: it fails closed", async () => {
    const { state, snapshots } = open();

    state.scanFails = true;

    expect(await snapshots.take("install")).toBe("failed");
    expect(state.taken).toHaveLength(0);
    expect(state.warnings.join("\n")).not.toContain(SECRET);
  });

  it("needs no scan when there is no token to leak", async () => {
    const { state, snapshots } = open({ secret: undefined });

    expect(await snapshots.take("install")).toBe("taken");
    expect(state.scans).toHaveLength(0);
  });

  it("reports a refused snapshot instead of throwing, and keeps the earlier one", async () => {
    const { state, snapshots } = open();

    await snapshots.take("install");
    state.snapshotFails = true;

    expect(await snapshots.take("idle")).toBe("failed");
    expect(state.stored?.id).toBe("snap-1");
    expect(state.warnings.join("\n")).toContain("the platform refused");
  });

  it("gives up on a snapshot that takes too long, and records nothing", async () => {
    const { state, snapshots } = open({ timeoutMs: 20 });

    state.gate = new Promise(() => undefined);

    expect(await snapshots.take("idle")).toBe("failed");
    expect(state.stored).toBeUndefined();
    expect(state.warnings.join("\n")).toContain("did not finish");
  });

  it("joins a snapshot already being taken instead of starting a second", async () => {
    const { state, snapshots } = open();
    let release: () => void = () => undefined;

    state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = snapshots.take("install");
    const second = snapshots.take("idle");

    release();

    expect(await Promise.all([first, second])).toEqual(["taken", "taken"]);
    expect(state.taken).toHaveLength(1);
  });
});

describe("ContainerSnapshots.restorable", () => {
  it("offers nothing before one is taken", async () => {
    const { snapshots } = open();

    expect(await snapshots.restorable()).toBeUndefined();
  });

  it("offers the latest snapshot of the same image", async () => {
    const { snapshots } = open();

    await snapshots.take("install");

    expect(await snapshots.restorable()).toEqual({ id: "snap-1" });
  });

  it("forgets a snapshot of another image: a deploy that changed it makes the snapshot useless", async () => {
    const { state, snapshots } = open();

    await snapshots.take("install");
    state.image = "registry/image@sha256:two";

    expect(await snapshots.restorable()).toBeUndefined();
    expect(state.stored).toBeUndefined();
  });

  it("offers nothing where snapshots are off", async () => {
    const { state, snapshots } = open({ enabled: false });

    state.stored = { id: "x", size: 1, takenAt: 1, tookMs: 1, image: state.image, reason: "idle" };

    expect(await snapshots.restorable()).toBeUndefined();
  });

  it("forget drops the record, for a restore that did not come up", async () => {
    const { state, snapshots } = open();

    await snapshots.take("install");
    await snapshots.forget();

    expect(state.stored).toBeUndefined();
    expect(await snapshots.restorable()).toBeUndefined();
  });
});

describe("scanContainerDisk", () => {
  const output = (stdout: string, exitCode: number) => ({
    output: async () => ({
      // SAFETY: a TextEncoder's bytes are in a plain ArrayBuffer.
      stdout: new TextEncoder().encode(stdout).buffer as ArrayBuffer,
      stderr: new ArrayBuffer(0),
      exitCode,
    }),
  });

  it("hands the token to grep in the environment, never in the command line", async () => {
    const calls: { cmd: readonly string[]; env: Record<string, string> | undefined }[] = [];

    const found = await scanContainerDisk(
      {
        exec: async (cmd, options) => {
          calls.push({ cmd, env: options?.env });

          return output("", 1);
        },
      },
      SECRET,
    );

    expect(found).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd.join(" ")).not.toContain(SECRET);
    expect(Object.values(calls[0]?.env ?? {})).toContain(SECRET);
    // The Workspace is a separate mount that a snapshot does not hold, so it is not searched.
    expect(calls[0]?.cmd.join(" ")).not.toContain("/workspace");
  });

  it("lists the files grep found it in", async () => {
    const found = await scanContainerDisk(
      { exec: async () => output("/root/.netrc\n/tmp/x\n", 0) },
      SECRET,
    );

    expect(found).toEqual(["/root/.netrc", "/tmp/x"]);
  });

  it("fails when grep itself fails, which is not the same as finding nothing", async () => {
    await expect(scanContainerDisk({ exec: async () => output("", 2) }, SECRET)).rejects.toThrow(
      /exit/,
    );
  });
});
