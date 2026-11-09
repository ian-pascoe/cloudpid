// docs/architecture/triggers.md → Webhooks → The Trigger URL, and ADR-0048: the exact-shape router for `/hooks/<trigger
// id>/<token>`, which runs ahead of the Access guard as `serveSignInPaths` does for the sign-in paths.
//
// `Server/Hooks` lets everything under `/hooks/*` through Access, and Access lets through more than it names (sub-paths,
// any capitalisation, doubled slashes: #403). So the Worker decides which form is a Trigger URL and refuses every other
// form under `/hooks` itself, with a 404 that says nothing. The bare `/hooks` is not public: it goes on to the guard.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over a path.
import { HOOKS_PREFIX, TOKEN_PATTERN, TRIGGER_ID_PATTERN } from "./hooks-path.ts";
import { canonicalPath } from "./sign-in-routes.ts";

/** What a path under `/hooks` is. */
export type HooksRoute =
  | { readonly kind: "delivery"; readonly id: string; readonly token: string }
  /** Under `/hooks` but not a Trigger URL's exact shape: always a 404. */
  | { readonly kind: "refused" };

const DELIVERY = new RegExp(`^${HOOKS_PREFIX}/(${TRIGGER_ID_PATTERN})/(${TOKEN_PATTERN})$`);

/**
 * Which Trigger URL `pathname` is, matched exactly and case-sensitively against the path as it was sent (no decoding, no
 * normalising): `/hooks/<UUIDv7>/<43 base64url characters>`. Any other form a lenient router would read as under
 * `/hooks` (`/Hooks/…`, `//hooks/…`, a trailing slash, another shape, a sub-path, `;`, `%2f`, …) is `refused`; the bare
 * `/hooks` and every other path are `undefined`, and go on to the guard.
 */
export const hooksRoute = (pathname: string): HooksRoute | undefined => {
  const match = DELIVERY.exec(pathname);
  const [, id, token] = match ?? [];

  if (id !== undefined && token !== undefined) return { kind: "delivery", id, token };

  if (pathname === HOOKS_PREFIX) return undefined;

  const lenient = canonicalPath(pathname);

  return lenient === HOOKS_PREFIX || lenient.startsWith(`${HOOKS_PREFIX}/`)
    ? { kind: "refused" }
    : undefined;
};
