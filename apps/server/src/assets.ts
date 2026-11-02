// docs/architecture/mcp-sign-in.md → The Access guard (every other route, assets included) and
// docs/architecture/client-and-protocol.md → Serving and deploys. The web app's files are served by the Worker, after
// its guard, from the `ASSETS` binding: the assets are set to run the Worker first, so no file is answered without it.

import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { hello } from "./hello.ts";
import { missingAsset } from "./missing-asset.ts";
import { isAssetPath } from "./routes.ts";

/**
 * How the assets answer a path that is no file: `"none"`, a 404. `"single-page-application"` would answer `index.html`
 * to every such request through the `ASSETS` binding, whatever it asked for (only Cloudflare's own routing in front of a
 * Worker looks at `Sec-Fetch-Mode`), so a missing chunk would be a 200 page. {@link serveAsset} gives the page to a
 * page load itself.
 */
export const WEB_NOT_FOUND_HANDLING = "none" as const;

/** What the Worker's `ASSETS` binding gives: the asset layer, as a `fetch`. */
export type AssetLayer = { readonly fetch: (request: Request) => Promise<Response> };

/** Whether `request` is a page load: a navigation, or a `GET` that accepts HTML. */
const isPageLoad = (request: HttpServerRequest.HttpServerRequest): boolean =>
  request.method === "GET" &&
  (request.headers["sec-fetch-mode"] === "navigate" ||
    (request.headers.accept ?? "").includes("text/html"));

/**
 * The answer for a request none of the Worker's routes took. The asset layer answers a `GET` or `HEAD` with a file the
 * build has, or a 404 ({@link WEB_NOT_FOUND_HANDLING}). A 404 for a file under `/assets/` is `missingAsset` (never
 * cached, which the web app's reload on a stale build tells apart by); a 404 for a page load (`/sessions/:id`) is
 * answered with the app, `index.html`; any other 404 stays one. Every other method gets the hello answer, or
 * `missingAsset` under `/assets/`.
 */
export const serveAsset = Effect.fn("serveAsset")(function* (layer: AssetLayer) {
  const request = yield* HttpServerRequest.HttpServerRequest;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return isAssetPath(request) ? missingAsset : hello;
  }

  // A request the Worker received is a Web request already: converting it cannot fail.
  const web = yield* Effect.orDie(HttpServerRequest.toWeb(request));
  const response = yield* Effect.promise(() => layer.fetch(web));

  if (response.status !== 404) return HttpServerResponse.fromWeb(response);

  if (isAssetPath(request)) return missingAsset;

  if (!isPageLoad(request)) return HttpServerResponse.fromWeb(response);

  // The app is the asset layer's `/`, which serves `index.html`.
  const app = yield* Effect.promise(() => layer.fetch(new Request(new URL("/", web.url), web)));

  return HttpServerResponse.fromWeb(app);
});
