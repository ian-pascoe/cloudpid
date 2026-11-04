/**
 * The host feature that takes `ctx.start: false` on a `resources/read` (`MCP_HOST_FEATURES`): a stdio server's read then
 * never starts its Container. Without it a stdio server is not listed for the `@` menu and not read for a card's preview
 * (`./attached-resources.ts`, `./resource-preview.ts`), and the Session never sends the key to a host that would drop it.
 */
export const MCP_NO_START_FEATURE = "no_start";
