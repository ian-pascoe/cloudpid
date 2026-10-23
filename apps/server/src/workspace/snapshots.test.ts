// The Container's disk snapshots (docs/spec.md → Container and Toolchains → Snapshots): when one is taken, what
// stops it, and when a taken one is offered back. The Container, its storage and the clock are fakes; the disk scan's
// script runs in a local bash over a temporary directory.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off preferEffectArray:off preferEffectRecord:off nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PNPM_STORE_DIRECTORY_NAME, TOOLCHAIN_IGNORE } from "@cloudpid/sandbox-image/toolchains";
import {
  ContainerSnapshots,
  SNAPSHOT_TIMEOUT_MS,
  scanContainerDisk,
  type SnapshotRecord,
} from "./snapshots.ts";

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
  /** Holds the scan until released. */
  scanGate: Promise<void> | undefined;
  now: number;
};

const SECRET = "ghp_test_secret_value";

const IMAGE = "registry/image@sha256:one";

const open = (
  overrides: {
    enabled?: boolean;
    secret?: string | undefined;
    timeoutMs?: number;
  } = {},
) => {
  const state: Fake = {
    running: true,
    image: IMAGE,
    stored: undefined,
    taken: [],
    scans: [],
    warnings: [],
    notes: [],
    leaks: [],
    scanFails: false,
    snapshotFails: false,
    gate: undefined,
    scanGate: undefined,
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
      await state.scanGate;

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

describe("ContainerSnapshots.capture", () => {
  it("snapshots the running Container for a Build without keeping it as the Workspace's own", async () => {
    const { state, snapshots } = open();

    expect(await snapshots.capture("build", IMAGE)).toEqual({
      outcome: "taken",
      id: "snap-1",
      size: 1234,
      tookMs: 0,
    });
    expect(state.taken).toEqual(["workspace-build"]);
    expect(state.stored).toBeUndefined();
  });

  it("says why it took none: the token on the disk (naming the file, never the value), or the platform's refusal", async () => {
    const { state, snapshots } = open();

    state.leaks = ["/root/.netrc"];

    const leaked = await snapshots.capture("build", IMAGE);

    expect(leaked).toMatchObject({ outcome: "skipped" });
    expect(JSON.stringify(leaked)).toContain("/root/.netrc");
    expect(JSON.stringify(leaked)).not.toContain(SECRET);

    state.leaks = [];
    state.snapshotFails = true;

    expect(await snapshots.capture("build", IMAGE)).toEqual({
      outcome: "failed",
      reason: "the platform refused",
    });
    expect(state.taken).toHaveLength(0);
  });
});

describe("ContainerSnapshots.take", () => {
  it("snapshots the running Container and keeps the handle with the image it came from", async () => {
    const { state, snapshots } = open();

    expect(await snapshots.take("install", IMAGE)).toBe("taken");

    expect(state.taken).toHaveLength(1);
    expect(state.stored).toEqual({
      id: "snap-1",
      size: 1234,
      takenAt: 5_000,
      refreshedAt: 5_000,
      tookMs: 0,
      image: "registry/image@sha256:one",
      reason: "install",
    });
  });

  it("replaces the previous snapshot: only the latest is restored", async () => {
    const { state, snapshots } = open();

    await snapshots.take("install", IMAGE);
    await snapshots.take("idle", IMAGE);

    expect(state.stored?.id).toBe("snap-2");
    expect(state.stored?.reason).toBe("idle");
  });

  it("does nothing when the Container is not running", async () => {
    const { state, snapshots } = open();

    state.running = false;

    expect(await snapshots.take("idle", IMAGE)).toBe("skipped");
    expect(state.taken).toHaveLength(0);
  });

  it("does nothing where snapshots are off (the local Container has no real mount)", async () => {
    const { state, snapshots } = open({ enabled: false });

    expect(await snapshots.take("install", IMAGE)).toBe("skipped");
    expect(state.taken).toHaveLength(0);
    expect(state.scans).toHaveLength(0);
  });

  it("scans the Container's disk for the GitHub token first, and snapshots nothing that holds it", async () => {
    const { state, snapshots } = open();

    state.leaks = ["/root/.netrc"];

    expect(await snapshots.take("idle", IMAGE)).toBe("skipped");

    expect(state.scans).toEqual([SECRET]);
    expect(state.taken).toHaveLength(0);
    // The warning names the file and never the value.
    expect(state.warnings.join("\n")).toContain("/root/.netrc");
    expect(state.warnings.join("\n")).not.toContain(SECRET);
  });

  it("keeps an earlier snapshot when a later disk holds the token, which only the newer one would have", async () => {
    const { state, snapshots } = open();

    await snapshots.take("install", IMAGE);
    state.leaks = ["/tmp/credentials"];
    await snapshots.take("idle", IMAGE);

    expect(state.stored?.id).toBe("snap-1");
  });

  it("does not snapshot when the scan cannot run: it fails closed", async () => {
    const { state, snapshots } = open();

    state.scanFails = true;

    expect(await snapshots.take("install", IMAGE)).toBe("failed");
    expect(state.taken).toHaveLength(0);
    expect(state.warnings.join("\n")).not.toContain(SECRET);
  });

  it("needs no scan when there is no token to leak", async () => {
    const { state, snapshots } = open({ secret: undefined });

    expect(await snapshots.take("install", IMAGE)).toBe("taken");
    expect(state.scans).toHaveLength(0);
  });

  it("reports a refused snapshot instead of throwing, and keeps the earlier one", async () => {
    const { state, snapshots } = open();

    await snapshots.take("install", IMAGE);
    state.snapshotFails = true;

    expect(await snapshots.take("idle", IMAGE)).toBe("failed");
    expect(state.stored?.id).toBe("snap-1");
    expect(state.warnings.join("\n")).toContain("the platform refused");
  });

  it("gives up on a snapshot that takes too long, and records nothing", async () => {
    const { state, snapshots } = open({ timeoutMs: 20 });

    state.gate = new Promise(() => undefined);

    expect(await snapshots.take("idle", IMAGE)).toBe("failed");
    expect(state.stored).toBeUndefined();
    expect(state.warnings.join("\n")).toContain("did not finish");
  });

  it("joins a snapshot already being taken instead of starting a second", async () => {
    const { state, snapshots } = open();
    let release: () => void = () => undefined;

    state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = snapshots.take("install", IMAGE);
    const second = snapshots.take("idle", IMAGE);

    release();

    expect(await Promise.all([first, second])).toEqual(["taken", "taken"]);
    expect(state.taken).toHaveLength(1);
  });
});

describe("ContainerSnapshots.take, for a Container of another image", () => {
  it("does not snapshot a Container that runs an older image than the deployed one, which would be labelled as the new one", async () => {
    const { state, snapshots } = open();

    // A deploy changed the image while the Container ran on: it was adopted, and still runs the old one.
    state.image = "registry/image@sha256:two";

    expect(await snapshots.take("idle", IMAGE)).toBe("skipped");
    expect(state.taken).toHaveLength(0);
    expect(state.stored).toBeUndefined();
  });

  it("does not snapshot a Container whose image is not known", async () => {
    const { state, snapshots } = open();

    expect(await snapshots.take("idle", undefined)).toBe("skipped");
    expect(state.taken).toHaveLength(0);
  });
});

describe("ContainerSnapshots.take, within its time", () => {
  it("gives up on a scan that does not finish, and snapshots nothing", async () => {
    const { state, snapshots } = open({ timeoutMs: 20 });

    state.scanGate = new Promise(() => undefined);

    expect(await snapshots.take("install", IMAGE)).toBe("failed");
    expect(state.taken).toHaveLength(0);
    expect(state.warnings.join("\n")).toContain("did not finish");
  });

  it("takes and records an install snapshot that needs between 60 and 120 s, as one of this repo's install can (#156)", async () => {
    vi.useFakeTimers();

    try {
      const { state, snapshots } = open({ timeoutMs: SNAPSHOT_TIMEOUT_MS });

      state.gate = new Promise((resolve) => setTimeout(resolve, 90_000));

      const taking = snapshots.take("install", IMAGE);

      await vi.advanceTimersByTimeAsync(90_000);

      expect(await taking).toBe("taken");
      expect(state.stored).toMatchObject({ id: "snap-1", reason: "install" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a snapshot that needs more than the limit, which is 120 s", async () => {
    vi.useFakeTimers();

    try {
      const { state, snapshots } = open({ timeoutMs: SNAPSHOT_TIMEOUT_MS });

      state.gate = new Promise((resolve) => setTimeout(resolve, 130_000));

      const taking = snapshots.take("install", IMAGE);

      await vi.advanceTimersByTimeAsync(120_000);

      expect(await taking).toBe("failed");
      expect(SNAPSHOT_TIMEOUT_MS).toBe(120_000);
      expect(state.stored).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ContainerSnapshots.restorable", () => {
  it("offers nothing before one is taken", async () => {
    const { snapshots } = open();

    expect(await snapshots.restorable()).toBeUndefined();
  });

  it("offers the latest snapshot of the same image", async () => {
    const { snapshots } = open();

    await snapshots.take("install", IMAGE);

    expect(await snapshots.restorable()).toEqual({ id: "snap-1", image: IMAGE });
  });

  it("offers a snapshot only to a launch with the Container-only paths it was taken with", async () => {
    const { state, snapshots } = open();

    await snapshots.take("idle", IMAGE, ["**/node_modules", "/data"]);

    expect(state.stored?.ignore).toEqual(["**/node_modules", "/data"]);
    expect(await snapshots.restorable(["**/node_modules", "/data"])).toEqual({
      id: "snap-1",
      image: IMAGE,
    });

    // The Workspace's paths changed: what the disk holds for them, and computerd's store, are for the old ones.
    expect(await snapshots.restorable(["**/node_modules"])).toBeUndefined();
    expect(state.stored).toBeUndefined();
  });

  it("forgets a snapshot taken before the built-in Container-only paths grew, so the launch starts cold", async () => {
    const { state, snapshots } = open();
    const before = TOOLCHAIN_IGNORE.filter((pattern) => pattern !== "**/.wrangler");

    await snapshots.take("idle", IMAGE, before);

    expect(await snapshots.restorable(TOOLCHAIN_IGNORE)).toBeUndefined();
    expect(state.stored).toBeUndefined();

    // The next snapshot, of a Container launched with the new list, restores as usual.
    await snapshots.take("install", IMAGE, TOOLCHAIN_IGNORE);

    expect(await snapshots.restorable(TOOLCHAIN_IGNORE)).toEqual({ id: "snap-2", image: IMAGE });
  });

  it("forgets a snapshot of another image: a deploy that changed it makes the snapshot useless", async () => {
    const { state, snapshots } = open();

    await snapshots.take("install", IMAGE);
    state.image = "registry/image@sha256:two";

    expect(await snapshots.restorable()).toBeUndefined();
    expect(state.stored).toBeUndefined();
  });

  it("offers nothing where snapshots are off", async () => {
    const { state, snapshots } = open({ enabled: false });

    state.stored = {
      id: "x",
      size: 1,
      takenAt: 1,
      refreshedAt: 1,
      tookMs: 1,
      image: state.image,
      reason: "idle",
    };

    expect(await snapshots.restorable()).toBeUndefined();
  });

  it("forgets a snapshot about to expire: the platform keeps one 30 days", async () => {
    const { state, snapshots } = open();

    await snapshots.take("idle", IMAGE);
    state.now += 30 * 24 * 60 * 60_000;

    expect(await snapshots.restorable()).toBeUndefined();
    expect(state.stored).toBeUndefined();
  });

  it("counts a restore as the start of its 30 days again", async () => {
    const { state, snapshots } = open();

    await snapshots.take("idle", IMAGE);
    state.now += 20 * 24 * 60 * 60_000;
    await snapshots.restored();
    state.now += 20 * 24 * 60 * 60_000;

    expect(await snapshots.restorable()).toEqual({ id: "snap-1", image: IMAGE });
  });

  it("forget drops the record, for a restore that did not come up", async () => {
    const { state, snapshots } = open();

    await snapshots.take("install", IMAGE);
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

    // The token and its base64 forms go to grep as patterns.
    const patterns = Object.values(calls[0]?.env ?? {})
      .join("\n")
      .split("\n");

    expect(patterns).toEqual([SECRET, btoa(SECRET), btoa(`x-access-token:${SECRET}`)]);
  });

  it("searches the whole disk but the pseudo file systems and the Workspace mount, whose files are in computerd's store", async () => {
    let script = "";

    await scanContainerDisk(
      {
        exec: async (cmd) => {
          script = cmd[2] ?? "";

          return output("", 1);
        },
      },
      SECRET,
    );

    expect(script).toContain("/*");

    for (const excluded of ["/proc", "/sys", "/dev", "/run", "/workspace"]) {
      expect(script).toContain(excluded);
    }
  });

  it("kills the search and rejects when it does not finish in time", async () => {
    let signal: AbortSignal | undefined;

    await expect(
      scanContainerDisk(
        {
          exec: async (_cmd, options) => {
            signal = options?.signal;

            return { output: () => new Promise(() => undefined) };
          },
        },
        SECRET,
        20,
      ),
    ).rejects.toThrow(/did not finish/);

    expect(signal?.aborted).toBe(true);
  });

  it("lists the files grep found it in", async () => {
    const found = await scanContainerDisk(
      { exec: async () => output("/root/.netrc\n/tmp/x\n", 0) },
      SECRET,
    );

    expect(found).toEqual(["/root/.netrc", "/tmp/x"]);
  });

  describe("run by bash over a directory tree", () => {
    // The real script, run here by bash and given a root to search as its first argument, in place of the disk.
    const scan = (dir: string) =>
      scanContainerDisk(
        {
          exec: async (cmd, options) => {
            const [command, ...args] = cmd;

            expect(command).toBe("bash");

            const run = spawnSync("bash", [...args, "scan", dir], {
              env: { ...process.env, ...options?.env },
            });

            if (run.error !== undefined) throw run.error;

            return output(run.stdout.toString(), run.status ?? 2);
          },
        },
        SECRET,
      );

    let root = "";

    const write = (path: string, content: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    };

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "scan-"));
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it("finds the token and its base64 forms, and nothing in clean files", async () => {
      write("root/.netrc", `machine github.com password ${SECRET}`);
      write("etc/auth", btoa(`x-access-token:${SECRET}`));
      write("etc/clean", "nothing here");

      expect([...(await scan(root))].sort()).toEqual([
        join(root, "etc/auth"),
        join(root, "root/.netrc"),
      ]);
    });

    it("skips pnpm's store and the virtual store in node_modules, which hold only the packages pnpm installed", async () => {
      write("workspace/.pnpm-store/v11/files/ab/cdef", `registry file ${SECRET}`);
      write("workspace/repo/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.js", SECRET);

      expect(await scan(root)).toEqual([]);
    });

    it("skips the store the Container's pnpm configuration names, with its global virtual store", async () => {
      write(`root/${PNPM_STORE_DIRECTORY_NAME}/v11/files/ab/cdef`, `registry file ${SECRET}`);
      write(
        `root/${PNPM_STORE_DIRECTORY_NAME}/v11/links/@/pkg/1.0.0/0123abcd/node_modules/pkg/index.js`,
        SECRET,
      );
      write("root/.local/share/mise/installs/node/24/lib/x.js", "clean");

      expect(await scan(root)).toEqual([]);
    });

    it("still searches the rest of node_modules, where tools and commands write", async () => {
      write("workspace/repo/node_modules/.cache/build.js", `const token = "${SECRET}"`);

      expect(await scan(root)).toEqual([join(root, "workspace/repo/node_modules/.cache/build.js")]);
    });

    it("fails when the tree cannot be walked, which is not the same as finding nothing", async () => {
      await expect(scan(join(root, "missing"))).rejects.toThrow(/exit/);
    });
  });

  it("fails when grep itself fails, which is not the same as finding nothing", async () => {
    await expect(scanContainerDisk({ exec: async () => output("", 2) }, SECRET)).rejects.toThrow(
      /exit/,
    );
  });
});
