import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * The answer to a request for an `/assets/…` file the current build does not have. With `notFoundHandling:
 * "single-page-application"` the asset layer gives `index.html` only to navigations; any other request for a missing
 * file reaches the Worker, which used to answer it with `hello` (200, `text/plain`), so a browser asked for an old
 * build's chunk saw a "wrong MIME type" error instead of a missing file. A 404 is what the web app's reload on a stale
 * build (`apps/web/src/stale-build.ts`) is told apart by. Never cached: the next deploy may hold the file.
 */
export const missingAsset = HttpServerResponse.text("Not found", {
  status: 404,
  headers: { "cache-control": "no-store" },
});
