// This file has no imports: the Worker's stack and the workerd test project's miniflare config both read it.

/**
 * How the assets answer a path that is no file: `"none"`, a 404. `"single-page-application"` would answer `index.html`
 * to every such request through the `ASSETS` binding, whatever it asked for (only Cloudflare's own routing in front of a
 * Worker looks at `Sec-Fetch-Mode`), so a missing chunk would be a 200 page. {@link serveAsset} gives the page to a
 * page load itself.
 */
export const WEB_NOT_FOUND_HANDLING = "none" as const;
