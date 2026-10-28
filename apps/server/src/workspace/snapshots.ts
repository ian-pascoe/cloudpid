// The Container's disk snapshots (docs/architecture/container.md → Snapshots). A snapshot of the Container's root
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
// - The disk is searched for the GitHub token and the Environment's kept Secrets before a snapshot
//   (`scanContainerDisk`: everything but the pseudo file systems, the Workspace mount and pnpm's stores, for each as it
//   is and in base64: `scanGroups`), and a snapshot that cannot be shown clean is not taken, nor one of a Workspace
//   that cannot show which Secrets to search for. The bootstrap keeps the token off disk (git reads it from the
//   environment), so this is for what a command wrote; a value encoded some other way is not found. The warning for a
//   refused snapshot names, per file, what it holds: "a GitHub token" or "the Secret `NAME`", never a value.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off preferEffectArray:off preferEffectRecord:off missingPipeableSignature:off
import type { KeptSecret } from "@cloudpid/extensions/secrets/core";
import { base64, PNPM_STORE_DIRECTORY_NAME } from "@cloudpid/sandbox-image/toolchains";
import type { HeldSecrets } from "./environment-secrets.ts";

/**
 * How long a snapshot, its scan included, may take before it is given up on, after the install and on idle stop alike.
 * The commands that wait for the bootstrap are held for the install's, so it is not short: the disk after this repo's
 * install is 1.2–1.3 GB, and snapshots of that size took 45–64 s (idle stops, and one install snapshot of 50.9 s); one of
 * 2.67 GB took 90.4 s (#156). A snapshot given up on at 60 s was lost: the platform's `snapshotContainer` ran on, with
 * its handle dropped.
 */
export const SNAPSHOT_TIMEOUT_MS = 2 * 60_000;

/** A snapshot lives 30 days from its creation or latest restore; one older than this is not trusted to still be there. */
export const SNAPSHOT_MAX_AGE_MS = 29 * 24 * 60 * 60_000;

/**
 * Why a snapshot was taken: after an install, on idle stop, before the agent's resize stops the Container (`resize.ts`), or
 * as an Environment's Build (`build.ts`).
 */
export type SnapshotReason = "install" | "idle" | "resize" | "build";

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
  /**
   * The GitHub tokens handed to commands that have not expired, to keep off the snapshot (one that has expired is
   * harmless); none means no token to scan for.
   */
  readonly tokens: () => ReadonlyArray<string>;
  /**
   * The Environment's kept Secrets the Workspace holds, to keep off the snapshot too; when it cannot show them, no
   * snapshot is taken. Without it, there are none.
   */
  readonly secrets?: (() => Promise<HeldSecrets>) | undefined;
  /** How long a snapshot, its scan included, may take before it is given up on (`SNAPSHOT_TIMEOUT_MS`). */
  readonly timeoutMs: number;
  /** The reference of the image a Container launched now would run. */
  readonly image: () => string | undefined;
  readonly running: () => boolean;
  /** The platform's `snapshotContainer`. */
  readonly snapshot: (name: string) => Promise<{ readonly id: string; readonly size: number }>;
  /** The files on the Container's disk whose content holds any of `groups` (`scanGroups`), and which. */
  readonly scan: (groups: ReadonlyArray<ScanGroup>) => Promise<ReadonlyArray<ScanHit>>;
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

/** A snapshot taken (the platform's handle, its size in bytes, and how long it took), or why it was not. */
export type SnapshotCapture =
  | {
      readonly outcome: "taken";
      readonly id: string;
      readonly size: number;
      readonly tookMs: number;
    }
  | { readonly outcome: "skipped" | "failed"; readonly reason: string };

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
      this.#deps.now() - record.refreshedAt > SNAPSHOT_MAX_AGE_MS
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

  /**
   * Snapshot the running Container, which runs `image`, after the scan for the token, without keeping it: what an
   * Environment's Build keeps itself. Never rejects: what stopped it is the answer's `reason` (never with the token).
   */
  async capture(reason: SnapshotReason, image: string | undefined): Promise<SnapshotCapture> {
    const deps = this.#deps;

    if (!deps.enabled) return { outcome: "skipped", reason: "snapshots are off here" };

    if (!deps.running()) return { outcome: "skipped", reason: "no Container is running" };

    if (image !== deps.image()) {
      return {
        outcome: "skipped",
        reason:
          "the Container runs an older image than the deployed one, or its image is not known",
      };
    }

    const started = deps.now();

    try {
      const taken = await this.#within(async () => {
        const held = (await deps.secrets?.()) ?? { ok: true, secrets: [] };

        if (!held.ok) return { leaked: true, reason: held.reason } as const;

        const groups = scanGroups(deps.tokens(), held.secrets);

        if (groups.length > 0) {
          const hits = await deps.scan(groups);

          if (hits.length > 0) return { leaked: true, reason: leakReason(hits) } as const;
        }

        return { leaked: false, snapshot: await deps.snapshot(`workspace-${reason}`) } as const;
      });

      if (taken.leaked) return { outcome: "skipped", reason: taken.reason };

      const { id, size } = taken.snapshot;

      return { outcome: "taken", id, size, tookMs: deps.now() - started };
    } catch (cause) {
      return { outcome: "failed", reason: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  async #take(
    reason: SnapshotReason,
    image: string | undefined,
    ignore: readonly string[] | undefined,
  ): Promise<SnapshotOutcome> {
    const deps = this.#deps;
    const captured = await this.capture(reason, image);

    if (captured.outcome !== "taken") {
      // Nothing to snapshot (off here, or no Container) is not worth a warning.
      if (deps.enabled && deps.running()) {
        deps.warn(
          captured.outcome === "failed"
            ? `Container snapshot (${reason}) failed: ${captured.reason}`
            : `Container snapshot (${reason}) skipped: ${captured.reason}`,
        );
      }

      return captured.outcome;
    }

    try {
      await deps.save({
        id: captured.id,
        size: captured.size,
        takenAt: deps.now(),
        refreshedAt: deps.now(),
        tookMs: captured.tookMs,
        image,
        ignore,
        reason,
      });
    } catch (cause) {
      deps.warn(
        `Container snapshot (${reason}) failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );

      return "failed";
    }

    deps.info(
      `Container snapshot (${reason}) taken: ${Math.round(captured.size / 1e6)} MB in ${captured.tookMs} ms`,
    );

    return "taken";
  }

  /** `work`, unless it takes longer than the time allowed. */
  #within<A>(work: () => Promise<A>): Promise<A> {
    const { timeoutMs } = this.#deps;
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

/** The prefix of the variables the patterns reach grep in: `CLOUDPID_SCAN_SECRET_<group>_<part>`. */
const SCAN_VARIABLE = "CLOUDPID_SCAN_SECRET";

/** The variable that says how many groups of patterns there are (a count, no secret). */
const SCAN_COUNT_VARIABLE = "CLOUDPID_SCAN_COUNT";

/** How many files the scan attributes to the groups that hold them; the warning names five. */
const ATTRIBUTED_FILES = 20;

/**
 * Lists the files that hold any of the patterns in the variables named `CLOUDPID_SCAN_SECRET_<group>_<part>` (one
 * pattern per line, a group's patterns split over parts so no variable is near the kernel's limit on one), anywhere on
 * the Container's disk except the pseudo file systems (`/proc`, `/sys`, `/dev`, `/run`) and the Workspace mount
 * (`/workspace`, whose files are searched in computerd's store); the directories given as arguments instead, if any
 * (for the tests).
 *
 * Directories named `.pnpm-store` or `.pnpm` are not searched: pnpm's store (`/root/.pnpm-store`, which the Container's
 * global pnpm configuration names, `PNPM_STORE_DIRECTORY_NAME`, with the global virtual store in it, `v11/links`) and
 * the project virtual store in `node_modules` (`.pnpm`, an older install's, or a repo that chose that layout) hold only
 * the packages pnpm installed, and after an install they are most of the disk (a cold search after this repo's, with
 * the store at the mount's root and a virtual store in `node_modules`, took 62 s, 7 s without them). The rest of `node_modules` (`.cache`, `.vite`, what a command wrote there) is
 * searched.
 *
 * The patterns reach grep as a pattern file on its standard input, read from the environment, so they are in no command
 * line. One search over all of them finds the files; then, for the first `ATTRIBUTED_FILES` of those only, a search per
 * group tells which group holds each. A line of the output is the groups' numbers, separated by commas (none for a
 * file beyond those), a tab, and the path.
 */
const SCAN_SCRIPT = [
  'if [ "$#" -eq 0 ]; then',
  "  for d in /*; do",
  '    case "$d" in /proc|/sys|/dev|/run|/workspace) continue ;; esac',
  '    [ -L "$d" ] && continue',
  '    [ -d "$d" ] && set -- "$@" "$d"',
  "  done",
  "fi",
  `found=$(for name in "\${!${SCAN_VARIABLE}@}"; do printf '%s\\n' "\${!name}"; done | grep -rlF --exclude-dir=${PNPM_STORE_DIRECTORY_NAME} --exclude-dir=.pnpm -f - -- "$@")`,
  "status=$?",
  '[ "$status" -gt 1 ] && exit "$status"',
  "count=0",
  "while IFS= read -r file; do",
  '  [ -z "$file" ] && continue',
  "  count=$((count + 1))",
  '  groups=""',
  `  if [ "$count" -le ${ATTRIBUTED_FILES} ]; then`,
  `    for ((i = 0; i < ${SCAN_COUNT_VARIABLE}; i++)); do`,
  `      for name in $(compgen -A variable "${SCAN_VARIABLE}_\${i}_"); do printf '%s\\n' "\${!name}"; done | grep -qF -f - -- "$file" && groups="$groups,$i"`,
  "    done",
  "  fi",
  `  printf '%s\\t%s\\n' "\${groups#,}" "$file"`,
  'done <<< "$found"',
  'exit "$status"',
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
 * A kept Secret shorter than this is not searched for: it would be found by chance in unrelated files, and keep every
 * snapshot from being taken (the redaction's own bound, `MIN_ENCODED_REDACTION_LENGTH`).
 */
export const MIN_SCANNED_LENGTH = 8;

/** The longest pattern searched for one form of a Secret: a part of it, which every file holding it holds. */
export const SCANNED_EXCERPT_LENGTH = 256;

/** At most `SCANNED_EXCERPT_LENGTH` characters from the middle of `text`, whole code points. */
const excerpt = (text: string): string => {
  const points = Array.from(text);

  if (points.length <= SCANNED_EXCERPT_LENGTH) return text;

  const start = Math.floor((points.length - SCANNED_EXCERPT_LENGTH) / 2);

  return points.slice(start, start + SCANNED_EXCERPT_LENGTH).join("");
};

/**
 * What the scan searches for on behalf of one kind of match: the patterns (one line each, as `grep -F` takes them) and
 * the words the warning names it by, which hold no value.
 */
export type ScanGroup = { readonly label: string; readonly patterns: ReadonlyArray<string> };

/** The label of the group of every GitHub token the Workspace DO minted. */
export const TOKEN_LABEL = "a GitHub token";

/** The label of the group of a kept Secret: its name, never its value. */
export const secretLabel = (name: string): string => `the Secret \`${name}\``;

/** A file the scan found, and the labels of the groups that hold it (none for one it did not attribute). */
export type ScanHit = { readonly path: string; readonly found: ReadonlyArray<string> };

/**
 * What the scan before a snapshot searches for, a group per kind of match: the GitHub tokens (`TOKEN_LABEL`), each in
 * its forms (`secretForms`), and each kept Secret (`secretLabel`) as it is and as base64 of its UTF-8, each cut to a
 * part of its middle when long. A Secret of several lines is searched for by its longest line (a key's body, not a
 * header any file can hold), which every file holding the whole value holds. A Secret shorter than
 * `MIN_SCANNED_LENGTH` is not searched for. A group with nothing to search for is left out.
 */
export const scanGroups = (
  tokens: ReadonlyArray<string>,
  secrets: ReadonlyArray<KeptSecret>,
): ScanGroup[] => {
  const groups: ScanGroup[] = [];
  const tokenPatterns = tokens.flatMap((token) => (token === "" ? [] : secretForms(token)));

  if (tokenPatterns.length > 0) groups.push({ label: TOKEN_LABEL, patterns: tokenPatterns });

  for (const { name, value } of secrets) {
    if (value.length < MIN_SCANNED_LENGTH) continue;

    const longest = value
      .split(/\r?\n/)
      .reduce((best, line) => (line.length > best.length ? line : best), "");

    const patterns = [excerpt(longest), excerpt(base64(value))].filter(
      (form, index, forms) => form.length >= MIN_SCANNED_LENGTH && forms.indexOf(form) === index,
    );

    if (patterns.length > 0) groups.push({ label: secretLabel(name), patterns });
  }

  return groups;
};

/** The files named in a warning; the others are counted. */
const NAMED_FILES = 5;

/** `a`, `a and b`, `a, b and c`. */
const joinLabels = (labels: ReadonlyArray<string>): string =>
  labels.length < 2
    ? (labels[0] ?? "")
    : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1) ?? ""}`;

/**
 * Why a scan that found `hits` refused the snapshot: what each of the first files holds ("a GitHub token", "the Secret
 * `NAME`"), never a value. A hit that names a Secret adds where a value that is not secret belongs.
 */
export const leakReason = (hits: ReadonlyArray<ScanHit>): string => {
  const files = hits.slice(0, NAMED_FILES).map(({ path, found }) => {
    const labels = [...new Set(found)];

    return `${labels.length === 0 ? "a GitHub token or a Secret kept for the Environment" : joinLabels(labels)} in ${path}`;
  });

  const more = hits.length > NAMED_FILES ? ` and ${hits.length - NAMED_FILES} more files` : "";

  // A value that is not secret is a variable, not a Secret: only the message says so, not what the scan finds.
  const hint = hits.some(({ found }) => found.some((label) => label !== TOKEN_LABEL))
    ? "; a value that is not secret belongs in the variables (kept for the Environment or for every Environment)"
    : "";

  return `${files.join("; ")}${more}${hint}`;
};

/** How much of the patterns one variable carries: well under Linux's 128 KiB for one environment string. */
const SCAN_VARIABLE_BYTES = 64 * 1024;

/**
 * The groups' patterns, one per line, in variables `CLOUDPID_SCAN_SECRET_<group>_<part>`, a group split over as many as
 * its size needs, and the number of groups in `CLOUDPID_SCAN_COUNT`.
 */
const scanEnvironment = (groups: ReadonlyArray<ScanGroup>) =>
  Object.fromEntries([
    [SCAN_COUNT_VARIABLE, String(groups.length)],
    ...groups.flatMap(({ patterns }, group) => {
      const parts: string[][] = [[]];
      let size = 0;

      for (const pattern of patterns) {
        const bytes = new TextEncoder().encode(pattern).length + 1;
        const current = parts.at(-1) ?? [];

        if (size + bytes > SCAN_VARIABLE_BYTES && current.length > 0) {
          parts.push([pattern]);
          size = bytes;
        } else {
          current.push(pattern);
          size += bytes;
        }
      }

      return parts.map((part, index) => [`${SCAN_VARIABLE}_${group}_${index}`, part.join("\n")]);
    }),
  ]);

/**
 * The files on the Container's disk whose content holds any of the patterns of `groups` (`scanGroups`), and the labels
 * of the groups that hold each, found by a process of its
 * own in the Container (`ctx.container.exec`), so it needs no connection to computerd, which the idle stop's alarm may
 * not have. Rejects when the search could not be run to the end, or took longer than `timeoutMs` (the process is then
 * killed): a disk that could not be searched is not shown to be clean. No patterns, nothing to search for. Only the
 * patterns are sent to the Container, the labels are matched to the groups here.
 */
export const scanContainerDisk = async (
  container: ContainerExec,
  groups: ReadonlyArray<ScanGroup>,
  timeoutMs = 30_000,
): Promise<ReadonlyArray<ScanHit>> => {
  // An empty pattern would match every file.
  const searched = groups.flatMap(({ label, patterns }) => {
    const kept = patterns.filter((pattern) => pattern !== "");

    return kept.length > 0 ? [{ label, patterns: kept }] : [];
  });

  if (searched.length === 0) return [];

  const controller = new AbortController();

  const process = await container.exec(["bash", "-c", SCAN_SCRIPT], {
    env: scanEnvironment(searched),
    signal: controller.signal,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;

  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Only while it runs: the signal of a process that has exited raises an error in the Durable Object.
      controller.abort();
      reject(new Error(`the scan for Secrets did not finish in ${timeoutMs / 1000} s`));
    }, timeoutMs);
  });

  const { stdout, exitCode } = await Promise.race([process.output(), expired]).finally(() => {
    clearTimeout(timer);
  });

  // grep: 0 a file matched, 1 none did, 2 or more it could not read something.
  if (exitCode > 1) throw new Error(`the scan for Secrets ended with exit status ${exitCode}`);

  return new TextDecoder()
    .decode(stdout)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      const numbers = tab < 0 ? "" : line.slice(0, tab);

      return {
        path: tab < 0 ? line : line.slice(tab + 1),
        found:
          numbers === "" ? [] : numbers.split(",").flatMap((n) => searched[Number(n)]?.label ?? []),
      };
    });
};
