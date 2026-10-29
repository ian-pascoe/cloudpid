// The file-change signal (GLOSSARY.md; docs/architecture/container.md → File-change signals; docs/architecture/workspace.md
// → Backends). The Container's `/workspace` is computerd's FUSE mount, and what the Workspace DO writes (the model's file
// tools, the Worker Shell) reaches it through computer's sync, into computerd's store and never through the kernel:
// file watchers there (Vite, tsc --watch) hear of none of it. And computer sends those changes only in the push before
// a Container command.
//
// So, while the Container runs, a write is sent promptly: a short while after the last write (`DEBOUNCE_MS`, and no
// later than `MAX_WAIT_MS` after the first of a stream of them) the Workspace DO pushes its changes to the Container,
// then runs `cloudpid-notify` there over the paths the pushes sent, which sets an extended attribute on each through
// the mount: computerd answers that as a no-op, and the kernel raises `IN_ATTRIB`, which watchers act on. The paths
// come from computer's change log (`change-log.ts`), between the push cursor the last signal covered and the cursor
// now, so a command's own push before it runs is covered too; revisions that only acknowledged what a pull brought from
// the Container are skipped (its watchers saw those writes). A path still there is signalled itself (an edit is seen
// only on the file), a gone or renamed-away one at its parent directory (and the helper climbs to the nearest existing
// ancestor), a symlink at its parent (the attribute would land on its target); paths only the Container has, and paths
// under a read-only mount (the Skill set's), are left out. Above `MAX_TARGETS` the targets are folded into their
// ancestors.
//
// Nothing here starts a Container: a stopped one gets no push and no signal (its next command's push sends the
// changes), and a launch the signal's own push would cause is refused (`withNoSignalStart`). Neither the push (which
// the Workspace DO's use observer tells by `inSignalPush`) nor the helper, run through the platform's `exec`, is a use
// of the Container or activity, so an edit alone does not keep a running Container from its idle stop.
// What is pending is in memory: an eviction loses it, and the next write or command signals from there.
// @effect-diagnostics asyncFunction:off globalTimers:off globalDate:off preferEffectArray:off missingPipeableSignature:off newPromise:off nodeBuiltinImport:off
import { AsyncLocalStorage } from "node:async_hooks";
import type { IWorkspaceContainerAPI } from "@cloudflare/computer/backends/container";
import type { WorkspaceObserver } from "@cloudflare/computer";
import { WORKSPACE_ROOT } from "@cloudpid/protocol/repo";
import { NOTIFY_PROGRAM } from "@cloudpid/sandbox-image/notify";
import type { ChangedPath, ChangeLog, RevisionRange } from "./change-log.ts";

/** How long after the last write the signal waits for more. */
export const DEBOUNCE_MS = 200;

/** The longest a stream of writes keeps the signal waiting, from its first write. */
export const MAX_WAIT_MS = 1_000;

/** The most paths one signal sends the helper; more are folded into their ancestors. */
export const MAX_TARGETS = 5_000;

/** How long the helper may take, from the call that starts it, before it is given up on. */
export const NOTIFY_TIMEOUT_MS = 10_000;

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

/**
 * The async context of the signal's own push: what computer does on its behalf (a connect, a launch) runs in it, and a
 * command's own push or connect never does.
 */
const signalPush = new AsyncLocalStorage<true>();

/** Whether the code running now is the signal's own push, or runs on its behalf. */
export const inSignalPush = (): boolean => signalPush.getStore() === true;

/** The parent directory of `path` (absolute); the root for the root. */
const parentOf = (path: string): string => {
  const slash = path.lastIndexOf("/");

  return slash <= 0 ? "/" : path.slice(0, slash);
};

/** How many segments `path` (under the Workspace root) has below the root: 0 for the root. */
const depthOf = (path: string): number =>
  path === WORKSPACE_ROOT ? 0 : path.slice(WORKSPACE_ROOT.length + 1).split("/").length;

/** `path` (under the Workspace root) cut to its first `depth` segments below the root: the root itself for 0. */
const atDepth = (path: string, depth: number): string =>
  depth === 0 || path === WORKSPACE_ROOT
    ? WORKSPACE_ROOT
    : [
        WORKSPACE_ROOT,
        ...path
          .slice(WORKSPACE_ROOT.length + 1)
          .split("/")
          .slice(0, depth),
      ].join("/");

/**
 * `paths` (under the Workspace root) at most `cap` of them: each cut to the same number of segments below the root,
 * the most that leaves no more than `cap`, so the signal falls on the directories that hold them (a watcher rescans a
 * directory whose attributes change; an edit to a file under one is missed). Sorted.
 */
export const foldToCap = (paths: ReadonlyArray<string>, cap: number): string[] => {
  const unique = [...new Set(paths)].sort();

  if (unique.length <= cap) return unique;

  // A loop, not `Math.max(...)`: a batch can hold every path of the Workspace, past the arguments a call can take.
  let deepest = 0;

  for (const path of unique) deepest = Math.max(deepest, depthOf(path));

  for (let depth = deepest - 1; depth > 0; depth--) {
    const folded = [...new Set(unique.map((path) => atDepth(path, depth)))].sort();

    if (folded.length <= cap) return folded;
  }

  return [WORKSPACE_ROOT];
};

/** Whether `path` is `mount` or below it. */
const under = (path: string, mount: string) => path === mount || path.startsWith(`${mount}/`);

/**
 * Where to signal each of `changes`: a path still there on itself, a gone one or a symlink at its parent directory;
 * none for a path outside the Workspace, one only the Container has (`containerOnly`), or one under a read-only mount
 * (`readOnly`, which the Container's attribute cannot be set on). Deduplicated, sorted, and folded to `MAX_TARGETS`.
 */
export const signalTargets = (
  changes: ReadonlyArray<ChangedPath>,
  options: {
    readonly containerOnly: (path: string) => boolean;
    readonly readOnly: ReadonlyArray<string>;
  },
): string[] => {
  const targets: string[] = [];

  for (const { path, state } of changes) {
    if (!under(path, WORKSPACE_ROOT)) continue;

    if (options.containerOnly(path) || options.readOnly.some((mount) => under(path, mount))) {
      continue;
    }

    targets.push(state === "present" || path === WORKSPACE_ROOT ? path : parentOf(path));
  }

  return foldToCap(targets, MAX_TARGETS);
};

export type FileNotifierDeps = {
  /** Whether the Container runs now. Nothing is pushed or run on a stopped one. */
  readonly running: () => boolean;
  /** computer's change log, as the Container's backend has been sent it (`changeLog`). */
  readonly log: ChangeLog;
  /** Send the Container the Workspace's changes (computer's push for its backend). */
  readonly push: () => Promise<void>;
  /** Run the helper on the Container over `paths`. */
  readonly notify: (paths: ReadonlyArray<string>) => Promise<void>;
  /** Which paths only the Container has, for the launch that runs now. */
  readonly containerOnly: () => Promise<(path: string) => boolean>;
  /** The mounts the Container has read-only below the Workspace root (the Skill set's). */
  readonly readOnly: ReadonlyArray<string>;
  /** How many holds on the Container have begun so far (`IdleStop.holdsBegun`): a command's start is told by it. */
  readonly holdsBegun: () => number;
  readonly warn: (message: string) => void;
};

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Sends the running Container the Workspace's writes promptly, then gives the file-change signal for them. */
export class FileNotifier {
  readonly #deps: FileNotifierDeps;
  /** The push cursor the last signal covered; unset until a write or a push sets it, and once the Container is stopped. */
  #signalledThrough: number | undefined;
  /** Revisions a pull's acknowledgement moved the cursor over: the Container's own writes, never signalled. */
  #pulled: RevisionRange[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** When the first change of the batch waiting was told of. */
  #firstAt: number | undefined;
  /** The signal under way, if any; a change told of meanwhile schedules another once it ends. */
  #flushing: Promise<void> | undefined;
  #pending = false;
  /** The holds begun when the signal's own push began (`refusesLaunch`). */
  #holdsAtPush = 0;

  constructor(deps: FileNotifierDeps) {
    this.#deps = deps;
  }

  /**
   * Whether a Container launch (a start, or computer's restart) asked for now must be refused: it comes from the
   * signal's own push, and no command has begun since that push began. A command that joins a launch under way shares
   * it, and its hold has begun first. A command's own launch, in its own context, is never refused.
   */
  refusesLaunch(): boolean {
    return inSignalPush() && this.#deps.holdsBegun() === this.#holdsAtPush;
  }

  /**
   * The Workspace's files may have changed (a model tool's write, the Worker Shell's), or a push sent the Container
   * some: signal it soon.
   */
  changed(): void {
    this.#baseline();
    this.#pending = true;

    if (this.#flushing !== undefined) return;

    this.#schedule();
  }

  /**
   * The observer of computer's spans that tells the signal what happened: the Worker Shell's writes (through the
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

          // The signal's own push is read when it ends; a command's push is signalled after it.
          const own = inSignalPush();

          return next.span(name, attributes, run).finally(() => {
            if (!own) this.changed();
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

  /** The cursor the next signal counts from, when none is set: the changes before it were sent before this began. */
  #baseline(): void {
    this.#signalledThrough ??= this.#read(() => this.#deps.log.pushedThrough());
  }

  /** `read()`, or undefined (logged) when the change log cannot be read. */
  #read<A>(read: () => A): A | undefined {
    try {
      return read();
    } catch (cause) {
      this.#deps.warn(`file-change signal: the change log could not be read: ${messageOf(cause)}`);

      return undefined;
    }
  }

  #schedule(): void {
    const now = Date.now();

    this.#firstAt ??= now;

    if (this.#timer !== undefined) clearTimeout(this.#timer);

    this.#timer = setTimeout(
      () => this.#run(),
      Math.max(0, Math.min(DEBOUNCE_MS, this.#firstAt + MAX_WAIT_MS - now)),
    );
  }

  #run(): void {
    this.#timer = undefined;
    this.#firstAt = undefined;
    this.#pending = false;

    this.#flushing = this.#flush()
      .catch((cause: unknown) => this.#deps.warn(`file-change signal: ${messageOf(cause)}`))
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
      this.#signalledThrough = undefined;
      this.#pulled = [];

      return;
    }

    if (log.unpushed()) {
      this.#holdsAtPush = this.#deps.holdsBegun();

      try {
        await signalPush.run(true, () => this.#deps.push());
      } catch (cause) {
        // What the push sent before it failed is still signalled.
        this.#deps.warn(
          `file-change signal: the push to the Container failed: ${messageOf(cause)}`,
        );
      }
    }

    const through = log.pushedThrough();
    const after = this.#signalledThrough ?? through;
    const pulled = this.#pulled;

    this.#signalledThrough = through;
    this.#pulled = pulled.filter(([, end]) => end > through);

    if (through <= after) return;

    const targets = signalTargets(log.changedBetween(after, through, pulled), {
      containerOnly: await this.#deps.containerOnly(),
      readOnly: this.#deps.readOnly,
    });

    if (targets.length === 0 || !running()) return;

    await this.#deps.notify(targets);
  }
}

/** The platform's Container, as the signal runs the helper on it. */
export type NotifyContainer = Pick<Container, "exec">;

/**
 * Run `cloudpid-notify` on `container` over `paths`, each ended by a NUL on its stdin. Rejects when it cannot start,
 * when starting and running it take more than `NOTIFY_TIMEOUT_MS` together, or when it fails; answers what it reported
 * on stderr otherwise (a path it could not signal), empty when nothing.
 */
export const runNotify = async (
  container: NotifyContainer,
  paths: ReadonlyArray<string>,
): Promise<string> => {
  const controller = new AbortController();
  const input = new TextEncoder().encode(paths.map((path) => `${path}\0`).join(""));

  const stdin = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(input);
      stream.close();
    },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;

  // The deadline covers the start of the process too: a Container that does not answer the exec is given up on as well.
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${NOTIFY_PROGRAM} did not finish in ${NOTIFY_TIMEOUT_MS / 1000} s`));
    }, NOTIFY_TIMEOUT_MS);
  });

  const run = async () => {
    const process = await container.exec([NOTIFY_PROGRAM], {
      stdin,
      stdout: "ignore",
      stderr: "pipe",
      signal: controller.signal,
    });

    return process.output();
  };

  const { stderr, exitCode } = await Promise.race([run(), expired]).finally(() => {
    clearTimeout(timer);
  });

  const reported = new TextDecoder().decode(stderr).trim();

  if (exitCode !== 0) {
    throw new Error(`${NOTIFY_PROGRAM} exited with status ${exitCode}: ${reported.slice(0, 500)}`);
  }

  return reported;
};

/**
 * `api`, refusing a launch while `refuses()` says so (`FileNotifier.refusesLaunch`: the file-change signal's own push
 * would launch the Container, which stopped since the signal found it running, or restart one that does not answer).
 * A start that finds the Container running reconnects to it as ever.
 */
export const withNoSignalStart = (
  api: IWorkspaceContainerAPI,
  options: { readonly refuses: () => boolean; readonly running: () => boolean },
): IWorkspaceContainerAPI => {
  const refused = () =>
    Promise.reject(new Error("The file-change signal never starts a Container: it was stopped"));

  return {
    start: (spec) => (options.refuses() && !options.running() ? refused() : api.start(spec)),
    restart: (spec) => (options.refuses() ? refused() : api.restart(spec)),
    interceptOutboundHttp: (host, workspace) => api.interceptOutboundHttp(host, workspace),
    interceptAllOutboundHttp: (workspace, token) => api.interceptAllOutboundHttp(workspace, token),
    fetchPort: (port, input, init) => api.fetchPort(port, input, init),
    port: (port) => api.port(port),
    setInactivityTimeout: (durationMs) => api.setInactivityTimeout(durationMs),
    status: () => api.status(),
    exitInfo: () => api.exitInfo(),
  };
};
