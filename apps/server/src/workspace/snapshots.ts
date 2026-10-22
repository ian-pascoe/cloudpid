// The Container's disk snapshots (docs/spec.md → Container and Toolchains → Snapshots). A snapshot of the Container's root
// file system, taken after a successful bootstrap that installed something (`ContainerLaunch.afterInstall`) and when the
// Container idles, is restored at the next launch, so the Toolchains come back without a download. The platform keeps the snapshot; the Workspace DO keeps its handle.
//
// - A snapshot holds the Container's own disk only: `/workspace` is a separate (FUSE) mount, but computerd's store behind
//   it is on the disk (`COMPUTERD_DB`), so the Workspace's files are in the snapshot through it and a restored Container
//   is pushed only what changed since; computer's `ignore` paths are as local to the Container as they ever were.
// - It is tied to the image it was taken from, so the handle is kept with the image of the Container it was taken
//   from (not the one a launch would run now: Containers outlive a deploy) and forgotten when a deploy changes it. A
//   Container on an older image than the deployed one is not snapshotted.
// - It is tied to the Container-only paths (computer's `ignore`) the Container launched with, the same way: computerd's
//   store and the disk's copies of those paths are laid out for them, so a launch with others starts from the image.
// - A snapshot lives 30 days from its creation or latest restore, so one that is near that is not restored.
// - The disk is searched for the GitHub token before a snapshot (`scanContainerDisk`: everything but the pseudo file
//   systems, the Workspace mount and pnpm's stores, for the token and its common base64 forms), and a snapshot that
//   cannot be shown clean is not taken. The bootstrap keeps the token off disk (git reads it from the environment), so
//   this is for what a command wrote; a token encoded some other way is not found.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off preferEffectArray:off missingPipeableSignature:off
import { PNPM_STORE_DIRECTORY_NAME } from "@cloudpid/sandbox-image/toolchains";

/** A snapshot lives 30 days from its creation or latest restore; one older than this is not trusted to still be there. */
const MAX_AGE_MS = 29 * 24 * 60 * 60_000;

/** Why a snapshot was taken. */
export type SnapshotReason = "install" | "idle";

/** What the Workspace DO keeps of a snapshot: the platform's handle, and what it needs to decide to restore it. */
export type SnapshotRecord = {
  readonly id: string;
  /** Bytes. */
  readonly size: number;
  /** Epoch milliseconds. */
  readonly takenAt: number;
  /** When its 30-day lifetime last began: `takenAt`, or the latest restore. Epoch milliseconds. */
  readonly refreshedAt: number;
  /** How long taking it took, scan included, in milliseconds. */
  readonly tookMs: number;
  /** The reference of the image the Container ran, which the snapshot is not portable beyond. */
  readonly image: string | undefined;
  /** The Container-only paths the Container launched with; none where it had none. Absent from older records. */
  readonly ignore?: readonly string[] | undefined;
  readonly reason: SnapshotReason;
};

export type ContainerSnapshotDeps = {
  /** Off where the Container is not the real thing (`alchemy dev`), which has no snapshots. */
  readonly enabled: boolean;
  /** The GitHub token commands run with, to keep off the snapshot; none means nothing to scan for. */
  readonly secret: string | undefined;
  /** How long a snapshot, its scan included, may take before it is given up on. An install's is short: commands wait. */
  readonly timeoutMs: Readonly<Record<SnapshotReason, number>>;
  /** The reference of the image a Container launched now would run. */
  readonly image: () => string | undefined;
  readonly running: () => boolean;
  /** The platform's `snapshotContainer`. */
  readonly snapshot: (name: string) => Promise<{ readonly id: string; readonly size: number }>;
  /** The paths on the Container's disk whose content holds `secret`, in a few encodings. */
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

  /**
   * Snapshot the running Container, which runs `image`. Never rejects: a snapshot is an optimisation, and what failed is
   * reported. A Container on an image other than the deployed one is not snapshotted.
   */
  take(
    reason: SnapshotReason,
    image: string | undefined,
    ignore?: readonly string[],
  ): Promise<SnapshotOutcome> {
    if (this.#inflight !== undefined) return this.#inflight;

    const inflight = this.#take(reason, image, ignore).finally(() => {
      this.#inflight = undefined;
    });

    this.#inflight = inflight;

    return inflight;
  }

  /**
   * The snapshot to start the next Container from, if there is a live one of the image it would run, taken with the
   * Container-only paths it launches with (`ignore`).
   */
  async restorable(
    ignore?: readonly string[],
  ): Promise<{ readonly id: string; readonly image: string | undefined } | undefined> {
    if (!this.#deps.enabled) return undefined;

    const record = await this.#deps.load();

    if (record === undefined) return undefined;

    // A deploy changed the image (the snapshot is not portable to it), the Container-only paths changed, or the snapshot
    // is about to expire: a new one is taken from the next Container that starts from the image.
    if (
      record.image !== this.#deps.image() ||
      !samePaths(record.ignore, ignore) ||
      this.#deps.now() - record.refreshedAt > MAX_AGE_MS
    ) {
      await this.#deps.clear();

      return undefined;
    }

    return { id: record.id, image: record.image };
  }

  /** A Container started from the kept snapshot, which begins its lifetime again. */
  async restored(): Promise<void> {
    const record = await this.#deps.load();

    if (record !== undefined) await this.#deps.save({ ...record, refreshedAt: this.#deps.now() });
  }

  /** Drop the kept snapshot, because a Container started from it did not come up. */
  forget(): Promise<void> {
    return this.#deps.clear();
  }

  async #take(
    reason: SnapshotReason,
    image: string | undefined,
    ignore: readonly string[] | undefined,
  ): Promise<SnapshotOutcome> {
    const deps = this.#deps;

    if (!deps.enabled || !deps.running()) return "skipped";

    if (image !== deps.image()) {
      deps.warn(
        `Container snapshot (${reason}) skipped: the Container runs an older image than the deployed one, or its image is not known`,
      );

      return "skipped";
    }

    const started = deps.now();

    try {
      const taken = await this.#within(reason, async () => {
        if (deps.secret !== undefined && deps.secret !== "") {
          const leaks = await deps.scan(deps.secret);

          if (leaks.length > 0) {
            deps.warn(
              `Container snapshot skipped: the GitHub token is in ${leaks.slice(0, 5).join(", ")}${leaks.length > 5 ? ` and ${leaks.length - 5} more` : ""}`,
            );

            return undefined;
          }
        }

        return deps.snapshot(`workspace-${reason}`);
      });

      if (taken === undefined) return "skipped";

      await deps.save({
        id: taken.id,
        size: taken.size,
        takenAt: deps.now(),
        refreshedAt: deps.now(),
        tookMs: deps.now() - started,
        image,
        ignore,
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

  /** `work`, unless it takes longer than the reason's time. */
  #within<A>(reason: SnapshotReason, work: () => Promise<A>): Promise<A> {
    const timeoutMs = this.#deps.timeoutMs[reason];
    let timer: ReturnType<typeof setTimeout> | undefined;

    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`the snapshot did not finish in ${timeoutMs / 1000} s`));
      }, timeoutMs);
    });

    return Promise.race([work(), expired]).finally(() => {
      clearTimeout(timer);
    });
  }
}

/**
 * Whether two lists of Container-only paths are the same, in the same order (the last match wins). No list (an older
 * record, or a Container that has none) is the same only as no list.
 */
export const samePaths = (
  a: readonly string[] | undefined,
  b: readonly string[] | undefined,
): boolean =>
  a === undefined || b === undefined
    ? a === b
    : a.length === b.length && a.every((pattern, index) => pattern === b[index]);

/**
 * Lists the files that hold any of the patterns in `CLOUDPID_SCAN_SECRET` (one per line), anywhere on the Container's
 * disk except the pseudo file systems (`/proc`, `/sys`, `/dev`, `/run`) and the Workspace mount (`/workspace`, whose
 * files are searched in computerd's store); the directories given as arguments instead, if any (for the tests).
 *
 * Directories named `.pnpm-store` or `.pnpm` are not searched: pnpm's store (`/root/.pnpm-store`, which the Container's
 * global pnpm configuration names, `PNPM_STORE_DIRECTORY_NAME`, with the global virtual store in it, `v11/links`) and
 * the project virtual store in `node_modules` (`.pnpm`, an older install's, or a repo that chose that layout) hold only
 * the packages pnpm installed, and after an install they are most of the disk (a cold search after this repo's, with
 * the store at the mount's root and a virtual store in `node_modules`, took 62 s, 7 s without them). The rest of `node_modules` (`.cache`, `.vite`, what a command wrote there) is
 * searched.
 *
 * The patterns reach grep as a pattern file on its standard input, read from the environment, so they are in no command
 * line.
 */
const SCAN_SCRIPT = [
  'if [ "$#" -eq 0 ]; then',
  "  for d in /*; do",
  '    case "$d" in /proc|/sys|/dev|/run|/workspace) continue ;; esac',
  '    [ -L "$d" ] && continue',
  '    [ -d "$d" ] && set -- "$@" "$d"',
  "  done",
  "fi",
  `printf '%s\\n' "$CLOUDPID_SCAN_SECRET" | grep -rlF --exclude-dir=${PNPM_STORE_DIRECTORY_NAME} --exclude-dir=.pnpm -f - -- "$@"`,
].join("\n");

/** What the scan needs of the platform's `ctx.container`. */
export type ContainerExec = {
  readonly exec: (
    cmd: string[],
    options?: { readonly env?: Record<string, string>; readonly signal?: AbortSignal },
  ) => Promise<{
    readonly output: () => Promise<{
      readonly stdout: ArrayBuffer;
      readonly stderr: ArrayBuffer;
      readonly exitCode: number;
    }>;
  }>;
};

/** The forms of a token a tool writes: as it is, and base64 of it and of the `x-access-token:` basic-auth pair. */
export const secretForms = (secret: string): ReadonlyArray<string> => [
  secret,
  btoa(secret),
  btoa(`x-access-token:${secret}`),
];

/**
 * The files on the Container's disk whose content holds `secret` (`secretForms`), found by a process of its own in the
 * Container (`ctx.container.exec`), so it needs no connection to computerd, which the idle stop's alarm may not have.
 * Rejects when the search could not be run to the end, or took longer than `timeoutMs` (the process is then killed): a
 * disk that could not be searched is not shown to be clean.
 */
export const scanContainerDisk = async (
  container: ContainerExec,
  secret: string,
  timeoutMs = 30_000,
): Promise<ReadonlyArray<string>> => {
  const controller = new AbortController();

  const process = await container.exec(["bash", "-c", SCAN_SCRIPT], {
    env: { CLOUDPID_SCAN_SECRET: secretForms(secret).join("\n") },
    signal: controller.signal,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;

  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Only while it runs: the signal of a process that has exited raises an error in the Durable Object.
      controller.abort();
      reject(new Error(`the scan for the token did not finish in ${timeoutMs / 1000} s`));
    }, timeoutMs);
  });

  const { stdout, exitCode } = await Promise.race([process.output(), expired]).finally(() => {
    clearTimeout(timer);
  });

  // grep: 0 a file matched, 1 none did, 2 or more it could not read something.
  if (exitCode > 1) throw new Error(`the scan for the token ended with exit status ${exitCode}`);

  return new TextDecoder()
    .decode(stdout)
    .split("\n")
    .filter((line) => line !== "");
};
