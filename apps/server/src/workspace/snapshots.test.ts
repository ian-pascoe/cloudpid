// The Container's disk snapshots (docs/architecture/container.md → Snapshots): when one is taken, what
// stops it, and when a taken one is offered back. The Container, its storage and the clock are fakes; the disk scan's
// script runs in a local bash over a temporary directory.
// @effect-diagnostics asyncFunction:off globalDate:off globalTimers:off newPromise:off preferEffectArray:off preferEffectRecord:off nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUN_DIRECTORY_NAME,
  PNPM_STORE_DIRECTORY_NAME,
  TOOLCHAIN_IGNORE,
} from "@cloudpid/sandbox-image/toolchains";
import type { KeptSecret } from "@cloudpid/extensions/secrets/core";
import type { LiveToken } from "../github/app.ts";
import type { HeldSecrets } from "./environment-secrets.ts";
import {
  BUILD_SNAPSHOT_TIMEOUT_MS,
  ContainerSnapshots,
  SNAPSHOT_TIMEOUT_MS,
  scanContainerDisk,
  secretLabel,
  TOKEN_LABEL,
  scanGroups,
  type ScanGroup,
  type ScanHit,
  type SnapshotReason,
  type SnapshotRecord,
} from "./snapshots.ts";

type Fake = {
  running: boolean;
  image: string | undefined;
  stored: SnapshotRecord | undefined;
  taken: string[];
  scans: ScanGroup[][];
  /** Whether each scan was asked for the files changed since the Container started only. */
  sinceStart: boolean[];
  /** Why each scan's snapshot was taken. */
  scanReasons: SnapshotReason[];
  /** The Container has no marker of its start: a scan asked for the files changed since searches everything. */
  noMarker: boolean;
  /** The Environment's Secrets the Workspace holds. */
  held: HeldSecrets;
  warnings: string[];
  notes: string[];
  /** What the scan finds, and in which files. */
  leaks: ScanHit[];
  scanFails: boolean;
  snapshotFails: boolean;
  /** Holds the snapshot call until released. */
  gate: Promise<void> | undefined;
  /** Holds the scan until released. */
  scanGate: Promise<void> | undefined;
  now: number;
};

const SECRET = "ghp_test_secret_value";

/** A file the scan found, holding what the labels name. */
const hit = (path: string, ...found: string[]): ScanHit => ({ path, found });

const IMAGE = "registry/image@sha256:one";

/** A digest standing in for the Workspace's keyed one: SHA-256, hex. */
const digest = async (text: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

/** What a scan of `tokens` and `secrets` records it searched for. */
const searchedFor = async (tokens: ReadonlyArray<string>, secrets: ReadonlyArray<KeptSecret>) => [
  ...(await Promise.all(
    scanGroups([], secrets).map(({ patterns }) => digest(JSON.stringify(patterns))),
  )),
  ...(await Promise.all(
    tokens.map((token) =>
      digest(JSON.stringify([token, btoa(token), btoa(`x-access-token:${token}`)])),
    ),
  )),
];

const open = (
  overrides: {
    enabled?: boolean;
    tokens?: () => ReadonlyArray<LiveToken>;
    timeoutMs?: number;
    buildTimeoutMs?: number;
    fingerprint?: ((text: string) => Promise<string>) | null;
  } = {},
) => {
  const state: Fake = {
    running: true,
    image: IMAGE,
    stored: undefined,
    taken: [],
    scans: [],
    sinceStart: [],
    scanReasons: [],
    noMarker: false,
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
    tokens: overrides.tokens ?? (() => [{ token: SECRET }]),
    fingerprint: overrides.fingerprint === null ? undefined : (overrides.fingerprint ?? digest),
    timeoutMs: overrides.timeoutMs ?? 1_000,
    buildTimeoutMs: overrides.buildTimeoutMs,
    image: () => state.image,
    running: () => state.running,
    snapshot: async (name) => {
      await state.gate;

      if (state.snapshotFails) throw new Error("the platform refused");

      state.taken.push(name);

      return { id: `snap-${state.taken.length}`, size: 1234 };
    },
    secrets: async () => state.held,
    scan: async (groups, { sinceStart, reason }) => {
      state.scans.push([...groups]);
      state.sinceStart.push(sinceStart);
      state.scanReasons.push(reason);
      await state.scanGate;

      if (state.scanFails) throw new Error("exec is not available");

      return { hits: state.leaks, sinceStart: sinceStart && !state.noMarker };
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
      scope: "whole",
      covered: { at: 5_000, searched: await searchedFor([SECRET], []) },
    });
    expect(state.taken).toEqual(["workspace-build"]);
    expect(state.stored).toBeUndefined();
  });

  it("says why it took none: the token on the disk (naming the file, never the value), or the platform's refusal", async () => {
    const { state, snapshots } = open();

    state.leaks = [hit("/root/.netrc", TOKEN_LABEL)];

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
    state.leaks = [hit("/app/.env", secretLabel("API_KEY"))];

    const leaked = await snapshots.capture("idle", IMAGE);

    expect(state.scans).toEqual([scanGroups([SECRET], [kept])]);
    expect(leaked).toMatchObject({ outcome: "skipped" });
    expect(JSON.stringify(leaked)).toContain("/app/.env");
    expect(JSON.stringify(leaked)).not.toContain(kept.value);
    // It says where a value that is not secret belongs.
    expect(leaked).toMatchObject({
      reason: expect.stringContaining(
        "belongs in the variables (kept for the Environment or Global)",
      ),
    });
  });

  it("does not send a leak of the token alone to the variables", async () => {
    const { state, snapshots } = open();

    state.leaks = [hit("/root/.netrc", TOKEN_LABEL)];

    const leaked = await snapshots.capture("idle", IMAGE);

    expect(leaked).toEqual({ outcome: "skipped", reason: "a GitHub token in /root/.netrc" });
  });

  it("names, per file, what each holds: a token, a kept Secret, or both, never a value", async () => {
    const { state, snapshots } = open();
    const other: KeptSecret = { ...kept, name: "DB_PASSWORD", value: "hunter2-hunter2-hunter2" };

    state.held = { ok: true, secrets: [kept, other] };
    state.leaks = [
      hit("/root/.gitconfig", TOKEN_LABEL),
      hit("/var/state.db", secretLabel("API_KEY"), TOKEN_LABEL),
      hit("/app/.env", secretLabel("API_KEY"), secretLabel("DB_PASSWORD")),
    ];

    const leaked = await snapshots.capture("idle", IMAGE);

    expect(leaked).toMatchObject({ outcome: "skipped" });

    const reason = leaked.outcome === "taken" ? "" : leaked.reason;

    expect(reason).toContain("a GitHub token in /root/.gitconfig");
    expect(reason).toContain("the Secret `API_KEY` and a GitHub token in /var/state.db");
    expect(reason).toContain("the Secret `API_KEY` and the Secret `DB_PASSWORD` in /app/.env");

    for (const value of [SECRET, kept.value, other.value, btoa(kept.value), btoa(SECRET)]) {
      expect(reason).not.toContain(value);
    }
  });

  it("counts the files beyond the first five, and names a token alone without the hint on variables", async () => {
    const { state, snapshots } = open();

    state.leaks = Array.from({ length: 7 }, (_, index) => hit(`/f${index}`, TOKEN_LABEL));

    const leaked = await snapshots.capture("idle", IMAGE);

    expect(leaked).toMatchObject({
      outcome: "skipped",
      reason: expect.stringContaining("a GitHub token in /f4 and 2 more files"),
    });
    expect(JSON.stringify(leaked)).not.toContain("/f5");
    expect(JSON.stringify(leaked)).not.toContain("variables");
  });

  it("searches for them also where there is no token", async () => {
    const { state, snapshots } = open({ tokens: () => [] });

    state.held = { ok: true, secrets: [kept] };

    expect(await snapshots.take("install", IMAGE)).toBe("taken");
    expect(state.scans).toEqual([scanGroups([], [kept])]);
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
    expect(scanGroups(["ghs_first", "ghs_second"], [])).toEqual([
      {
        label: TOKEN_LABEL,
        patterns: [
          "ghs_first",
          btoa("ghs_first"),
          btoa("x-access-token:ghs_first"),
          "ghs_second",
          btoa("ghs_second"),
          btoa("x-access-token:ghs_second"),
        ],
      },
    ]);
  });

  it("is each Secret as it is and as base64 of its UTF-8", () => {
    const value = "pässword-0123456789";
    const base64 = btoa(String.fromCharCode(...new TextEncoder().encode(value)));

    expect(scanGroups([], [kept(value)])).toEqual([
      { label: secretLabel("KEY"), patterns: [value, base64] },
    ]);
  });

  it("is a multi-line Secret's longest line, which a file holding it holds, not a common line such as a PEM header", () => {
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}\nabc\n-----END PRIVATE KEY-----\n`;
    const patterns = scanGroups([], [kept(pem)]).flatMap((group) => group.patterns);

    expect(patterns[0]).toBe(body);
    expect(patterns.join("\n")).not.toContain("BEGIN PRIVATE KEY");
    expect(patterns.every((pattern) => !pattern.includes("\n"))).toBe(true);
  });

  it("is a part of a long Secret from its middle, bounded, which every file holding it holds", () => {
    const value = Array.from({ length: 2000 }, (_, index) =>
      String.fromCharCode(97 + (index % 26)),
    ).join("");

    const [excerpt] = scanGroups([], [kept(value)]).flatMap((group) => group.patterns);

    expect(excerpt?.length).toBe(256);
    expect(value).toContain(excerpt);
    expect(value.startsWith(excerpt ?? "")).toBe(false);
  });

  it("leaves out a Secret too short to search for without finding it by chance", () => {
    expect(scanGroups([], [kept("1234567")])).toEqual([]);
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
      covered: { at: 5_000, searched: await searchedFor([SECRET], []) },
    });
    expect(state.notes).toEqual([
      "Container snapshot (install) taken: 0 MB in 0 ms, the scan searched the whole disk",
    ]);
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

    state.leaks = [hit("/root/.netrc", TOKEN_LABEL)];

    expect(await snapshots.take("idle", IMAGE)).toBe("skipped");

    expect(state.scans).toEqual([scanGroups([SECRET], [])]);
    expect(state.taken).toHaveLength(0);
    // The warning names the file and never the value.
    expect(state.warnings.join("\n")).toContain("/root/.netrc");
    expect(state.warnings.join("\n")).not.toContain(SECRET);
  });

  it("keeps an earlier snapshot when a later disk holds the token, which only the newer one would have", async () => {
    const { state, snapshots } = open();

    await snapshots.take("install", IMAGE);
    state.leaks = [hit("/tmp/credentials", TOKEN_LABEL)];
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
    const live: LiveToken[] = [{ token: "ghs_first" }];
    const { state, snapshots } = open({ tokens: () => live });

    await snapshots.take("install", IMAGE);
    live.push({ token: "ghs_second" });
    await snapshots.take("idle", IMAGE);

    expect(state.scans).toEqual([
      scanGroups(["ghs_first"], []),
      scanGroups(["ghs_first", "ghs_second"], []),
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

describe("ContainerSnapshots: the scan of the files changed since the Container started", () => {
  const API: KeptSecret = {
    name: "API_KEY",
    value: "sk-live-0123456789abcdef",
    scope: "environment",
    build: false,
  };

  /** A snapshot taken from the image (its scan searches the whole disk), and what it records its scan covered. */
  const first = async (snapshots: ContainerSnapshots) => {
    expect(await snapshots.take("install", IMAGE)).toBe("taken");

    const covered = await snapshots.coverage();

    if (covered === undefined) throw new Error("the snapshot recorded nothing its scan covered");

    return covered;
  };

  it("searches only those once the files the Container has not changed were shown clean of all it searches for", async () => {
    const { state, snapshots } = open();

    state.held = { ok: true, secrets: [API] };

    const covered = await first(snapshots);

    expect(await snapshots.take("idle", IMAGE, undefined, covered)).toBe("taken");
    expect(state.sinceStart).toEqual([false, true]);
    // It searches for the same, and says how much it searched.
    expect(state.scans[1]).toEqual(scanGroups([SECRET], [API]));
    expect(state.notes.at(-1)).toBe(
      "Container snapshot (idle) taken: 0 MB in 0 ms, the scan searched the files changed since the Container started",
    );
  });

  it("searches the whole disk for a Build, and for a Container's first snapshot from the image or a Build", async () => {
    const { state, snapshots } = open();
    const covered = await first(snapshots);

    await snapshots.capture("build", IMAGE, covered);
    await snapshots.take("idle", IMAGE);

    expect(state.sinceStart).toEqual([false, false, false]);
  });

  it("searches the whole disk once after a kept Secret was added or changed since, which may have been on it already", async () => {
    const { state, snapshots } = open();
    const covered = await first(snapshots);

    state.held = { ok: true, secrets: [API] };
    await snapshots.take("idle", IMAGE, undefined, covered);

    // Then what that scan covered holds the Secret.
    const after = await snapshots.coverage();

    await snapshots.take("idle", IMAGE, undefined, after);

    state.held = { ok: true, secrets: [{ ...API, value: "sk-live-another-value-0000" }] };
    await snapshots.take("idle", IMAGE, undefined, await snapshots.coverage());

    expect(state.sinceStart).toEqual([false, false, true, false]);
  });

  it("needs no search of the whole disk for a kept Secret removed since", async () => {
    const { state, snapshots } = open();

    state.held = { ok: true, secrets: [API] };

    const covered = await first(snapshots);

    state.held = { ok: true, secrets: [] };
    await snapshots.take("idle", IMAGE, undefined, covered);

    expect(state.sinceStart).toEqual([false, true]);
  });

  it("needs no search of the whole disk for a token minted after the snapshot was taken, but for one minted before it that its scan did not search for", async () => {
    const live: LiveToken[] = [{ token: SECRET, mintedAt: 1_000 }];
    const { state, snapshots } = open({ tokens: () => live });
    const covered = await first(snapshots);

    // Minted after it: no file of that snapshot can hold it.
    live.push({ token: "ghs_after", mintedAt: covered.at + 60_001 });
    await snapshots.take("idle", IMAGE, undefined, covered);

    // Just after, by a clock that may not be the snapshot's.
    live.push({ token: "ghs_just_after", mintedAt: covered.at + 30_000 });
    await snapshots.take("idle", IMAGE, undefined, covered);
    live.pop();

    // Minted before it, yet not searched for (a token the list did not have then), or of unknown minting.
    live.push({ token: "ghs_before", mintedAt: covered.at - 1 });
    await snapshots.take("idle", IMAGE, undefined, covered);
    live.pop();
    live.push({ token: "ghs_unknown" });
    await snapshots.take("idle", IMAGE, undefined, covered);

    expect(state.sinceStart).toEqual([false, true, false, false, false]);
  });

  it("records what it searched for, by digest, never a value, and when the snapshot was taken, after the scan", async () => {
    const { state, snapshots } = open();

    state.held = { ok: true, secrets: [API] };
    state.now = 7_000;

    let release: () => void = () => undefined;

    state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const taking = snapshots.take("install", IMAGE);

    await Promise.resolve();
    state.now = 8_000;
    release();
    await taking;

    expect(state.stored?.covered).toEqual({
      at: 8_000,
      searched: await searchedFor([SECRET], [API]),
    });
    expect(JSON.stringify(state.stored)).not.toContain(SECRET);
    expect(JSON.stringify(state.stored)).not.toContain(API.value);
  });

  it("searches the whole disk, and records nothing it covered, where nothing can be fingerprinted", async () => {
    const { state, snapshots } = open({ fingerprint: null });

    await snapshots.take("install", IMAGE);

    expect(state.stored?.covered).toBeUndefined();

    const failing = open({ fingerprint: async () => Promise.reject(new Error("no key")) });

    await failing.snapshots.take("idle", IMAGE, undefined, { at: 1, searched: [] });

    expect(failing.state.sinceStart).toEqual([false]);
    expect(failing.state.stored).toMatchObject({ id: "snap-1", covered: undefined });
  });

  it("says it searched the whole disk when the Container had no marker of its start", async () => {
    const { state, snapshots } = open();
    const covered = await first(snapshots);

    state.noMarker = true;
    await snapshots.take("idle", IMAGE, undefined, covered);

    expect(state.sinceStart).toEqual([false, true]);
    expect(state.notes.at(-1)).toContain("the scan searched the whole disk");
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

  it("gives a Build's snapshot its own, longer limit, and tells its scan it is a Build's", async () => {
    vi.useFakeTimers();

    try {
      const { state, snapshots } = open({
        timeoutMs: SNAPSHOT_TIMEOUT_MS,
        buildTimeoutMs: BUILD_SNAPSHOT_TIMEOUT_MS,
      });

      state.scanGate = new Promise((resolve) => setTimeout(resolve, 150_000));

      const capturing = snapshots.capture("build", IMAGE);

      await vi.advanceTimersByTimeAsync(150_000);

      expect(await capturing).toMatchObject({ outcome: "taken", scope: "whole" });
      expect(state.scanReasons).toEqual(["build"]);
      expect(BUILD_SNAPSHOT_TIMEOUT_MS).toBeGreaterThan(SNAPSHOT_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a Workspace's snapshot to its limit when a Build's is longer", async () => {
    vi.useFakeTimers();

    try {
      const { state, snapshots } = open({
        timeoutMs: SNAPSHOT_TIMEOUT_MS,
        buildTimeoutMs: BUILD_SNAPSHOT_TIMEOUT_MS,
      });

      state.scanGate = new Promise((resolve) => setTimeout(resolve, 150_000));

      const taking = snapshots.take("idle", IMAGE);

      await vi.advanceTimersByTimeAsync(SNAPSHOT_TIMEOUT_MS);

      expect(await taking).toBe("failed");
      expect(state.scanReasons).toEqual(["idle"]);
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

    // With what its scan searched for, which a Container restored from it needs not search its files for again.
    expect(await snapshots.restorable()).toEqual({
      id: "snap-1",
      image: IMAGE,
      covered: { at: 5_000, searched: await searchedFor([SECRET], []) },
    });
  });

  it("offers a snapshot only to a launch with the Container-only paths it was taken with", async () => {
    const { state, snapshots } = open();

    await snapshots.take("idle", IMAGE, ["**/node_modules", "/data"]);

    expect(state.stored?.ignore).toEqual(["**/node_modules", "/data"]);
    expect(await snapshots.restorable(["**/node_modules", "/data"])).toMatchObject({
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

    expect(await snapshots.restorable(TOOLCHAIN_IGNORE)).toMatchObject({
      id: "snap-2",
      image: IMAGE,
    });
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

    expect(await snapshots.restorable()).toMatchObject({ id: "snap-1", image: IMAGE });
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
      scanGroups([SECRET], []),
    );

    expect(found).toEqual({ hits: [], sinceStart: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd.join(" ")).not.toContain(SECRET);

    // The token and its base64 forms go to grep as patterns; the labels do not leave the Workspace DO.
    const patterns = Object.entries(calls[0]?.env ?? {})
      .filter(([name]) => name.startsWith("CLOUDPID_SCAN_SECRET_"))
      .flatMap(([, value]) => value.split("\n"));

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
      scanGroups([SECRET], []),
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
        scanGroups([SECRET], []),
        { timeoutMs: 20 },
      ),
    ).rejects.toThrow(/did not finish/);

    expect(signal?.aborted).toBe(true);
  });

  it("lists the files the search found, with the labels of the groups that hold each", async () => {
    const kept: KeptSecret = {
      name: "API_KEY",
      value: "sk-live-0123456789abcdef",
      scope: "environment",
      build: false,
    };

    const found = await scanContainerDisk(
      { exec: async () => output("0\t/root/.netrc\n0,1\t/tmp/x\n\t/tmp/beyond\n", 0) },
      scanGroups([SECRET], [kept]),
    );

    expect(found.hits).toEqual([
      { path: "/root/.netrc", found: [TOKEN_LABEL] },
      { path: "/tmp/x", found: [TOKEN_LABEL, secretLabel("API_KEY")] },
      { path: "/tmp/beyond", found: [] },
    ]);
  });

  it("sends neither a label nor a value in the command line or a variable's name", async () => {
    const calls: { cmd: readonly string[]; env: Record<string, string> | undefined }[] = [];

    await scanContainerDisk(
      {
        exec: async (cmd, options) => {
          calls.push({ cmd, env: options?.env });

          return output("", 1);
        },
      },
      scanGroups(
        [SECRET],
        [
          {
            name: "API_KEY",
            value: "sk-live-0123456789abcdef",
            scope: "environment",
            build: false,
          },
        ],
      ),
    );

    const sent = JSON.stringify(calls);

    expect(sent).not.toContain("API_KEY");
    expect(sent).not.toContain("sk-live-0123456789abcdef".slice(0, 12) + "x");
    expect(calls[0]?.cmd.join(" ")).not.toContain("sk-live");
  });

  describe("run by bash over a directory tree", () => {
    let root = "";
    /** The Container's start marker, outside the tree searched, as `/run` is outside the disk's. */
    let marker = "";

    // The real script, run here by bash and given a root to search as its first argument, in place of the disk.
    const run = (dir: string, patterns: ScanGroup[], sinceStart: boolean) =>
      scanContainerDisk(
        {
          exec: async (cmd, options) => {
            const [command, ...args] = cmd;

            expect(command).toBe("bash");

            const ran = spawnSync("bash", [...args, "scan", dir], {
              env: { ...process.env, CLOUDPID_START_MARKER: marker, ...options?.env },
            });

            if (ran.error !== undefined) throw ran.error;

            return output(ran.stdout.toString(), ran.status ?? 2);
          },
        },
        patterns,
        { sinceStart },
      );

    const scan = async (dir: string, patterns: ScanGroup[] = scanGroups([SECRET], [])) =>
      (await run(dir, patterns, false)).hits;

    const paths = (hits: ReadonlyArray<ScanHit>) => hits.map((found) => found.path).sort();

    const write = (path: string, content: string) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    };

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "scan-"));
      marker = join(mkdtempSync(join(tmpdir(), "scan-marker-")), "started");
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(dirname(marker), { recursive: true, force: true });
    });

    describe("of the files changed since the Container started", () => {
      /** Long enough for the file system's clock to tell before from after, coarse as Linux's is. */
      const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

      /** The Container starts: the supervisor makes its marker, after what the snapshot or the image holds. */
      const start = async () => {
        await tick();
        writeFileSync(marker, "");
        await tick();
      };

      const since = (patterns: ScanGroup[] = scanGroups([SECRET], [])) => run(root, patterns, true);

      it("skips the files restored from the snapshot, which its own scan searched", async () => {
        write("root/restored", SECRET);
        await start();
        write("root/new", "nothing here");

        expect(await since()).toEqual({ hits: [], sinceStart: true });
        // The whole disk would have found it.
        expect(paths(await scan(root))).toEqual([join(root, "root/restored")]);
      });

      it("finds what a command writes after the start, anywhere on the disk, computerd's store included", async () => {
        write("var/lib/computerd/state.db", "sync state");
        write("root/.config/old", "nothing here");
        await start();
        write("root/.netrc", `machine github.com password ${SECRET}`);
        // A file of the Workspace: computerd's store holds it.
        writeFileSync(join(root, "var/lib/computerd/state.db"), `sync state ${btoa(SECRET)}`, {
          flag: "a",
        });
        write("tmp/deep/down/in/a/cache", `x-access-token:${SECRET}`);
        write("workspace/repo/node_modules/.cache/build.js", SECRET);

        const found = await since();

        expect(found.sinceStart).toBe(true);
        expect(paths(found.hits)).toEqual(
          [
            "root/.netrc",
            "tmp/deep/down/in/a/cache",
            "var/lib/computerd/state.db",
            "workspace/repo/node_modules/.cache/build.js",
          ].map((path) => join(root, path)),
        );
      });

      it("finds a file written after the start with its modification time set back, as `cp -p` or `tar` does", async () => {
        await start();
        write("root/copied", SECRET);
        utimesSync(join(root, "root/copied"), new Date("2001-01-01"), new Date("2001-01-01"));

        expect(paths((await since()).hits)).toEqual([join(root, "root/copied")]);
      });

      it("still skips pnpm's and Bun's stores", async () => {
        await start();
        write(`root/${PNPM_STORE_DIRECTORY_NAME}/v11/files/ab/cdef`, SECRET);
        write("workspace/repo/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/index.js", SECRET);
        write(`root/${BUN_DIRECTORY_NAME}/install/cache/pkg@1.0.0@@@1/index.js`, SECRET);
        write(
          `workspace/repo/node_modules/${BUN_DIRECTORY_NAME}/pkg@1.0.0/node_modules/pkg/index.js`,
          SECRET,
        );

        expect((await since()).hits).toEqual([]);
      });

      it("names what each file holds, as the whole disk's search does", async () => {
        const API: KeptSecret = {
          name: "API_KEY",
          value: "sk-live-0123456789abcdef",
          scope: "environment",
          build: false,
        };

        await start();
        write("app/.env", `API_KEY=${API.value}\n${SECRET}`);

        expect((await since(scanGroups([SECRET], [API]))).hits).toEqual([
          { path: join(root, "app/.env"), found: [TOKEN_LABEL, secretLabel("API_KEY")] },
        ]);
      });

      it("searches many files, in batches", async () => {
        await start();

        for (let index = 0; index < 3000; index++) write(`many/${index}`, "nothing here");

        write("many/last", SECRET);

        expect(paths((await since()).hits)).toEqual([join(root, "many/last")]);
      });

      it("searches the whole disk when the Container has no marker of its start", async () => {
        write("root/restored", SECRET);
        await start();
        rmSync(marker);

        expect(await since()).toEqual({
          hits: [{ path: join(root, "root/restored"), found: [TOKEN_LABEL] }],
          sinceStart: false,
        });
      });

      it("searches the whole disk when the marker's times were set since it was made", async () => {
        write("root/restored", SECRET);
        await start();
        utimesSync(marker, new Date("2001-01-01"), new Date("2001-01-01"));

        expect(await since()).toEqual({
          hits: [{ path: join(root, "root/restored"), found: [TOKEN_LABEL] }],
          sinceStart: false,
        });
      });

      it("fails when the tree cannot be walked, which is not the same as finding nothing", async () => {
        await start();

        await expect(run(join(root, "missing"), scanGroups([SECRET], []), true)).rejects.toThrow(
          /exit/,
        );
      });
    });

    it("finds the token and its base64 forms, and nothing in clean files", async () => {
      write("root/.netrc", `machine github.com password ${SECRET}`);
      write("etc/auth", btoa(`x-access-token:${SECRET}`));
      write("etc/clean", "nothing here");

      expect(paths(await scan(root))).toEqual([join(root, "etc/auth"), join(root, "root/.netrc")]);
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

    it("skips Bun's cache, with its global store, and the isolated linker's store in node_modules", async () => {
      write(
        `root/${BUN_DIRECTORY_NAME}/install/cache/pkg@1.0.0@@@1/index.js`,
        `registry file ${SECRET}`,
      );
      write(
        `root/${BUN_DIRECTORY_NAME}/install/cache/links/pkg@1.0.0-0123abcd/node_modules/pkg/index.js`,
        SECRET,
      );
      write(
        `workspace/repo/node_modules/${BUN_DIRECTORY_NAME}/pkg@1.0.0/node_modules/pkg/index.js`,
        SECRET,
      );

      expect(await scan(root)).toEqual([]);
    });

    it("still searches the rest of node_modules, where tools and commands write", async () => {
      write("workspace/repo/node_modules/.cache/build.js", `const token = "${SECRET}"`);

      expect(paths(await scan(root))).toEqual([
        join(root, "workspace/repo/node_modules/.cache/build.js"),
      ]);
    });

    it("finds an Environment's Secrets among many, whose patterns are split over several variables", async () => {
      const secrets = Array.from({ length: 200 }, (_, index): KeptSecret => ({
        name: `KEY_${index}`,
        value: `${String(index).padStart(4, "0")}-`.repeat(80),
        scope: "every",
        build: false,
      }));

      const last = secrets.at(-1)?.value ?? "";

      write("app/.env", `KEY=${last}`);
      write("app/encoded", btoa(secrets[3]?.value ?? ""));
      write("app/clean", "nothing here");

      const found = [...(await scan(root, scanGroups([SECRET], secrets)))].sort((a, b) =>
        a.path.localeCompare(b.path),
      );

      expect(found).toEqual([
        { path: join(root, "app/.env"), found: [secretLabel("KEY_199")] },
        { path: join(root, "app/encoded"), found: [secretLabel("KEY_3")] },
      ]);
    });

    describe("attributes each file to what it holds", () => {
      const kept = (name: string, value: string): KeptSecret => ({
        name,
        value,
        scope: "environment",
        build: false,
      });

      const API = kept("API_KEY", "sk-live-0123456789abcdef");
      const DB = kept("DB_PASSWORD", "hunter2-hunter2-hunter2");

      const sorted = async (patterns: ScanGroup[]) =>
        [...(await scan(root, patterns))].sort((a, b) => a.path.localeCompare(b.path));

      it("names a token", async () => {
        write("root/.gitconfig", `[url "https://x-access-token:${SECRET}@github.com/"]`);
        write("root/clean", "nothing here");

        expect(await sorted(scanGroups([SECRET], [API]))).toEqual([
          { path: join(root, "root/.gitconfig"), found: [TOKEN_LABEL] },
        ]);
      });

      it("names a kept Secret held as it is and as base64", async () => {
        write("app/.env", `API_KEY=${API.value}`);
        write("app/encoded", `data ${btoa(DB.value)}`);

        expect(await sorted(scanGroups([SECRET], [API, DB]))).toEqual([
          { path: join(root, "app/.env"), found: [secretLabel("API_KEY")] },
          { path: join(root, "app/encoded"), found: [secretLabel("DB_PASSWORD")] },
        ]);
      });

      it("names both in one scan, per file", async () => {
        write("root/.gitconfig", `url = https://x-access-token:${SECRET}@github.com/`);
        write("var/state.db", `${SECRET}\n${API.value}\n${btoa(DB.value)}`);
        write("app/.env", `API_KEY=${API.value}`);
        write("app/clean", "nothing here");

        expect(await sorted(scanGroups([SECRET], [API, DB]))).toEqual([
          { path: join(root, "app/.env"), found: [secretLabel("API_KEY")] },
          { path: join(root, "root/.gitconfig"), found: [TOKEN_LABEL] },
          {
            path: join(root, "var/state.db"),
            found: [TOKEN_LABEL, secretLabel("API_KEY"), secretLabel("DB_PASSWORD")],
          },
        ]);
      });

      it("lists the files beyond the first twenty without saying what they hold", async () => {
        for (let index = 0; index < 25; index++) write(`many/${index}`, SECRET);

        const found = await scan(root);

        expect(found).toHaveLength(25);
        expect(found.filter((file) => file.found.length === 0)).toHaveLength(5);
        expect(found.filter((file) => file.found.length === 1)).toHaveLength(20);
      });
    });

    it("fails when the tree cannot be walked, which is not the same as finding nothing", async () => {
      await expect(scan(join(root, "missing"))).rejects.toThrow(/exit/);
    });
  });

  it("fails when grep itself fails, which is not the same as finding nothing", async () => {
    await expect(
      scanContainerDisk({ exec: async () => output("", 2) }, scanGroups([SECRET], [])),
    ).rejects.toThrow(/exit/);
  });
});
