// The Workspace DO (docs/spec.md → Durable Objects, ADR-0001): one `@cloudflare/computer` Workspace per slug, its
// files in this object's SQLite storage, its commands on the Worker Shell or, for real binaries, in the Container the
// object schedules itself (ADR-0004; `durable_object` scheduling). It is a plain class rather than an alchemy
// Effect DO: computer reaches it through `__getWorkspaceStub()` with raw Workers RPC (its Worker Shell calls back into
// it through `WorkspaceServiceProxy`), which alchemy's Effect bridge would wrap in its own envelopes.
// @effect-diagnostics asyncFunction:off globalDate:off globalConsole:off
import {
  noopObserver,
  Workspace as ComputerWorkspace,
  type WorkspaceObserver,
  type WorkspaceStub,
} from "@cloudflare/computer";
import { ContainerBackend, withWorkspaceContainer } from "@cloudflare/computer/backends/container";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import {
  type EnvRequest,
  type EnvResponse,
  type HostOperation,
  WorkspaceEnvHost,
} from "@cloudpid/computer-env";
import { DurableObject } from "cloudflare:workers";
import { IDLE_STOP_MS, IdleStop } from "./idle.ts";
import { TrackedWorkspaceStub } from "./tracked.ts";
import {
  DEFAULT_INSTANCE,
  WORKSPACE_CONTAINER,
  WORKSPACE_BINDING,
  WORKSPACE_ROOT,
} from "./binding.ts";

export type WorkspaceEnv = {
  /** The Worker Loader the Worker Shell runs in. */
  readonly LOADER: WorkerLoader;
};

/** A Durable Object that can start the Container it is bound to (`getWorkspaceContainer()`, for `ContainerBackend`). */
const ContainerHost = withWorkspaceContainer(class extends DurableObject<WorkspaceEnv> {});

/** Where the last use of the Container is kept, for an alarm that wakes an evicted object. */
const LAST_USE_KEY = "cloudpid:container-last-use";

/** The id the Container's backend has in the Workspace (`@cloudflare/computer`'s default). */
const CONTAINER_BACKEND_ID = "container-shell";

export class Workspace extends ContainerHost {
  readonly #workspace: ComputerWorkspace;
  readonly #host: WorkspaceEnvHost;
  readonly #container: ContainerBackend;
  readonly #idle: IdleStop;

  constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
    super(ctx, env);

    this.#idle = new IdleStop({
      idleMs: IDLE_STOP_MS,
      now: () => Date.now(),
      load: () => ctx.storage.get<number>(LAST_USE_KEY),
      save: (at) => ctx.storage.put(LAST_USE_KEY, at),
      setAlarm: (at) => ctx.storage.setAlarm(at),
      stop: async () => {
        if (ctx.container?.running === true) await ctx.container.destroy();
      },
    });

    // The Container starts when a command first asks for it, not with the object.
    this.#container = new ContainerBackend({
      container: () => this,
      workspace: { binding: WORKSPACE_BINDING, id: ctx.id.toString() },
      name: WORKSPACE_CONTAINER,
      instance: DEFAULT_INSTANCE,
      // Unrestricted direct egress in v1, not logged (docs/spec.md → Container and Toolchains).
      egress: { mode: "direct" },
    });

    this.#workspace = new ComputerWorkspace({
      storage: ctx.storage,
      observer: this.#containerUseObserver(),
      backends: [
        new WorkerShellBackend({
          loader: env.LOADER,
          workspace: { binding: WORKSPACE_BINDING, id: ctx.id.toString() },
          ctx,
        }),
        this.#container,
      ],
    });

    this.#host = new WorkspaceEnvHost(this.#workspace);
    void ctx.blockConcurrencyWhile(() => this.#host.prepare(WORKSPACE_ROOT, Date.now()));
  }

  /**
   * Records each use of the Container for the idle stop: computer reports a span around every connect, push and pull on a
   * backend, and a command on the Container is a push before it and a pull after it.
   */
  #containerUseObserver(): WorkspaceObserver {
    const uses = (attributes: Parameters<WorkspaceObserver["span"]>[1]) =>
      attributes["workspace.sync.backend"] === CONTAINER_BACKEND_ID ||
      attributes["workspace.backend.id"] === CONTAINER_BACKEND_ID;

    const touch = () => {
      // A failed write only shortens the idle time: the alarm works from what was stored before.
      this.#idle.touch().catch((cause: unknown) => console.warn("idle stop: touch failed", cause));
    };

    return {
      span: (name, attributes, run) => {
        if (!uses(attributes)) return noopObserver.span(name, attributes, run);

        touch();

        return noopObserver.span(name, attributes, run).finally(touch);
      },
    };
  }

  /** The idle stop's alarm. */
  alarm(): Promise<void> {
    return this.#idle.alarm();
  }

  /** The Container's egress: computerd dials back here, and `WorkspaceProxy` forwards its WebSocket upgrade. */
  override fetch(request: Request): Promise<Response> {
    return this.#container.handleFetch(request);
  }

  /** computer's Workspace RPC, for `getWorkspace()`: the caller disposes the stub. */
  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.#workspace.ready();

    return this.workspaceStub(this.#workspace);
  }

  /** One of `ComputerExecutionEnv`'s file operations, answered as plain data. */
  fileOperation(request: EnvRequest): Promise<EnvResponse<HostOperation>> {
    return this.#host.handle(request);
  }

  /** The RPC stub `__getWorkspaceStub()` hands out, its Container commands counted by the idle stop; tests count them too. */
  protected workspaceStub(workspace: ComputerWorkspace): WorkspaceStub {
    return new TrackedWorkspaceStub(workspace, this.#idle, CONTAINER_BACKEND_ID);
  }
}
