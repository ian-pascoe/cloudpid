/** The name the browser host Durable Object namespace is bound under, by the Worker that hosts it and by the Session DOs. */
export const BROWSER_HOST_BINDING = "BROWSER_HOST";

/**
 * The name the browser Worker binds the Workspace DO namespace under, from the Workspaces Worker, so the Container
 * previews' entrypoint (`ContainerPreviews`) can hand a request to the Session's Workspace (ADR-0023).
 */
export const PREVIEW_WORKSPACES_BINDING = "WORKSPACES";
