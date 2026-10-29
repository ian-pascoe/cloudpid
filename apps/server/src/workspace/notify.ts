// The file-change notify (docs/architecture/container.md → File-change notifications; docs/architecture/workspace.md →
// Backends). The Container's `/workspace` is computerd's FUSE mount, and what the Workspace DO writes (the model's file
// tools, the Worker Shell, the Skill set) reaches it through computer's sync, into computerd's store and never through
// the kernel: file watchers there (Vite, tsc --watch) hear of none of it. And computer sends those changes only in the
// push before a Container command.
//
// So, while the Container runs, a write is sent promptly: a short while after the last write (`DEBOUNCE_MS`, and no
// later than `MAX_WAIT_MS` after the first of a stream of them) the Workspace DO pushes its changes to the Container,
// then runs `cloudpid-notify` there over the paths the pushes sent, which sets an extended attribute on each through
// the mount: computerd answers that as a no-op, and the kernel raises `IN_ATTRIB`, which watchers act on. The paths
// come from computer's change log (`change-log.ts`), between the push cursor the last notify covered and the cursor
// now, so a command's own push before it runs is covered too; revisions that only acknowledged what a pull brought from
// the Container are skipped (its watchers saw those writes). A path still there is notified itself (an edit is seen
// only on the file), a gone or renamed-away one at its parent directory (and the helper climbs to the nearest existing
// ancestor), a symlink at its parent (the attribute would land on its target); paths only the Container has are left
// out. Above `MAX_TARGETS` the targets are folded into their ancestors.
//
// Nothing here starts a Container: a stopped one gets no push and no notify (its next command's push sends the changes),
// and a push that would launch one is refused (`withNoNotifyStart`). The push records a use of the Container, as every
// push does; the helper runs through the platform's `exec`, which is no use and no activity, so it keeps the Container
// from neither its idle stop nor the hold cap. What is pending is in memory: an eviction loses it, and the next write
// or command notifies from there.
// @effect-diagnostics asyncFunction:off globalTimers:off globalDate:off preferEffectArray:off missingPipeableSignature:off newPromise:off
import type { IWorkspaceContainerAPI } from "@cloudflare/computer/backends/container";
import type { WorkspaceObserver } from "@cloudflare/computer";
import { NOTIFY_PROGRAM } from "@cloudpid/sandbox-image/notify";
import type { ChangedPath, RevisionRange } from "./change-log.ts";

/** How long after the last write the notify waits for more. */
export const DEBOUNCE_MS = 200;

/** The longest a stream of writes keeps the notify waiting, from its first write. */
export const MAX_WAIT_MS = 1_000;

/** The most paths one notify sends the helper; more are folded into their ancestors. */
export const MAX_TARGETS = 5_000;

/** How long the helper may run before it is given up on. */
export const NOTIFY_TIMEOUT_MS = 10_000;

/** The Workspace's root on the Container: what the notify's paths are under. */
const ROOT = "/workspace";

/** The spans of the Workspace stub's file operations that write (the Worker Shell's). */
const WRITE_SPANS: ReadonlySet<string> = new Set([
  "workspace.fs.writeFile",
  "workspace.fs.mkdir",
  "workspace.fs.rm",
  "workspace.fs.rename",
  "workspace.fs.chmod",
  "workspace.fs.symlink",
]);

const PUSH_SPANS: ReadonlySet<string> = new Set([
  "workspace.sync.push",
  "workspace.sync.push.block",
]);

const PULL_SPANS: ReadonlySet<string> = new Set([
  "workspace.sync.pull",
  "workspace.sync.pull.block",
]);

/** The parent directory of `path` (absolute); the root for the root. */
const parentOf = (path: string): string => {
  const slash = path.lastIndexOf("/");

  return slash <= 0 ? "/" : path.slice(0, slash);
};

/** `path` (under the root) cut to its first `depth` segments below the root. */
const atDepth = (path: string, depth: number): string =>
  [
    ROOT,
    ...path
      .slice(ROOT.length + 1)
      .split("/")
      .slice(0, depth),
  ].join("/");

/**
 * `paths` (under the root) at most `cap` of them: each cut to the same number of segments below the root, the most
 * that leaves no more than `cap`, so the notify falls on the directories that hold them (a watcher rescans a directory
 * whose attributes change; an edit to a file under one is missed). Sorted.
 */
export const foldToCap = (paths: ReadonlyArray<string>, cap: number): string[] => {
  const unique = [...new Set(paths)].sort();

  if (unique.length <= cap) return unique;

  const deepest = Math.max(...unique.map((path) => path.split("/").length - 2));

  for (let depth = deepest - 1; depth > 0; depth--) {
    const folded = [...new Set(unique.map((path) => atDepth(path, depth)))].sort();

    if (folded.length <= cap) return folded;
  }

  return [ROOT];
};

/**
 * Where to notify each of `changes`: a path still there on itself, a gone one or a symlink at its parent directory;
 * none for a path outside the Workspace or only the Container has (`containerOnly`). Deduplicated, sorted, and folded to
 * at most `cap`.
 */
export const notifyTargets = (
  changes: ReadonlyArray<ChangedPath>,
  options: {
    readonly containerOnly: (path: string) => boolean;
    readonly cap?: number | undefined;
  },
): string[] => {
  const targets: string[] = [];

  for (const { path, state } of changes) {
    if (path !== ROOT && !path.startsWith(`${ROOT}/`)) continue;

    if (options.containerOnly(path)) continue;

    targets.push(state === "present" || path === ROOT ? path : parentOf(path));
  }

  return foldToCap(targets, options.cap ?? MAX_TARGETS);
};

/** What the notify reads of computer's change log (`change-log.ts`) for the Container's backend. */
export type NotifyChangeLog = {
  /** The revision the Container has been sent everything through. */
  readonly pushedThrough: () => number;
  /** Whether the Workspace's files have changes the Container has not been sent. */
  readonly unpushed: () => boolean;
  /** The paths changed in `(after, through]`, outside `skip`. */
  readonly changedBetween: (
    after: number,
    through: number,
    skip: ReadonlyArray<RevisionRange>,
  ) => ReadonlyArray<ChangedPath>;
};

export type FileNotifierDeps = {
  /** Whether the Container runs now. Nothing is pushed or run on a stopped one. */
  readonly running: () => boolean;
  readonly log: NotifyChangeLog;
  /** Send the Container the Workspace's changes (computer's push for its backend). */
  readonly push: () => Promise<void>;
  /** Run the helper on the Container over `paths`. */
  readonly notify: (paths: ReadonlyArray<string>) => Promise<void>;
  /** Which paths only the Container has, for the launch that runs now. */
  readonly containerOnly: () => Promise<(path: string) => boolean>;
  readonly warn: (message: string) => void;
  readonly debounceMs?: number | undefined;
  readonly maxWaitMs?: number | undefined;
  readonly cap?: number | undefined;
};

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export class FileNotifier {
  readonly #deps: FileNotifierDeps;
  /** The push cursor the last notify covered; unset until a write or a push sets it. */
  #seen: number | undefined;
  /** Revisions a pull's acknowledgement moved the cursor over: the Container's own writes, never notified. */
  #pulled: RevisionRange[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** When the first change of the batch waiting was told of. */
  #firstAt: number | undefined;
  /** The notify under way, if any; a change told of meanwhile schedules another once it ends. */
  #flushing: Promise<void> | undefined;
  #pending = false;
  /** How many of the notify's own pushes are under way: a Container launch is refused meanwhile. */
  #pushing = 0;

  constructor(deps: FileNotifierDeps) {
    this.#deps = deps;
  }

  /** Whether the notify's own push is under way (`withNoNotifyStart`). */
  pushing(): boolean {
    return this.#pushing > 0;
  }

  /**
   * The Workspace's files may have changed (a model tool's write, the Worker Shell's, the Skill set), or a push sent the
   * Container some: notify it soon.
   */
  changed(): void {
    this.#baseline();
    this.#pending = true;

    if (this.#flushing !== undefined) return;

    this.#schedule();
  }

  /**
   * The observer of computer's spans that tells the notify what happened: the Worker Shell's writes (through the
   * Workspace stub), the pushes to the Container's backend (`backend`), and the pulls from it, whose acknowledgement
   * moves the push cursor over what the Container wrote itself. Each span is then `next`'s (computer's `noopObserver`).
   */
  observer(backend: string, next: WorkspaceObserver): WorkspaceObserver {
    return {
      span: (name, attributes, run) => {
        if (WRITE_SPANS.has(name)) {
          return next.span(name, attributes, run).finally(() => this.changed());
        }

        if (attributes["workspace.sync.backend"] !== backend) {
          return next.span(name, attributes, run);
        }

        if (PUSH_SPANS.has(name)) {
          this.#baseline();

          // The notify's own push is read when it ends; a command's push is notified after it.
          return next.span(name, attributes, run).finally(() => {
            if (this.#pushing === 0) this.changed();
          });
        }

        if (PULL_SPANS.has(name)) {
          const before = this.#read(() => this.#deps.log.pushedThrough());

          return next.span(name, attributes, run).finally(() => {
            const after = this.#read(() => this.#deps.log.pushedThrough());

            if (before !== undefined && after !== undefined && after > before) {
              this.#pulled.push([before, after]);
            }
          });
        }

        return next.span(name, attributes, run);
      },
    };
  }

  /** The cursor the next notify counts from, when none is set: the changes before it were sent before this began. */
  #baseline(): void {
    this.#seen ??= this.#read(() => this.#deps.log.pushedThrough());
  }

  /** `read()`, or undefined (logged) when the change log cannot be read. */
  #read<A>(read: () => A): A | undefined {
    try {
      return read();
    } catch (cause) {
      this.#deps.warn(`file notify: the change log could not be read: ${messageOf(cause)}`);

      return undefined;
    }
  }

  #schedule(): void {
    const now = Date.now();
    const debounce = this.#deps.debounceMs ?? DEBOUNCE_MS;
    const maxWait = this.#deps.maxWaitMs ?? MAX_WAIT_MS;

    this.#firstAt ??= now;

    if (this.#timer !== undefined) clearTimeout(this.#timer);

    this.#timer = setTimeout(
      () => this.#run(),
      Math.max(0, Math.min(debounce, this.#firstAt + maxWait - now)),
    );
  }

  #run(): void {
    this.#timer = undefined;
    this.#firstAt = undefined;
    this.#pending = false;

    this.#flushing = this.#flush()
      .catch((cause: unknown) => this.#deps.warn(`file notify: ${messageOf(cause)}`))
      .finally(() => {
        this.#flushing = undefined;

        if (this.#pending) this.#schedule();
      });
  }

  async #flush(): Promise<void> {
    const { running, log } = this.#deps;

    // A stopped Container is never started for this: its next command's push sends the changes, to a Container whose
    // watchers start after them.
    if (!running()) {
      this.#seen = undefined;
      this.#pulled = [];

      return;
    }

    if (log.unpushed()) {
      this.#pushing += 1;

      try {
        await this.#deps.push();
      } catch (cause) {
        // What the push sent before it failed is still notified.
        this.#deps.warn(`file notify: the push to the Container failed: ${messageOf(cause)}`);
      } finally {
        this.#pushing -= 1;
      }
    }

    const through = log.pushedThrough();
    const after = this.#seen ?? through;
    const pulled = this.#pulled;

    this.#seen = through;
    this.#pulled = pulled.filter(([, end]) => end > through);

    if (through <= after) return;

    const targets = notifyTargets(log.changedBetween(after, through, pulled), {
      containerOnly: await this.#deps.containerOnly(),
      cap: this.#deps.cap,
    });

    if (targets.length === 0 || !running()) return;

    await this.#deps.notify(targets);
  }
}

/** The platform's Container, as the notify runs the helper on it. */
export type NotifyContainer = Pick<Container, "exec">;

/**
 * Run `cloudpid-notify` on `container` over `paths`, NUL-separated on its stdin. Rejects when it cannot start, runs past
 * `timeoutMs` or fails; answers what it reported on stderr otherwise (a path it could not notify), empty when nothing.
 */
export const runNotify = async (
  container: NotifyContainer,
  paths: ReadonlyArray<string>,
  timeoutMs = NOTIFY_TIMEOUT_MS,
): Promise<string> => {
  const controller = new AbortController();
  const input = new TextEncoder().encode(`${paths.join("\0")}\0`);

  const stdin = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(input);
      stream.close();
    },
  });

  const process = await container.exec([NOTIFY_PROGRAM], {
    stdin,
    stdout: "ignore",
    stderr: "pipe",
    signal: controller.signal,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;

  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Only while it runs: the signal of a process that has exited raises an error in the Durable Object.
      controller.abort();
      reject(new Error(`${NOTIFY_PROGRAM} did not finish in ${timeoutMs / 1000} s`));
    }, timeoutMs);
  });

  const { stderr, exitCode } = await Promise.race([process.output(), expired]).finally(() => {
    clearTimeout(timer);
  });

  const reported = new TextDecoder().decode(stderr).trim();

  if (exitCode !== 0) {
    throw new Error(`${NOTIFY_PROGRAM} exited with status ${exitCode}: ${reported.slice(0, 500)}`);
  }

  return reported;
};

/**
 * `api`, refusing to launch a Container for the notify alone (`notifying`: its push is under way and nothing else holds
 * the Container): the Container stopped since the notify found it running (the idle stop, a restart), and computer
 * would start one, or restart one that does not answer, to push to. A running Container is reconnected to as ever.
 */
export const withNoNotifyStart = (
  api: IWorkspaceContainerAPI,
  options: { readonly notifying: () => boolean; readonly running: () => boolean },
): IWorkspaceContainerAPI => {
  const refused = () =>
    Promise.reject(new Error("The file-change notify never starts a Container: it was stopped"));

  return {
    start: (spec) => (options.notifying() && !options.running() ? refused() : api.start(spec)),
    restart: (spec) => (options.notifying() ? refused() : api.restart(spec)),
    interceptOutboundHttp: (host, workspace) => api.interceptOutboundHttp(host, workspace),
    interceptAllOutboundHttp: (workspace, token) => api.interceptAllOutboundHttp(workspace, token),
    fetchPort: (port, input, init) => api.fetchPort(port, input, init),
    port: (port) => api.port(port),
    setInactivityTimeout: (durationMs) => api.setInactivityTimeout(durationMs),
    status: () => api.status(),
    exitInfo: () => api.exitInfo(),
  };
};
