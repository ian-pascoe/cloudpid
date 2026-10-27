// The Workspace test Worker: the Workspace DO, counting the RPC stubs it hands out and how many of them its clients
// have disposed. Tests reach it through the `WORKSPACES` binding, as Session DOs will.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off preferEffectArray:off
import {
  type Workspace as ComputerWorkspace,
  WorkspaceRuntimeExecHandleStub,
  WorkspaceRuntimeStub,
  WorkspaceServiceProxy,
  WorkspaceStub,
} from "@cloudflare/computer";
import { ensureDirectory } from "@cloudpid/computer-env";
import { RpcTarget } from "cloudflare:workers";
import * as git from "isomorphic-git";
import { type ChangesFiles, gitFs, WorkspaceChangesModule } from "./changes.ts";
import { CONTAINER_BACKEND_ID, Workspace } from "./Workspace.ts";
import { GuardedFilesystem } from "./tracked.ts";

/** Live counts of the stubs a `TestWorkspace` handed out. */
export type LiveStubs = {
  /** Commands started, through any Workspace stub. */
  readonly started: number;
  /** Commands started on the Container backend: what a Container would be started for. */
  readonly container: number;
  /** Kill requests, through any Workspace stub. */
  readonly killed: number;
  readonly opened: number;
  readonly workspaces: number;
  readonly execs: number;
};

/** Whether the fake Container runs, and the scripts run on it so far. */
export type FakeContainerState = {
  readonly running: boolean;
  readonly scripts: readonly string[];
};

type Counter = {
  started: number;
  container: number;
  killed: number;
  opened: number;
  workspaces: number;
  execs: number;
};

/** An exec handle stub that counts itself until its client disposes it. */
class CountedExecHandle extends RpcTarget {
  readonly #inner: WorkspaceRuntimeExecHandleStub<"utf8" | undefined>;
  readonly #counter: Counter;
  #disposed = false;

  constructor(inner: WorkspaceRuntimeExecHandleStub<"utf8" | undefined>, counter: Counter) {
    super();
    this.#inner = inner;
    this.#counter = counter;
    counter.execs++;
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
    this.#counter.execs--;
    this.#inner[Symbol.dispose]();
  }
}

class CountedRuntime extends WorkspaceRuntimeStub {
  readonly #counter: Counter;

  constructor(workspace: ComputerWorkspace, counter: Counter) {
    super(workspace);
    this.#counter = counter;
  }

  override killExec(...args: Parameters<WorkspaceRuntimeStub["killExec"]>) {
    this.#counter.killed++;

    return super.killExec(...args);
  }

  override async exec(source: string, options: { readonly backend?: string } = {}) {
    this.#counter.started++;

    if (options.backend === CONTAINER_BACKEND_ID) {
      // The test Worker has no Container: count the command, and refuse it here rather than in the backend's connect.
      this.#counter.container++;

      throw new Error("This test Worker has no Container");
    }

    // SAFETY: the counted handle answers every method and getter of the exec handle stub it wraps.
    return new CountedExecHandle(await super.exec(source, options), this.#counter) as never;
  }
}

class CountedWorkspaceStub extends WorkspaceStub {
  readonly #runtime: CountedRuntime;
  readonly #fs: GuardedFilesystem;
  readonly #counter: Counter;
  #disposed = false;

  constructor(workspace: ComputerWorkspace, counter: Counter) {
    super(workspace);
    this.#runtime = new CountedRuntime(workspace, counter);
    this.#fs = new GuardedFilesystem(workspace);
    this.#counter = counter;
    counter.opened++;
    counter.workspaces++;
  }

  override get runtime() {
    return this.#runtime;
  }

  override get fs() {
    return this.#fs;
  }

  override [Symbol.dispose]() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#fs[Symbol.dispose]();
    this.#counter.workspaces--;
    this.#runtime[Symbol.dispose]();
    super[Symbol.dispose]();
  }
}

export class TestWorkspace extends Workspace {
  readonly #counter: Counter = {
    started: 0,
    container: 0,
    killed: 0,
    opened: 0,
    workspaces: 0,
    execs: 0,
  };

  /** The Workspace's files, once a stub was asked for. */
  #files: ComputerWorkspace | undefined;

  liveStubs(): LiveStubs {
    return { ...this.#counter };
  }

  /** The Workspace's own files, without a stub's counting. */
  async #computer(): Promise<ComputerWorkspace> {
    if (this.#files === undefined) (await this.__getWorkspaceStub())[Symbol.dispose]();

    // SAFETY: asking for a stub above went through `workspaceStub`, which keeps the Workspace.
    return this.#files!;
  }

  /** Write `files` (absolute paths) into the Workspace, as computer's sync would, making their directories. */
  async putFiles(files: ReadonlyArray<readonly [string, Uint8Array | string]>): Promise<void> {
    const workspace = await this.#computer();
    const made = new Set<string>();

    for (const [path, content] of files) {
      const directory = path.slice(0, path.lastIndexOf("/"));

      if (!made.has(directory)) {
        await ensureDirectory(workspace.fs, directory);
        made.add(directory);
      }

      await workspace.fs.writeFile(path, content);
    }
  }

  /**
   * For the Changes measurements (`changes.bench.workerd.test.ts`): what each of isomorphic-git's reads holds is kept
   * until `releaseMeasured`, so the heap sampled from outside sees it. Timed by the caller: workerd's clock stands still
   * while code runs.
   */
  #measured: unknown[] = [];

  /**
   * The Workspace's files, as the listing reads them. With `yieldEvery`, every that many reads waits for the next turn
   * of the event loop, where the inspector answers the heap samples it cannot while code runs: it costs time, not memory.
   */
  async #measuredFiles(yieldEvery: number | undefined): Promise<ChangesFiles> {
    const provider = (await this.#computer()).provider();

    if (yieldEvery === undefined) return provider;

    let reads = 0;

    const paced = async <A>(read: Promise<A>): Promise<A> => {
      const value = await read;

      if (++reads % yieldEvery === 0) await new Promise((resolve) => setTimeout(resolve, 0));

      return value;
    };

    return {
      readFile: (path, options) => paced(provider.readFile(path, options)),
      stat: (path) => paced(provider.stat(path)),
      lstat: (path) => paced(provider.lstat(path)),
      readdir: (path) => paced(provider.readdir(path)),
      readlink: (path) => paced(provider.readlink(path)),
      readRangeSync: (path, offset, length) => provider.readRangeSync(path, offset, length),
    };
  }

  /** isomorphic-git's `statusMatrix` of repo `dir`, as the listing reads it: how many files it tracks, and changed. */
  async measureStatus(
    dir: string,
    yieldEvery?: number,
  ): Promise<{ readonly tracked: number; readonly changed: number }> {
    const fs = gitFs(await this.#measuredFiles(yieldEvery));
    const cache = {};
    const matrix = await git.statusMatrix({ fs, dir, cache, refresh: false });

    this.#measured.push(matrix, cache);

    return {
      tracked: matrix.filter(([, inHead]) => inHead === 1).length,
      changed: matrix.filter(([, inHead, inWorkdir]) => inHead !== inWorkdir).length,
    };
  }

  /** isomorphic-git's `readBlob` of each of `paths` at repo `dir`'s HEAD, one cache for all: their bytes in all. */
  async measureBlobs(dir: string, paths: readonly string[], yieldEvery?: number): Promise<number> {
    const fs = gitFs(await this.#measuredFiles(yieldEvery));
    const cache = {};
    const oid = await git.resolveRef({ fs, dir, ref: "HEAD" });
    let bytes = 0;

    for (const filepath of paths) {
      const { blob } = await git.readBlob({ fs, dir, oid, filepath, cache });

      bytes += blob.length;
      this.#measured.push(blob);
    }

    this.#measured.push(cache);

    return bytes;
  }

  /** The whole listing of `directory`, as `changes` runs it, with no tracked-file guard. */
  async measureListing(directory: string, yieldEvery?: number): Promise<number> {
    const files = await this.#measuredFiles(yieldEvery);

    const listed = await new WorkspaceChangesModule({
      files: () => files,
      containerOnly: async () => () => false,
      running: () => false,
      run: () => Promise.reject(new Error("No Container in the measurements")),
      kept: { load: async () => undefined, save: async () => {} },
      warn: () => {},
      maxTrackedFiles: Number.POSITIVE_INFINITY,
    }).list({ directory, startContainer: false });

    this.#measured.push(listed);

    return listed.repos[0]?.files.length ?? 0;
  }

  releaseMeasured(): void {
    this.#measured = [];
  }

  /**
   * The Container as the Comparison tests have it (`comparison.workerd.test.ts`): `running` says whether it runs, and each
   * script run on it is answered with the next of `outputs` (what real git printed for it, made in Node) and starts it,
   * as a real run would. Without this, the Container is the real one, which this test Worker does not have.
   */
  #fakeContainer: { running: boolean; outputs: string[]; scripts: string[] } | undefined;

  fakeContainer(options: {
    readonly running: boolean;
    readonly outputs?: readonly string[];
  }): void {
    this.#fakeContainer = {
      running: options.running,
      outputs: [...(options.outputs ?? [])],
      scripts: this.#fakeContainer?.scripts ?? [],
    };
  }

  /** Whether the fake Container runs, and the scripts run on it so far. */
  fakeContainerState(): FakeContainerState {
    return {
      running: this.#fakeContainer?.running === true,
      scripts: [...(this.#fakeContainer?.scripts ?? [])],
    };
  }

  protected override containerRunning(): boolean {
    return this.#fakeContainer?.running ?? super.containerRunning();
  }

  protected override runContainerScript(script: string) {
    const fake = this.#fakeContainer;

    if (fake === undefined) return super.runContainerScript(script);

    fake.scripts.push(script);
    fake.running = true;

    return Promise.resolve({ exitCode: 0, stdout: fake.outputs.shift() ?? "", stderr: "" });
  }

  /** The keys of the Workspace DO's storage that start with `prefix`. */
  storageKeys(prefix: string): string[] {
    return [...this.ctx.storage.kv.list({ prefix })].map(([key]) => key);
  }

  /** The bytes of file `path` in the Workspace. */
  async fileBytes(path: string): Promise<Uint8Array> {
    const workspace = await this.#computer();

    return new Uint8Array(await new Response(await workspace.fs.readFile(path)).arrayBuffer());
  }

  protected override workspaceStub(workspace: ComputerWorkspace): WorkspaceStub {
    this.#files = workspace;

    return new CountedWorkspaceStub(workspace, this.#counter);
  }
}

export { WorkspaceServiceProxy };

export default {
  fetch: () => new Response("cloudpid Workspace test worker"),
};
