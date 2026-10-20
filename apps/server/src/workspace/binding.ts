/**
 * The name the Workspace DO namespace is bound under. The Worker Shell's `WorkspaceServiceProxy` finds the object by it,
 * so every Worker that hosts the class binds it under this name.
 */
export const WORKSPACE_BINDING = "WORKSPACES";

/** The Workspace root: one directory per repo below it (docs/spec.md → Filesystem and tools). */
export const WORKSPACE_ROOT = "/workspace";
