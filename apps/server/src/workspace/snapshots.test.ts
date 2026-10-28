// The Container's disk snapshots (docs/architecture/container.md → Snapshots): when one is taken, what
// stops it, and when a taken one is offered back. The Container, its storage and the clock are fakes; the disk scan's
// script runs in a local bash over a temporary directory.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off preferEffectArray:off preferEffectRecord:off nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PNPM_STORE_DIRECTORY_NAME, TOOLCHAIN_IGNORE } from "@cloudpid/sandbox-image/toolchains";
import type { KeptSecret } from "@cloudpid/extensions/secrets/core";
import type { HeldSecrets } from "./environment-secrets.ts";
import {
  ContainerSnapshots,
  SNAPSHOT_TIMEOUT_MS,
  scanContainerDisk,
  scanPatterns,
  type SnapshotRecord,
} from "./snapshots.ts";

type Fake = {
  running: boolean;
  image: string | undefined;
  stored: SnapshotRecord | undefined;
  taken: string[];
  scans: string[][];
  /** The Environment's Secrets the Workspace holds. */
  held: HeldSecrets;
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
    tokens?: () => ReadonlyArray<string>;
    timeoutMs?: number;
  } = {},
) => {
  const state: Fake = {
    running: true,
    image: IMAGE,
    stored: undefined,
    taken: [],
    scans: [],
    held: { ok: true, secrets: [] },
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
    tokens: overrides.tokens ?? (() => [SECRET]),
    timeoutMs: overrides.timeoutMs ?? 1_000,
    image: () => state.image,
    running: () => state.running,
    snapshot: async (name) => {
      await state.gate;

      if (state.snapshotFails) throw new Error("the platform refused");

      state.taken.push(name);

      return { id: `snap-${state.taken.length}`, size: 1234 };
    },
    secrets: async () => state.held,
    scan: async (patterns) => {
      state.scans.push([...patterns]);
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

describe("ContainerSnapshots and the Environment's Secrets", () => {
  const kept: KeptSecret = {
    name: "API_KEY",
    value: "sk-live-0123456789abcdef",
    scope: "environment",
    build: false,
  };

  it("searches the disk for the Environment's Secrets with the token", async () => {
    const { state, snapshots } = open();

    state.held = { ok: true, secrets: [kept] };
    state.leaks = ["/app/.env"];

    const leaked = await snapshots.capture("idle", IMAGE);

    expect(state.scans).toEqual([scanPatterns([SECRET], [kept])]);
    expect(leaked).toMatchObject({ outcome: "skipped" });
    expect(JSON.stringify(leaked)).toContain("/app/.env");
    expect(JSON.stringify(leaked)).not.toContain(kept.value);
    // It says where a value that is not secret belongs.
    expect(leaked).toMatchObject({
      reason: expect.stringContaining(
        "belongs in the variables (kept for the Environment or for every Environment)",
      ),
    });
  });

  it("does not send a leak of the token alone to the variables", async () => {
    const { state, snapshots } = open();

    state.leaks = ["/root/.netrc"];

    const leaked = await snapshots.capture("idle", IMAGE);

    expect(leaked).toEqual({ outcome: "skipped", reason: "the GitHub token is in /root/.netrc" });
  });

  it("searches for them also where there is no token", async () => {
    const { state, snapshots } = open({ tokens: () => [] });

    state.held = { ok: true, secrets: [kept] };

    expect(await snapshots.take("install", IMAGE)).toBe("taken");
    expect(state.scans).toEqual([scanPatterns([], [kept])]);
  });

  it("takes none while the Workspace cannot show which Secrets it must search for", async () => {
    const { state, snapshots } = open();

    state.held = { ok: false, reason: "the Environment's Secrets API_KEY are not held here" };

    expect(await snapshots.capture("idle", IMAGE)).toEqual({
      outcome: "skipped",
      reason: "the Environment's Secrets API_KEY are not held here",
    });
    expect(state.scans).toHaveLength(0);
    expect(state.taken).toHaveLength(0);
  });
});

describe("what the scan searches for", () => {
  const kept = (value: string): KeptSecret => ({
    name: "KEY",
    value,
    scope: "environment",
    build: false,
  });

  it("is each GitHub token as it is and in base64, alone or in the basic-auth pair", () => {
    expect(scanPatterns(["ghs_first", "ghs_second"], [])).toEqual([
      "ghs_first",
      btoa("ghs_first"),
      btoa("x-access-token:ghs_first"),
      "ghs_second",
      btoa("ghs_second"),
      btoa("x-access-token:ghs_second"),
    ]);
  });

  it("is each Secret as it is and as base64 of its UTF-8", () => {
    const value = "pässword-0123456789";
    const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(value)));

    expect(scanPatterns([], [kept(value)])).toEqual([value, base64]);
  });

  it("is a multi-line Secret's longest line, which a file holding it holds, not a common line such as a PEM header", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}\nabc\n-----END PRIVATE KEY-----\n`;
    const patterns = scanPatterns([], [kept(pem)]);

    expect(patterns[0]).toBe(body);
    expect(patterns.join("\n")).not.toContain("BEGIN PRIVATE KEY");
    expect(patterns.every((pattern) => !pattern.includes("\n"))).toBe(true);
  });

  it("is a part of a long Secret from its middle, bounded, which every file holding it holds", () => {
    const value = Array.from({ length: 2000 }, (_, index) =>
      String.fromCharCode(97 + (index % 26)),
    ).join("");

    const [excerpt] = scanPatterns([], [kept(value)]);

    expect(excerpt?.length).toBe(256);
    expect(value).toContain(excerpt);
    expect(value.startsWith(excerpt ?? "")).toBe(false);
  });

  it("leaves out a Secret too short to search for without finding it by chance", () => {
    expect(scanPatterns([], [kept("1234567")])).toEqual([]);
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

    expect(state.scans).toEqual([scanPatterns([SECRET], [])]);
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

  it("searches for every GitHub token that has not expired as the snapshot is taken", async () => {
    const live = ["ghs_first"];
    const { state, snapshots } = open({ tokens: () => live });

    await snapshots.take("install", IMAGE);
    live.push("ghs_second");
    await snapshots.take("idle", IMAGE);

    expect(state.scans).toEqual([
      scanPatterns(["ghs_first"], []),
      scanPatterns(["ghs_first", "ghs_second"], []),
    ]);
  });

  it("needs no scan when there is no token to leak", async () => {
    const { state, snapshots } = open({ tokens: () => [] });

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
      scanPatterns([SECRET], []),
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
      scanPatterns([SECRET], []),
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
        scanPatterns([SECRET], []),
        20,
      ),
    ).rejects.toThrow(/did not finish/);

    expect(signal?.aborted).toBe(true);
  });

  it("lists the files grep found it in", async () => {
    const found = await scanContainerDisk(
      { exec: async () => output("/root/.netrc\n/tmp/x\n", 0) },
      scanPatterns([SECRET], []),
    );

    expect(found).toEqual(["/root/.netrc", "/tmp/x"]);
  });

  describe("run by bash over a directory tree", () => {
    // The real script, run here by bash and given a root to search as its first argument, in place of the disk.
    const scan = (dir: string, patterns = scanPatterns([SECRET], [])) =>
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
        patterns,
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

    it("finds an Environment's Secrets among many, whose patterns are split over several variables", async () => {
      const secrets = Array.from({ length: 200 }, (_, index): KeptSecret => ({
        name: `KEY_${index}`,
        value: `${String(index).padStart(4, "0")}-${"v".repeat(300)}-${index}`,
        scope: "every",
        build: false,
      }));

      const last = secrets.at(-1)?.value ?? "";

      write("app/.env", `KEY=${last}`);
      write("app/encoded", btoa(secrets[3]?.value ?? ""));
      write("app/clean", "nothing here");

      expect([...(await scan(root, scanPatterns([SECRET], secrets)))].sort()).toEqual([
        join(root, "app/.env"),
        join(root, "app/encoded"),
      ]);
    });

    it("fails when the tree cannot be walked, which is not the same as finding nothing", async () => {
      await expect(scan(join(root, "missing"))).rejects.toThrow(/exit/);
    });
  });

  it("fails when grep itself fails, which is not the same as finding nothing", async () => {
    await expect(
      scanContainerDisk({ exec: async () => output("", 2) }, scanPatterns([SECRET], [])),
    ).rejects.toThrow(/exit/);
  });
});
