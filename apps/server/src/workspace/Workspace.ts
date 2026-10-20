// The Workspace DO (docs/spec.md → Durable Objects, ADR-0001): one `@cloudflare/computer` Workspace per slug, its
// files in this object's SQLite storage, its commands on the Worker Shell or, for real binaries, in the Container the
// object schedules itself (ADR-0004; `durable_object` scheduling). It is a plain class rather than an alchemy
// Effect DO: computer reaches it through `__getWorkspaceStub()` with raw Workers RPC (its Worker Shell calls back into
// it through `WorkspaceServiceProxy`), which alchemy's Effect bridge would wrap in its own envelopes.
// @effect-diagnostics asyncFunction:off globalDate:off
import { Workspace as ComputerWorkspace, type WorkspaceStub } from "@cloudflare/computer";
import { ContainerBackend, withWorkspaceContainer } from "@cloudflare/computer/backends/container";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import {
  type EnvRequest,
  type EnvResponse,
  type HostOperation,
  WorkspaceEnvHost,
} from "@cloudpid/computer-env";
import { DurableObject } from "cloudflare:workers";
import {
  DEFAULT_INSTANCE,
  SANDBOX_CONTAINER,
  WORKSPACE_BINDING,
  WORKSPACE_ROOT,
} from "./binding.ts";

export type WorkspaceEnv = {
  /** The Worker Loader the Worker Shell runs in. */
  readonly LOADER: WorkerLoader;
};

/** A Durable Object that can start the Container it is bound to (`getWorkspaceContainer()`, for `ContainerBackend`). */
const ContainerHost = withWorkspaceContainer(class extends DurableObject<WorkspaceEnv> {});

export class Workspace extends ContainerHost {
  readonly #workspace: ComputerWorkspace;
  readonly #host: WorkspaceEnvHost;
  readonly #container: ContainerBackend;

  constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
    super(ctx, env);

    // The Container starts when a command first asks for it, not with the object.
    this.#container = new ContainerBackend({
      container: () => this,
      workspace: { binding: WORKSPACE_BINDING, id: ctx.id.toString() },
      name: SANDBOX_CONTAINER,
      instance: DEFAULT_INSTANCE,
      // Unrestricted direct egress in v1 (docs/spec.md → Container and Toolchains).
      egress: { mode: "direct" },
    });

    this.#workspace = new ComputerWorkspace({
      storage: ctx.storage,
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

  /** The RPC stub `__getWorkspaceStub()` hands out; tests count them. */
  protected workspaceStub(workspace: ComputerWorkspace): WorkspaceStub {
    return workspace.stub();
  }
}
