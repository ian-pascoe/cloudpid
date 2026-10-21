// The end of a Workspace's life (`docs/spec.md` → Client and protocol → Registry): the main Worker wipes its Durable
// Object when the owner deletes it, after its Sessions are deleted.

/** What the Workspace DO answers for its deletion. */
export type LifecycleHost = {
  /** Stop the Container and wipe the object's storage: its files, settings and snapshot record. */
  destroy(): Promise<void>;
};

/** The Workspaces' own objects, by slug, as the main Worker reaches them. */
export type WorkspaceObjects = {
  /** Wipe Workspace `slug`'s object (`LifecycleHost.destroy`). */
  readonly destroy: (slug: string) => Promise<void>;
};

/** `WorkspaceObjects` over the Workspace DO namespace the main Worker binds. */
export const workspaceObjectsRemote = (namespace: {
  getByName(slug: string): LifecycleHost;
}): WorkspaceObjects => ({
  destroy: (slug) => namespace.getByName(slug).destroy(),
});
