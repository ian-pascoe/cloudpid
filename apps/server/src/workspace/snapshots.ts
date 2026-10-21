// The Container's disk snapshots (docs/spec.md → Container and Toolchains → Snapshots). A snapshot of the Container's root
// file system, taken after a successful `mise install` and when the Container idles, is restored at the next launch, so
// the Toolchains come back without a download. The platform keeps the snapshot; the Workspace DO keeps its handle.
//
// - A snapshot holds the Container's own disk only: `/workspace` is a separate (FUSE) mount, so the files the Workspace
//   syncs are not in it (the Workspace DO pushes them again at every launch), and computer's `ignore` paths are as local
//   to the Container as they ever were.
// - It is tied to the image it was taken from, so the handle is kept with the image's reference and forgotten when a
//   deploy changes it.
// - Nothing holding the GitHub token is snapshotted: the disk is scanned for it first, and a snapshot that cannot be
//   shown clean is not taken. The bootstrap keeps the token off disk (git reads it from the environment), so this is for
//   what a command wrote.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off preferEffectArray:off missingPipeableSignature:off

/** Why a snapshot was taken. */
export type SnapshotReason = "install" | "idle";

/** What the Workspace DO keeps of a snapshot: the platform's handle, and what it needs to decide to restore it. */
export type SnapshotRecord = {
  readonly id: string;
  /** Bytes. */
  readonly size: number;
  /** Epoch milliseconds. */
  readonly takenAt: number;
  /** How long taking it took, scan included, in milliseconds. */
  readonly tookMs: number;
  /** The reference of the image the Container ran, which the snapshot is not portable beyond. */
  readonly image: string | undefined;
  readonly reason: SnapshotReason;
};

export type ContainerSnapshotDeps = {
  /** Off where the Container is not the real thing (`alchemy dev`), which has no snapshots. */
  readonly enabled: boolean;
  /** The GitHub token commands run with, to keep off the snapshot; none means nothing to scan for. */
  readonly secret: string | undefined;
  /** How long a snapshot may take before it is given up on. */
  readonly timeoutMs: number;
  /** The reference of the image a Container launched now would run. */
  readonly image: () => string | undefined;
  readonly running: () => boolean;
  /** The platform's `snapshotContainer`. */
  readonly snapshot: (name: string) => Promise<{ readonly id: string; readonly size: number }>;
  /** The paths on the Container's disk whose content holds `secret`. */
  readonly scan: (secret: string) => Promise<ReadonlyArray<string>>;
  readonly load: () => Promise<SnapshotRecord | undefined>;
  readonly save: (record: SnapshotRecord) => Promise<void>;
  readonly clear: () => Promise<void>;
  readonly now: () => number;
  /** Where a snapshot that was not taken is reported (never with the token). */
  readonly warn: (message: string) => void;
  /** Where a snapshot that was taken is reported. */
  readonly info: (message: string) => void;
};

/** `taken`, `skipped` (nothing to snapshot, or one that would hold the token), or `failed` (it could not be taken). */
export type SnapshotOutcome = "taken" | "skipped" | "failed";

export class ContainerSnapshots {
  readonly #deps: ContainerSnapshotDeps;
  #inflight: Promise<SnapshotOutcome> | undefined;

  constructor(deps: ContainerSnapshotDeps) {
    this.#deps = deps;
  }

  /** Snapshot the running Container. Never rejects: a snapshot is an optimisation, and what failed is reported. */
  take(reason: SnapshotReason): Promise<SnapshotOutcome> {
    if (this.#inflight !== undefined) return this.#inflight;

    const inflight = this.#take(reason).finally(() => {
      this.#inflight = undefined;
    });

    this.#inflight = inflight;

    return inflight;
  }

  /** The snapshot to start the next Container from, if there is one of the image it would run. */
  async restorable(): Promise<{ readonly id: string } | undefined> {
    if (!this.#deps.enabled) return undefined;

    const record = await this.#deps.load();

    if (record === undefined) return undefined;

    if (record.image !== this.#deps.image()) {
      // A deploy changed the image: the snapshot is not portable to it, and a new one is taken from its Container.
      await this.#deps.clear();

      return undefined;
    }

    return { id: record.id };
  }

  /** Drop the kept snapshot, because a Container started from it did not come up. */
  forget(): Promise<void> {
    return this.#deps.clear();
  }

  async #take(reason: SnapshotReason): Promise<SnapshotOutcome> {
    const deps = this.#deps;

    if (!deps.enabled || !deps.running()) return "skipped";

    const started = deps.now();

    try {
      if (deps.secret !== undefined && deps.secret !== "") {
        const leaks = await deps.scan(deps.secret);

        if (leaks.length > 0) {
          deps.warn(
            `Container snapshot skipped: the GitHub token is in ${leaks.slice(0, 5).join(", ")}${leaks.length > 5 ? ` and ${leaks.length - 5} more` : ""}`,
          );

          return "skipped";
        }
      }

      const taken = await this.#within(deps.snapshot(`workspace-${reason}`));

      await deps.save({
        id: taken.id,
        size: taken.size,
        takenAt: deps.now(),
        tookMs: deps.now() - started,
        image: deps.image(),
        reason,
      });

      deps.info(
        `Container snapshot (${reason}) taken: ${Math.round(taken.size / 1e6)} MB in ${deps.now() - started} ms`,
      );

      return "taken";
    } catch (cause) {
      deps.warn(
        `Container snapshot (${reason}) failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );

      return "failed";
    }
  }

  /** `work`, unless it takes longer than the timeout. */
  #within<A>(work: Promise<A>): Promise<A> {
    const { timeoutMs } = this.#deps;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`the snapshot did not finish in ${timeoutMs / 1000} s`));
      }, timeoutMs);
    });

    return Promise.race([work, expired]).finally(() => {
      clearTimeout(timer);
    });
  }
}

/** The directories a snapshot holds that anything but the image writes to. Not `/workspace`, a separate mount. */
const SCAN_ROOTS = ["/root", "/home", "/tmp", "/etc", "/var", "/opt", "/srv", "/usr/local", "/mnt"];

/**
 * Looks for `secret` in `roots` (given as arguments, so only those that exist are searched) and lists the files that
 * hold it. The secret reaches grep as a pattern file on its standard input, read from the environment, so it is in no
 * command line.
 */
const SCAN_SCRIPT = [
  'roots=(); for d in "$@"; do [ -d "$d" ] && roots+=("$d"); done',
  'printf \'%s\\n\' "$CLOUDPID_SCAN_SECRET" | grep -rlF -f - -- "${roots[@]}"',
].join("\n");

/** What the scan needs of the platform's `ctx.container`. */
export type ContainerExec = {
  readonly exec: (
    cmd: string[],
    options?: { readonly env?: Record<string, string> },
  ) => Promise<{
    readonly output: () => Promise<{
      readonly stdout: ArrayBuffer;
      readonly stderr: ArrayBuffer;
      readonly exitCode: number;
    }>;
  }>;
};

/**
 * The files on the Container's disk whose content holds `secret`, found by a process of its own in the Container
 * (`ctx.container.exec`), so it needs no connection to computerd, which the idle stop's alarm may not have. Rejects when
 * the search could not be run to the end: a disk that could not be searched is not shown to be clean.
 */
export const scanContainerDisk = async (
  container: ContainerExec,
  secret: string,
): Promise<ReadonlyArray<string>> => {
  const process = await container.exec(["bash", "-c", SCAN_SCRIPT, "scan", ...SCAN_ROOTS], {
    env: { CLOUDPID_SCAN_SECRET: secret },
  });

  const { stdout, exitCode } = await process.output();

  // grep: 0 a file matched, 1 none did, 2 or more it could not read something.
  if (exitCode > 1) throw new Error(`the scan for the token ended with exit status ${exitCode}`);

  return new TextDecoder()
    .decode(stdout)
    .split("\n")
    .filter((line) => line !== "");
};
