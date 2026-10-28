// The end and the fresh starts of a Workspace's life (`docs/architecture/workspace.md` → Workspaces from the UI): the main Worker wipes
// its Durable Object when the owner removes it, after its Sessions are deleted, stops its Container and forgets the
// saved disk when the owner restarts the Container, and asks the object of a spare Workspace it registered to prepare
// itself, asks an Environment's Build object for a Build, and has a Workspace carry its clones to a Fork's new one.

import type { KeptSecret } from "@cloudpid/extensions/secrets/core";
import type { RepoWorkState } from "@cloudpid/sandbox-image/workspaces";
import type { BuildRequest, BuildState } from "./build-record.ts";
import type { WorkspaceSetup } from "./prepare.ts";

/** Why a removed Workspace's object resets (`ctx.abort`); the call that asks for the reset fails with it. */
export const WORKSPACE_DELETED_REASON = "Workspace deleted";

/** What the Workspace DO answers for its removal and the restart of its Container. */
export type LifecycleHost = {
  /** Stop the Container and wipe the object's storage: its files, settings and snapshot record. */
  destroy(): Promise<void>;
  /** Reset the object once `destroy` has answered; always fails with `WORKSPACE_DELETED_REASON`. */
  reset(): Promise<void>;
  /**
   * Stop the Container and forget the snapshot, so the next command starts one from the Environment's Build when there is
   * a usable one, else from the image.
   */
  restartContainer(): Promise<void>;
  /**
   * Prepare the object as its Environment's spare Workspace, on its own time: the call answers at once. The set-up's
   * Secrets are kept sealed apart from it.
   */
  prepareSpare(setup: WorkspaceSetup): Promise<void>;
  /**
   * Make the object's Environment's Build of `request` (a Build object), on its own time: the call answers at once.
   * `secrets` are the Environment's, kept sealed apart from the request.
   */
  startBuild(request: BuildRequest, secrets: ReadonlyArray<KeptSecret>): Promise<BuildState>;
  /** The Build object's Builds, and the image a launch would run now. */
  buildState(): Promise<BuildState>;
  /** Stop Test Build `id` (a Test Build object's), if it is the one under way; answers the state then. */
  cancelBuild(id: string): Promise<BuildState>;
  /**
   * Push the object's clones of `repos` to their remotes as `branch`, uncommitted Changes included, for a Fork or Clone
   * in a new Workspace on `branch` to start from. Rejects with why when any could not be; nothing is left pushed then.
   */
  carry(branch: string, repos: ReadonlyArray<string>): Promise<void>;
  /**
   * What the object's clones of `repos` have not pushed of `branch`: uncommitted Changes, and commits no remote branch has
   * (as `workStateScript` reads them). Read by the Workspace DO itself while the Container is stopped, which starts it
   * only for a repo it cannot read (`WorkspaceWorkStateModule`).
   */
  workState(branch: string, repos: ReadonlyArray<string>): Promise<ReadonlyArray<RepoWorkState>>;
};

/** The Workspaces' own objects, by object name (`workspaceObjectName`), as the main Worker reaches them. */
export type WorkspaceObjects = {
  /** Wipe object `name` (`LifecycleHost.destroy`), then reset it (`LifecycleHost.reset`). */
  readonly destroy: (name: string) => Promise<void>;
  /** Stop object `name`'s Container and forget its snapshot (`LifecycleHost.restartContainer`). */
  readonly restartContainer: (name: string) => Promise<void>;
  /** Ask object `name` to prepare itself as a spare Workspace with `setup` (`LifecycleHost.prepareSpare`). */
  readonly prepareSpare: (name: string, setup: WorkspaceSetup) => Promise<void>;
  /** Ask Build object `name` (`buildObjectName`) for a Build of `request` (`LifecycleHost.startBuild`). */
  readonly startBuild: (
    name: string,
    request: BuildRequest,
    secrets: ReadonlyArray<KeptSecret>,
  ) => Promise<BuildState>;
  /** Build object `name`'s Builds (`LifecycleHost.buildState`). */
  readonly buildState: (name: string) => Promise<BuildState>;
  /** Stop Test Build `id` of Test Build object `name` (`testBuildObjectName`; `LifecycleHost.cancelBuild`). */
  readonly cancelBuild: (name: string, id: string) => Promise<BuildState>;
  /** Carry object `name`'s clones of `repos` to a new Workspace on `branch` (`LifecycleHost.carry`). */
  readonly carry: (name: string, branch: string, repos: ReadonlyArray<string>) => Promise<void>;
  /** What object `name`'s clones of `repos` have not pushed of `branch` (`LifecycleHost.workState`). */
  readonly workState: (
    name: string,
    branch: string,
    repos: ReadonlyArray<string>,
  ) => Promise<ReadonlyArray<RepoWorkState>>;
};

/** `WorkspaceObjects` over the Workspace DO namespace the main Worker binds. */
export const workspaceObjectsRemote = (namespace: {
  getByName(name: string): LifecycleHost;
}): WorkspaceObjects => {
  // Once the wipe has answered, the object resets: that call fails by design (an abort fails the call that makes it),
  // and a reset that does not happen only leaves an instance over empty storage until it is evicted.
  const wipeThenReset = (workspace: LifecycleHost, wipe: () => Promise<void>) =>
    wipe().then(() => workspace.reset().catch(() => undefined));

  return {
    destroy: (name) => {
      const workspace = namespace.getByName(name);

      return wipeThenReset(workspace, () => workspace.destroy());
    },
    restartContainer: (name) => namespace.getByName(name).restartContainer(),
    prepareSpare: (name, setup) => namespace.getByName(name).prepareSpare(setup),
    startBuild: (name, request, secrets) => namespace.getByName(name).startBuild(request, secrets),
    buildState: (name) => namespace.getByName(name).buildState(),
    cancelBuild: (name, id) => namespace.getByName(name).cancelBuild(id),
    carry: (name, branch, repos) => namespace.getByName(name).carry(branch, repos),
    workState: (name, branch, repos) => namespace.getByName(name).workState(branch, repos),
  };
};
