// The end and the fresh starts of a Workspace's life (`docs/spec.md` → Workspaces from the UI): the main Worker wipes
// its Durable Object when the owner deletes it or resets it, after its Sessions are deleted, and stops its Container and
// forgets the saved disk when the owner restarts the Container.

/** Why a deleted or reset Workspace's object resets (`ctx.abort`); the call that asks for the reset fails with it. */
export const WORKSPACE_DELETED_REASON = "Workspace deleted";

/** What the Workspace DO answers for its deletion, its reset and the restart of its Container. */
export type LifecycleHost = {
  /** Stop the Container and wipe the object's storage: its files, settings and snapshot record. */
  destroy(): Promise<void>;
  /** As `destroy`, but the Workspace's own settings are kept. */
  clear(): Promise<void>;
  /** Reset the object once `destroy` or `clear` has answered; always fails with `WORKSPACE_DELETED_REASON`. */
  reset(): Promise<void>;
  /** Stop the Container and forget the snapshot, so the next command starts one from the image. */
  restartContainer(): Promise<void>;
};

/** The Workspaces' own objects, by slug, as the main Worker reaches them. */
export type WorkspaceObjects = {
  /** Wipe Workspace `slug`'s object (`LifecycleHost.destroy`), then reset it (`LifecycleHost.reset`). */
  readonly destroy: (slug: string) => Promise<void>;
  /** Wipe Workspace `slug`'s object but its settings (`LifecycleHost.clear`), then reset it. */
  readonly clear: (slug: string) => Promise<void>;
  /** Stop Workspace `slug`'s Container and forget its snapshot (`LifecycleHost.restartContainer`). */
  readonly restartContainer: (slug: string) => Promise<void>;
};

/** `WorkspaceObjects` over the Workspace DO namespace the main Worker binds. */
export const workspaceObjectsRemote = (namespace: {
  getByName(slug: string): LifecycleHost;
}): WorkspaceObjects => {
  // Once the wipe has answered, the object resets: that call fails by design (an abort fails the call that makes it),
  // and a reset that does not happen only leaves an instance over empty storage until it is evicted.
  const wipeThenReset = (workspace: LifecycleHost, wipe: () => Promise<void>) =>
    wipe().then(() => workspace.reset().catch(() => undefined));

  return {
    destroy: (slug) => {
      const workspace = namespace.getByName(slug);

      return wipeThenReset(workspace, () => workspace.destroy());
    },
    clear: (slug) => {
      const workspace = namespace.getByName(slug);

      return wipeThenReset(workspace, () => workspace.clear());
    },
    restartContainer: (slug) => namespace.getByName(slug).restartContainer(),
  };
};
