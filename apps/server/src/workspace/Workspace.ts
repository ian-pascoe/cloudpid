// The Workspace DO (docs/spec.md → Durable Objects, ADR-0001): one `@cloudflare/computer` Workspace per slug, its
// files in this object's SQLite storage, its commands on the Worker Shell. It is a plain class rather than an alchemy
// Effect DO: computer reaches it through `__getWorkspaceStub()` with raw Workers RPC (its Worker Shell calls back into
// it through `WorkspaceServiceProxy`), which alchemy's Effect bridge would wrap in its own envelopes.
// @effect-diagnostics asyncFunction:off globalDate:off
import { Workspace as ComputerWorkspace, type WorkspaceStub } from "@cloudflare/computer";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import {
  type EnvRequest,
  type EnvResponse,
  type HostOperation,
  WorkspaceEnvHost,
} from "@cloudpid/computer-env";
import { DurableObject } from "cloudflare:workers";
import { WORKSPACE_BINDING } from "./binding.ts";

/** The Workspace root: one directory per repo below it (docs/spec.md → Filesystem and tools). */
export const WORKSPACE_ROOT = "/workspace";

export type WorkspaceEnv = {
  /** The Worker Loader the Worker Shell runs in. */
  readonly LOADER: WorkerLoader;
};

export class Workspace extends DurableObject<WorkspaceEnv> {
  readonly #workspace: ComputerWorkspace;
  readonly #host: WorkspaceEnvHost;

  constructor(ctx: DurableObjectState, env: WorkspaceEnv) {
    super(ctx, env);

    this.#workspace = new ComputerWorkspace({
      storage: ctx.storage,
      backends: [
        new WorkerShellBackend({
          loader: env.LOADER,
          workspace: { binding: WORKSPACE_BINDING, id: ctx.id.toString() },
          ctx,
        }),
      ],
    });

    this.#host = new WorkspaceEnvHost(this.#workspace);
    void ctx.blockConcurrencyWhile(() => this.#host.prepare(WORKSPACE_ROOT, Date.now()));
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
