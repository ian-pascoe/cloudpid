// The Workspace test Worker: the Workspace DO, counting the RPC stubs it hands out and how many of them its clients
// have disposed. Tests reach it through the `WORKSPACES` binding, as Session DOs will.
// @effect-diagnostics asyncFunction:off globalTimers:off newPromise:off preferEffectArray:off preferEffectRecord:off
import {
  type MountWriteAPI,
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
import type { Answers } from "./github-pulls.fixtures.ts";
import type { ContainerPreviewActivity } from "./container-preview.ts";
import { CONTAINER_BACKEND_ID, Workspace } from "./Workspace.ts";
import { GuardedFilesystem } from "./tracked.ts";
import type { SkillSet } from "./skill-set-schema.ts";

/** The start of the hash of a Skill set the test Worker cannot write into the files (`writeSkillSet`). */
export const UNWRITABLE_SKILL_SET = "sha256:unwritable";

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

/** A WebSocket the fake dev server opened: its path, what it was sent, and how it closed (null while open). */
export type DevServerSocket = {
  readonly path: string;
  readonly received: string[];
  closed: { readonly code: number; readonly reason: string } | null;
};

/** How many times Container previews touched the Container, and began and ended a carried socket's hold on it. */
export type ContainerPreviewUses = { touch: number; begin: number; end: number };

/** What the fake dev server was asked, by any port, and the WebSockets it opened. */
export type DevServerState = {
  readonly requests: Array<{
    readonly port: number;
    readonly method: string;
    readonly url: string;
    readonly host: string | null;
    readonly forwardedHost: string | null;
    readonly origin: string | null;
    readonly cookie: string | null;
    readonly upgrade: string | null;
    readonly protocols: string | null;
  }>;
  readonly sockets: DevServerSocket[];
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

  /** What the file-change notify did on the fake Container, in order: `push`, and `notify <path> <path> …`. */
  #notified: string[] = [];

  notifyEvents(): string[] {
    return [...this.#notified];
  }

  /**
   * The notify's push, on the fake Container: computer's push cursor for the Container's backend moved to the revision
   * the files are at, as a push that sent everything leaves it (`change-log.ts` reads it).
   */
  protected override async pushContainerChanges(): Promise<void> {
    if (this.#fakeContainer === undefined) return super.pushContainerChanges();

    this.#notified.push("push");

    const sql = this.ctx.storage.sql;
    const [current] = sql.exec<{ v: number }>("SELECT v FROM vfs_meta WHERE k = 'rev'").toArray();
    const rev = current?.v ?? 0;

    sql.exec(
      "INSERT INTO _vfs_push_cursor (k, backend, rev, path) VALUES ('push', ?, ?, NULL) ON CONFLICT(k, backend) DO UPDATE SET rev = excluded.rev, path = NULL",
      CONTAINER_BACKEND_ID,
      rev,
    );
    sql.exec(
      "INSERT INTO _vfs_watermark (k, backend, v) VALUES ('pushRev', ?, ?) ON CONFLICT(k, backend) DO UPDATE SET v = excluded.v",
      CONTAINER_BACKEND_ID,
      rev,
    );
  }

  /** The notify's helper, on the fake Container: recorded. */
  protected override async notifyContainer(paths: ReadonlyArray<string>): Promise<void> {
    if (this.#fakeContainer === undefined) return super.notifyContainer(paths);

    this.#notified.push(`notify ${paths.join(" ")}`);
  }

  protected override runContainerScript(script: string) {
    const fake = this.#fakeContainer;

    if (fake === undefined) return super.runContainerScript(script);

    fake.scripts.push(script);
    fake.running = true;

    return Promise.resolve({ exitCode: 0, stdout: fake.outputs.shift() ?? "", stderr: "" });
  }

  /**
   * GitHub as the pull request tests have it (`comparison-pull.workerd.test.ts`): `answers` by request path, each
   * answered 200 with its JSON (a path with no answer is a 404), or every request answered `status` when given; the
   * requests made are recorded. Without it the real API is asked, which this test Worker never should.
   */
  #github: { answers: Answers; status: number | undefined; requests: string[] } | undefined;

  setGithub(answers: Answers, status?: number): void {
    this.#github = { answers, status, requests: this.#github?.requests ?? [] };
  }

  /** The paths asked of the GitHub stub so far, with their query. */
  githubRequests(): string[] {
    return [...(this.#github?.requests ?? [])];
  }

  protected override githubFetch(url: string, init: RequestInit): Promise<Response> {
    const github = this.#github;

    if (github === undefined) return super.githubFetch(url, init);

    const { pathname, search } = new URL(url);

    github.requests.push(`${pathname}${search}`);

    if (github.status !== undefined) {
      return Promise.resolve(Response.json({ message: "no" }, { status: github.status }));
    }

    const answer = github.answers[`${pathname}${search}`] ?? github.answers[pathname];

    return Promise.resolve(
      answer === undefined
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : Response.json(answer),
    );
  }

  /** The test's clock, which the pull request list's 60 s are counted by; the real one until set. */
  #now: number | undefined;

  setClock(ms: number): void {
    this.#now = ms;
  }

  protected override clock(): number {
    return this.#now ?? super.clock();
  }

  /** A Skill set whose hash starts with `UNWRITABLE_SKILL_SET` fails after its first file, as a failed copy would. */
  protected override async writeSkillSet(set: SkillSet, api: MountWriteAPI): Promise<void> {
    if (!set.hash.startsWith(UNWRITABLE_SKILL_SET)) return super.writeSkillSet(set, api);

    const [path, content] = Object.entries(set.files)[0] ?? ["x", ""];

    await api.mkdir(`${api.root}/${path.slice(0, path.lastIndexOf("/"))}`);
    await api.writeFile(`${api.root}/${path}`, new Blob([content]).stream());

    throw new Error("the Skill set's files could not be written");
  }

  /**
   * A dev server on the fake Container, as the Container preview tests have it (`container-preview.workerd.test.ts`): it
   * listens on `ports` (another port is refused as a Container refuses it), answers `/` with an HTML page, `/login` with
   * a redirect to its own absolute URL (made from `Host`, as some dev servers do) and anything else with a script that
   * says `<head>`, and opens a WebSocket for an upgrade, sending `{"type":"connected"}` at once as Vite's does and
   * answering each message with `echo:` and it. What it was asked, and each socket's messages and close, are recorded
   * (`devServerState`). Without it, the Container's ports are the real Container's, which this test Worker does not have.
   * A carried socket's stream is written to every `keepAliveMs` (50 by default: a page gone is found within a test).
   */
  #devServer:
    | {
        ports: readonly number[];
        keepAliveMs: number;
        state: DevServerState;
        sockets: WebSocket[];
      }
    | undefined;

  /** The uses Container previews made of the Container, as the idle stop is told of them. */
  #containerPreviewUses: ContainerPreviewUses = { touch: 0, begin: 0, end: 0 };

  fakeDevServer(options: {
    readonly ports: readonly number[];
    readonly keepAliveMs?: number;
  }): void {
    this.#devServer = {
      ports: options.ports,
      keepAliveMs: options.keepAliveMs ?? 50,
      state: { requests: [], sockets: [] },
      sockets: [],
    };
  }

  protected override containerPreviewKeepAliveMs(): number {
    return this.#devServer?.keepAliveMs ?? super.containerPreviewKeepAliveMs();
  }

  devServerState(): DevServerState {
    return structuredClone(this.#devServer?.state ?? { requests: [], sockets: [] });
  }

  /** The dev server sends `text` on its socket `index`. */
  devServerSend(index: number, text: string): void {
    this.#devServer?.sockets[index]?.send(text);
  }

  /** The dev server closes its socket `index`, as a restart of it does. */
  devServerClose(index: number): void {
    this.#devServer?.sockets[index]?.close(1012, "restarting");
  }

  containerPreviewUses(): ContainerPreviewUses {
    return { ...this.#containerPreviewUses };
  }

  /** Whether the Workspace was used as a Session's (a spare's preparation aside). */
  spareUsed(): boolean {
    return this.ctx.storage.kv.get<boolean>("cloudpid:spare-used") === true;
  }

  protected override containerPort(port: number): Fetcher {
    const server = this.#devServer;

    if (server === undefined) return super.containerPort(port);

    const answer = (input: RequestInfo | URL, init?: RequestInit): Response => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      server.state.requests.push({
        port,
        method: request.method,
        url: request.url,
        host: request.headers.get("host"),
        forwardedHost: request.headers.get("x-forwarded-host"),
        origin: request.headers.get("origin"),
        cookie: request.headers.get("cookie"),
        upgrade: request.headers.get("upgrade"),
        protocols: request.headers.get("sec-websocket-protocol"),
      });

      if (!server.ports.includes(port)) {
        throw new Error(`The container is not listening in the TCP address 10.0.0.1:${port}`);
      }

      if (request.headers.get("upgrade") === "websocket") {
        const pair = new WebSocketPair();
        const socket = pair[1];
        const record: DevServerSocket = { path: url.pathname, received: [], closed: null };

        socket.accept();
        socket.addEventListener("message", (event) => {
          record.received.push(String(event.data));
          socket.send(`echo:${String(event.data)}`);
        });
        socket.addEventListener("close", (event) => {
          record.closed = { code: event.code, reason: event.reason };
        });
        server.state.sockets.push(record);
        server.sockets.push(socket);
        socket.send('{"type":"connected"}');

        const protocol = request.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();

        return new Response(null, {
          status: 101,
          webSocket: pair[0],
          headers: protocol === undefined ? {} : { "sec-websocket-protocol": protocol },
        });
      }

      if (url.pathname === "/") {
        return new Response(
          '<!doctype html><html lang="en"><head><title>App</title></head><body>app</body></html>',
          { headers: { "content-type": "text/html; charset=utf-8", "content-length": "86" } },
        );
      }

      if (url.pathname === "/login") {
        return new Response(null, {
          status: 302,
          headers: { location: `http://${request.headers.get("host") ?? ""}/login/` },
        });
      }

      return new Response('export const tag = "<head>";', {
        headers: { "content-type": "text/javascript" },
      });
    };

    return {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => answer(input, init),
      connect: () => {
        throw new Error("No sockets on the fake Container");
      },
    };
  }

  protected override containerPreviewActivity(): ContainerPreviewActivity {
    const idle = super.containerPreviewActivity();
    const uses = this.#containerPreviewUses;

    return {
      touch: () => {
        uses.touch++;

        return idle.touch();
      },
      hold: (options) => {
        uses.begin++;

        const hold = idle.hold(options);

        return {
          begun: hold.begun,
          end: () => {
            uses.end++;

            return hold.end();
          },
        };
      },
    };
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

/** The Workspaces Worker's Container previews entrypoint, over this test Worker's Workspace DOs. */
export { WorkspaceContainerPreviews } from "./worker.ts";

export default {
  fetch: () => new Response("cloudpid Workspace test worker"),
};
