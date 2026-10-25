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

/**
 * The name of Workspace `id`'s Durable Object (ADR-0016): one object, with its Container, per Workspace. The colon keeps
 * it apart from the slugs the Machines' objects were named by before Environments, which are wiped at the cutover.
 */
export const workspaceObjectName = (id: string): string => `ws:${id}`;

/**
 * The name of the Durable Object that makes Environment `id`'s Builds (docs/spec.md → Builds): a Workspace DO of its
 * own, whose name no Workspace's can be (`ws:` and the eight hex digits of a `WorkspaceId`).
 */
export const buildObjectName = (environment: string): string => `build:${environment}`;

/**
 * The name of the Durable Object that makes Environment `id`'s Test Builds (docs/spec.md → Builds → Test Builds): a
 * Workspace DO of its own beside the Build object, so a Test Build never waits for a Build or holds one up.
 */
export const testBuildObjectName = (environment: string): string => `test-build:${environment}`;
