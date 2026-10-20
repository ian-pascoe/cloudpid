/**
 * The name the Workspace DO namespace is bound under. The Worker Shell's `WorkspaceServiceProxy` finds the object by it,
 * so every Worker that hosts the class binds it under this name.
 */
export const WORKSPACE_BINDING = "WORKSPACES";

/** The Workspace root: one directory per repo below it (docs/spec.md → Filesystem and tools). */
export const WORKSPACE_ROOT = "/workspace";

/**
 * The Container the Workspace DO runs its sandbox image as: its logical id in the stack, and the key of the image in
 * `ctx.container.images` (alchemy names each Container's image by its id).
 */
export const SANDBOX_CONTAINER = "Sandbox";

/** The instance type a Workspace's Container starts on (docs/spec.md → Container and Toolchains). */
export const DEFAULT_INSTANCE = "standard-2";
