// The Workspace stub the DO hands out, with the commands that run on the Container counted (docs/architecture/container.md →
// Idle stop). A command's exec handle lives until its client disposes it (the client always holds it
// with `using`, and Workers RPC disposes it when the client disconnects), so the command is running from `exec` until
// then, and the Container is not idle meanwhile. Every command started, on any backend, is activity in the Workspace,
// which the hold cap counts from: a handle never disposed holds the Container no longer than that. A command on the
// Container may change its disk, so its idle stop snapshots it; the Workspace DO's own reads (`writes: false`) do not.
// @effect-diagnostics asyncFunction:off globalConsole:off
import {
  type Workspace as ComputerWorkspace,
  WorkspaceFilesystemStub,
  type WorkspaceRuntimeExecHandleStub,
  WorkspaceRuntimeStub,
  WorkspaceStub,
} from "@cloudflare/computer";
import { ensureDirectory } from "@cloudpid/computer-env";
import { RpcTarget } from "cloudflare:workers";
import type { IdleStop } from "./idle.ts";

type ExecHandle = WorkspaceRuntimeExecHandleStub<"utf8" | undefined>;

/** The commands' side of the idle stop: what `IdleStop` offers them. */
export type CommandTracker = Pick<IdleStop, "hold" | "noteActivity">;

/** An exec handle stub that ends its command's run on the Container when its client disposes it. */
class TrackedExecHandle extends RpcTarget {
  readonly #inner: ExecHandle;
  readonly #onEnd: () => void;
  #disposed = false;

  constructor(inner: ExecHandle, onEnd: () => void) {
    super();
    this.#inner = inner;
    this.#onEnd = onEnd;
  }

  get id() {
    return this.#inner.id;
  }

  get backend() {
    return this.#inner.backend;
  }

  result() {
    return this.#inner.result();
  }

  stream() {
    return this.#inner.stream();
  }

  kill(signal?: "SIGTERM" | "SIGKILL" | "SIGINT" | "SIGHUP") {
    return this.#inner.kill(signal);
  }

  [Symbol.dispose]() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#inner[Symbol.dispose]();
    this.#onEnd();
  }
}

class TrackedRuntime extends WorkspaceRuntimeStub {
  readonly #tracker: CommandTracker;
  readonly #containerBackend: string;
  readonly #writes: boolean;

  constructor(
    workspace: ComputerWorkspace,
    tracker: CommandTracker,
    containerBackend: string,
    writes: boolean,
  ) {
    super(workspace);
    this.#tracker = tracker;
    this.#containerBackend = containerBackend;
    this.#writes = writes;
  }

  override async exec(source: string, options: { readonly backend?: string } = {}) {
    const onContainer = options.backend === this.#containerBackend;
    const tracker = this.#tracker;
    const log = (cause: unknown) => console.warn("idle stop: tracking a command failed", cause);

    // A command started is the owner's or the agent's activity, whichever backend runs it.
    tracker.noteActivity().catch(log);

    // A failed write only shortens the idle time: the alarm works from what was stored before. The command's mark that it
    // may change the disk is kept in memory at once, so it holds however storage answers.
    const hold = onContainer ? tracker.hold({ writes: this.#writes }) : undefined;

    hold?.begun.catch(log);

    const end = () => {
      hold?.end().catch(log);
    };

    try {
      const handle = await super.exec(source, options);

      // SAFETY: the tracked handle answers every method and getter of the exec handle stub it wraps.
      return (onContainer ? new TrackedExecHandle(handle, end) : handle) as never;
    } catch (error) {
      if (onContainer) end();
      throw error;
    }
  }
}

/**
 * The Workspace's file system for the Worker Shell, where `mkdir -p` of a directory that exists succeeds even above a
 * read-only mount: computer refuses it on `/workspace` once the Skill set is mounted below (`ensureDirectory`).
 */
export class GuardedFilesystem extends WorkspaceFilesystemStub {
  readonly #workspace: ComputerWorkspace;

  constructor(workspace: ComputerWorkspace) {
    super(workspace);
    this.#workspace = workspace;
  }

  override async mkdir(...[path, options]: Parameters<WorkspaceFilesystemStub["mkdir"]>) {
    if (options?.recursive === true) return ensureDirectory(this.#workspace.fs, path);

    return super.mkdir(path, options);
  }
}

/**
 * A Workspace stub whose commands on `containerBackend` are reported to `tracker`, as commands that may change the
 * Container's disk unless `writes` is false (the Workspace DO's own reads).
 */
export class TrackedWorkspaceStub extends WorkspaceStub {
  readonly #runtime: TrackedRuntime;
  readonly #fs: GuardedFilesystem;
  #disposed = false;

  constructor(
    workspace: ComputerWorkspace,
    tracker: CommandTracker,
    containerBackend: string,
    writes = true,
  ) {
    super(workspace);
    this.#runtime = new TrackedRuntime(workspace, tracker, containerBackend, writes);
    this.#fs = new GuardedFilesystem(workspace);
  }

  override get fs() {
    return this.#fs;
  }

  override get runtime() {
    return this.#runtime;
  }

  override [Symbol.dispose]() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#runtime[Symbol.dispose]();
    this.#fs[Symbol.dispose]();
    super[Symbol.dispose]();
  }
}
