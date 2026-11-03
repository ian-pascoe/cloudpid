// docs/architecture/mcp-sign-in.md → The client document and the callback outside Access (The Access guard, "the exact
// public paths"): the router that runs ahead of the guard, the single-page app's fallback and the asset layer.
//
// The bypass application (`bypass-access.ts`) lets two paths through Access, and Access lets through more than the two it
// names (sub-paths, any capitalisation, doubled slashes: #403). So the Worker decides which forms are the public paths
// and refuses every other form under their prefixes itself. The two exact paths are served here, without the guard and never
// reading identity (`mcp/sign-in-http.ts`); `/oauth/mcp/start` is not public, so it goes on to the guard like every other path.
// @effect-diagnostics missingPipeableSignature:off -- `guardedRoutes` is what `worker.ts` calls with the guard and the handlers; it is not piped.

import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { flow } from "effect/Function";
import { type AccessGuard, guardAccess } from "./access.ts";

/** The client document's path: public on every deployed stage. */
export const CLIENT_DOCUMENT_PATH = "/oauth/mcp/client.json";

/** The OAuth callback's path: public on every deployed stage, with an optional 12-character issuer hash below it. */
export const CALLBACK_PATH = "/oauth/mcp/callback";

/** The start's path: behind Access, so it is no sign-in route here and goes on to the guard. */
export const START_PATH = "/oauth/mcp/start";

/** What a path under the two public prefixes is. */
export type SignInRoute =
  | { readonly kind: "client-document" }
  | { readonly kind: "callback"; readonly hash: string | undefined }
  /** Under a public prefix but not one of the exact paths: always a 404. */
  | { readonly kind: "refused" };

/**
 * The 12-character hash of an authorization server's issuer, in the DCR redirect URI of one that does not advertise
 * `iss`. Its alphabet is the URL-safe one (hex and base64url both fit), case-sensitive.
 */
const CALLBACK_WITH_HASH = new RegExp(`^${CALLBACK_PATH}/([A-Za-z0-9_-]{12})$`);

/** The prefixes under which only the exact paths are routed, in the form {@link canonical} gives. */
const PUBLIC_PREFIXES = Arr.map([CLIENT_DOCUMENT_PATH, CALLBACK_PATH], (path) =>
  path.toLowerCase(),
);

const MAX_DECODE_PASSES = 3;

const decodeEscapesOnce = (path: string): string =>
  path.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );

/**
 * What any router that is lenient could take `path` for: percent escapes decoded (up to three times, so `%252f` too),
 * `\` as `/`, each segment cut at its first `;` (a path parameter), empty and `.` segments dropped, `..` applied, and
 * lowercased. It is only used to find the forms to refuse, so it errs on the broad side; it is never what the exact paths
 * are matched against.
 */
const canonical = (path: string): string => {
  let decoded = path;

  for (let pass = 0; pass < MAX_DECODE_PASSES; pass++) {
    const next = decodeEscapesOnce(decoded);

    if (next === decoded) break;

    decoded = next;
  }

  const segments: Array<string> = [];

  for (const raw of decoded.replaceAll("\\", "/").split("/")) {
    const segment = raw.split(";")[0] ?? "";

    if (segment === "" || segment === ".") continue;

    if (segment === "..") segments.pop();
    else segments.push(segment);
  }

  return `/${Arr.join(segments, "/")}`.toLowerCase();
};

/**
 * Which of the two public sign-in paths `pathname` is, matched exactly and case-sensitively against the path as it was
 * sent (no decoding, no normalising): `/oauth/mcp/client.json`, `/oauth/mcp/callback` and
 * `/oauth/mcp/callback/<12-character hash>`. Any other form that a lenient router would read as under either prefix
 * (`/OAuth/mcp/callback`, `//oauth/mcp/callback`, a trailing slash, a sub-path, `;`, `%2f`, …) is `refused`; every other
 * path (`/`, `/rpc`, `/oauth/mcp/start`) is `undefined`, and goes on to the guard.
 */
export const signInRoute = (pathname: string): SignInRoute | undefined => {
  if (pathname === CLIENT_DOCUMENT_PATH) return { kind: "client-document" };

  if (pathname === CALLBACK_PATH) return { kind: "callback", hash: undefined };

  const hash = CALLBACK_WITH_HASH.exec(pathname)?.[1];

  if (hash !== undefined) return { kind: "callback", hash };

  const lenient = canonical(pathname);

  return Arr.some(PUBLIC_PREFIXES, (prefix) => lenient.startsWith(prefix))
    ? { kind: "refused" }
    : undefined;
};

/** The path of a request's URL as it was sent: absolute (`https://host/path?query`) or a bare path. */
export const rawPathOf = (url: string): string => {
  const afterOrigin = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/is.exec(url)?.[1] ?? url;

  return /^[^?#]*/.exec(afterOrigin)?.[0] ?? "";
};

const notFound = HttpServerResponse.text("Not Found", {
  status: 404,
  headers: { "cache-control": "no-store" },
});

/** Whether the request is for the start exactly (`/oauth/mcp/start`, as it was sent): the Worker serves it behind the guard. */
export const isStartRequest = (request: HttpServerRequest.HttpServerRequest): boolean =>
  rawPathOf(request.url) === START_PATH;

/** A handler of one request: it reads the request itself, and answers (a failure is its own to turn into a page). */
type SignInHandler = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest
>;

/** What serves the two exact public paths: the client document, and the callback at its path (with its hash, if any). */
export type SignInHandlers = {
  readonly clientDocument: SignInHandler;
  readonly callback: (path: string) => SignInHandler;
};

/**
 * Puts the sign-in paths ahead of `guarded`, the Worker's guarded routes (the Access guard, the SPA fallback, the
 * assets): a request for a path under the two public prefixes never reaches them. The two exact paths are served by
 * `handlers`, without the guard and never reading identity; every other form of them is a 404, as the router decides
 * (`signInRoute`).
 */
export const serveSignInPaths =
  (handlers: SignInHandlers) =>
  <E, R>(
    guarded: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    E,
    R | HttpServerRequest.HttpServerRequest
  > =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const route = signInRoute(rawPathOf(request.url));

      if (route === undefined) return yield* guarded;

      switch (route.kind) {
        case "client-document":
          return yield* handlers.clientDocument;
        case "callback":
          return yield* handlers.callback(
            route.hash === undefined ? CALLBACK_PATH : `${CALLBACK_PATH}/${route.hash}`,
          );
        case "refused":
          return notFound;
      }
    });

/**
 * What the main Worker wraps its routes in: the sign-in paths first, then the Access guard (`guardAccess`) for every
 * other request. The order is the point: a form of a public path must meet the router's 404, never the guard's answer
 * and never a route behind it. `worker.ts` builds its `fetch` with this, and the test of the composition is what keeps
 * the two from being swapped.
 */
export const guardedRoutes = (guard: AccessGuard, handlers: SignInHandlers) =>
  flow(guardAccess(guard), serveSignInPaths(handlers));
