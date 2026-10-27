/** The name the browser host Durable Object namespace is bound under, by the Worker that hosts it and by the Session DOs. */
export const BROWSER_HOST_BINDING = "BROWSER_HOST";

/**
 * The name the browser Worker binds the Workspaces Worker's Container previews entrypoint under
 * (`WorkspaceContainerPreviews`), so its own `ContainerPreviews` can hand a request to the Session's Workspace
 * (ADR-0023). That entrypoint offers the Container preview alone, not the Workspace DO's other methods.
 */
export const CONTAINER_PREVIEWS_BINDING = "CONTAINER_PREVIEWS";

/** The name of the Workspaces Worker's entrypoint the browser Worker binds as `CONTAINER_PREVIEWS`. */
export const WORKSPACE_CONTAINER_PREVIEWS_ENTRYPOINT = "WorkspaceContainerPreviews";
