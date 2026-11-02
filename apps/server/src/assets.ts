// docs/architecture/mcp-sign-in.md → The Access guard (every other route, assets included) and
// docs/architecture/client-and-protocol.md → Serving and deploys. The web app's files are served by the Worker, after
// its guard, from the `ASSETS` binding: the assets are set to run the Worker first, so no file is answered without it.

import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { hello } from "./hello.ts";
import { missingAsset } from "./missing-asset.ts";
import { isAssetPath } from "./routes.ts";

/** What the Worker's `ASSETS` binding gives: the asset layer, as a `fetch`. */
export type AssetLayer = { readonly fetch: (request: Request) => Promise<Response> };

/**
 * The answer for a request none of the Worker's routes took. The asset layer answers a `GET` or `HEAD`: a file the
 * build has, `index.html` for a navigation to an unknown path (`/sessions/:id`), and a 404 for anything else. A 404
 * for a file under `/assets/` is `missingAsset` (never cached, which the web app's reload on a stale build tells apart
 * by); every other method gets the hello answer, or `missingAsset` under `/assets/`.
 */
export const serveAsset = Effect.fn("serveAsset")(function* (layer: AssetLayer) {
  const request = yield* HttpServerRequest.HttpServerRequest;

  if (request.method !== "GET" && request.method !== "HEAD") {
    return isAssetPath(request) ? missingAsset : hello;
  }

  // A request the Worker received is a Web request already: converting it cannot fail.
  const web = yield* Effect.orDie(HttpServerRequest.toWeb(request));
  const response = yield* Effect.promise(() => layer.fetch(web));

  if (response.status === 404 && isAssetPath(request)) return missingAsset;

  return HttpServerResponse.fromWeb(response);
});
