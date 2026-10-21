/**
 * The name the Workspace DO namespace is bound under. The Worker Shell's `WorkspaceServiceProxy` finds the object by it,
 * so every Worker that hosts the class binds it under this name.
 */
export const WORKSPACE_BINDING = "WORKSPACES";

/**
 * The Workspace root: one directory per repo below it (docs/spec.md → Filesystem and tools). Defined in the protocol's
 * `repo` module, which pulls in none of the rest of the protocol, so the Workspaces Worker's bundle stays small.
 */
export { WORKSPACE_ROOT } from "@cloudpid/protocol/repo";

/** Where the bundled skills are mounted, read-only, in every Workspace: the Workspace's own `.agents/skills` (docs/spec.md → Filesystem and tools). */
export const SKILLS_MOUNT = "/workspace/.agents/skills";

/**
 * The Container the Workspace DO runs the sandbox image (`apps/sandbox-image`) as: its logical id in the stack, and the key of the image in
 * `ctx.container.images` (alchemy names each Container's image by its id).
 */
export const WORKSPACE_CONTAINER = "WorkspaceContainer";

/** The instance type a Workspace's Container starts on (docs/spec.md → Container and Toolchains). */
export const DEFAULT_INSTANCE = "standard-2";
