// A polling `FileWatcher`: the Workspace has no change notifications for its files, so the watcher asks the Workspace
// DO for a snapshot of what it covers at an interval and reports the differences, the way pi-durable's
// `NodeFileWatcher` does in polling mode.
// pi-durable's `ExecutionEnv` is Promise-native and stays so (ADR-0003); this adapter follows it.
// @effect-diagnostics asyncFunction:off globalTimers:off preferEffectArray:off
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FileWatcher, WatchChange } from "@earendil-works/pi-durable/env";
import type { Call } from "./client.ts";
import { isWithin } from "./paths.ts";
import type { ScanTarget, Snapshot } from "./wire.ts";

export type PollingOptions = {
  /** Interval between snapshots; default 250 ms. */
  readonly pollIntervalMs?: number;
  /** Most directories one watcher covers; default 10,000. */
  readonly maxDirectories?: number;
};

const DEFAULT_POLL_MS = 250;
const DEFAULT_MAX_DIRECTORIES = 10_000;

export class PollingWatcher implements FileWatcher {
  readonly mode = "polling";
  readonly #call: Call;
  readonly #targets: readonly ScanTarget[];
  readonly #onChange: (change: WatchChange) => void;
  readonly #intervalMs: number;
  readonly #maxDirectories: number;
  #snapshot = new Map<string, string>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #closed = false;

  private constructor(
    call: Call,
    targets: readonly ScanTarget[],
    onChange: (change: WatchChange) => void,
    options: PollingOptions,
  ) {
    this.#call = call;
    this.#targets = targets;
    this.#onChange = onChange;
    this.#intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.#maxDirectories = options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES;
  }

  /** Establish coverage with a first snapshot, then poll. Fails like the snapshot does. */
  static async open(
    call: Call,
    targets: readonly ScanTarget[],
    onChange: (change: WatchChange) => void,
    options: PollingOptions,
    context: Context,
  ) {
    const watcher = new PollingWatcher(call, targets, onChange, options);
    const first = await watcher.#scan(context);

    if (!first.ok) return first;
    watcher.#snapshot = new Map(first.value);
    watcher.#schedule();

    return { ok: true as const, value: watcher };
  }

  async close(_context: Context): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  #scan(context: Context) {
    return this.#call(context, "scan", this.#targets, this.#maxDirectories);
  }

  #schedule(): void {
    if (this.#closed) return;

    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#running = this.#poll().finally(() => {
        this.#running = undefined;
        this.#schedule();
      });
    }, this.#intervalMs);
  }

  async #poll(): Promise<void> {
    const next = await this.#scan(BACKGROUND_CONTEXT);

    if (this.#closed) return;

    if (!next.ok) {
      this.#deliver({ error: next.error });
      this.#closed = true;

      return;
    }

    const snapshot = new Map(next.value);
    const changed = this.#diff(snapshot);

    this.#snapshot = snapshot;

    if (changed.size > 0) this.#deliver({ paths: [...changed].sort() });
  }

  #diff(next: ReadonlyMap<string, string>): Set<string> {
    const changed = new Set<string>();

    for (const [path, entry] of next) {
      if (this.#snapshot.get(path) !== entry) changed.add(this.#reported(path));
    }

    for (const path of this.#snapshot.keys())
      if (!next.has(path)) changed.add(this.#reported(path));

    return changed;
  }

  /** A change to an ancestor of a target moved the target with it, so it reports the target. */
  #reported(path: string): string {
    if (this.#targets.some((target) => isWithin(path, target.path))) return path;

    return this.#targets.find((target) => isWithin(target.path, path))?.path ?? path;
  }

  #deliver(change: WatchChange): void {
    if (this.#closed) return;

    try {
      this.#onChange(change);
    } catch {
      // A throwing callback must not stop watching.
    }
  }
}

export type { Snapshot };
