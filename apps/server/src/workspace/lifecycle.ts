// The end and the fresh starts of a Workspace's life (`docs/spec.md` → Workspaces from the UI): the main Worker wipes
// its Durable Object when the owner removes it, after its Sessions are deleted, stops its Container and forgets the
// saved disk when the owner restarts the Container, and asks the object of a spare Workspace it registered to prepare
// itself, and asks an Environment's Build object for a Build.

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
  /** Stop the Container and forget the snapshot, so the next command starts one from the image. */
  restartContainer(): Promise<void>;
  /** Prepare the object as its Environment's spare Workspace, on its own time: the call answers at once. */
  prepareSpare(setup: WorkspaceSetup): Promise<void>;
  /** Make the object's Environment's Build of `request` (a Build object), on its own time: the call answers at once. */
  startBuild(request: BuildRequest): Promise<BuildState>;
  /** The Build object's Builds, and the image a launch would run now. */
  buildState(): Promise<BuildState>;
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
  readonly startBuild: (name: string, request: BuildRequest) => Promise<BuildState>;
  /** Build object `name`'s Builds (`LifecycleHost.buildState`). */
  readonly buildState: (name: string) => Promise<BuildState>;
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
    startBuild: (name, request) => namespace.getByName(name).startBuild(request),
    buildState: (name) => namespace.getByName(name).buildState(),
  };
};
