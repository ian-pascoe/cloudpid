// The Trigger URLs' path (`docs/architecture/triggers.md` → The Trigger URL, ADR-0048): `/hooks/<trigger id>/<token>`. The
// constants are here, not in `hooks-routes.ts`, so that the Worker's props (the `Server/Hooks` Access application) import
// none of the routes (`docs/development/workers.md` → Startup), as `mcp/sign-in-origin.ts` does for the sign-in paths.
// @effect-diagnostics missingPipeableSignature:off -- a plain function over strings.

/** The prefix every Trigger URL is under. `Server/Hooks` covers `<host>/hooks/*`; bare `/hooks` stays behind Access. */
export const HOOKS_PREFIX = "/hooks";

/** A Trigger id as its URL holds it: a UUIDv7, lowercase (`registry/ids.ts`). */
export const TRIGGER_ID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/** A Trigger URL's token as its URL holds it: 256 random bits, 43 base64url characters. */
export const TOKEN_PATTERN = "[A-Za-z0-9_-]{43}";

/** The route template that spans and logs record in place of a Trigger URL's path: never the id or the token. */
export const HOOKS_ROUTE_TEMPLATE = "/hooks/:id/:token";

/** A Trigger's URL path: `/hooks/<trigger id>/<token>`. */
export const hookPath = (id: string, token: string): string => `${HOOKS_PREFIX}/${id}/${token}`;
