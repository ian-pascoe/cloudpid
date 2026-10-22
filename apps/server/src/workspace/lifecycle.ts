// The end of a Workspace's life (`docs/spec.md` → Client and protocol → Registry): the main Worker wipes its Durable
// Object when the owner deletes it, after its Sessions are deleted.

/** Why a deleted Workspace's object resets (`ctx.abort`); the call that asks for the reset fails with it. */
export const WORKSPACE_DELETED_REASON = "Workspace deleted";

/** What the Workspace DO answers for its deletion. */
export type LifecycleHost = {
  /** Stop the Container and wipe the object's storage: its files, settings and snapshot record. */
  destroy(): Promise<void>;
  /** Reset the object once `destroy` has answered; always fails with `WORKSPACE_DELETED_REASON`. */
  reset(): Promise<void>;
};

/** The Workspaces' own objects, by slug, as the main Worker reaches them. */
export type WorkspaceObjects = {
  /** Wipe Workspace `slug`'s object (`LifecycleHost.destroy`), then reset it (`LifecycleHost.reset`). */
  readonly destroy: (slug: string) => Promise<void>;
};

/** `WorkspaceObjects` over the Workspace DO namespace the main Worker binds. */
export const workspaceObjectsRemote = (namespace: {
  getByName(slug: string): LifecycleHost;
}): WorkspaceObjects => ({
  destroy: (slug) => {
    const workspace = namespace.getByName(slug);

    // Once the wipe has answered, the object resets: that call fails by design (an abort fails the call that makes it),
    // and a reset that does not happen only leaves an instance over empty storage until it is evicted.
    return workspace.destroy().then(() => workspace.reset().catch(() => undefined));
  },
});
