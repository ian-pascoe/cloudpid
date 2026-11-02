import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * The answer to a request for an `/assets/…` file the current build does not have (`serveAsset`). It is a 404, never a
 * 200 page or `text/plain`: a browser asked for an old build's chunk would report a "wrong MIME type" error instead of
 * a missing file, and a 404 is what the web app's reload on a stale build (`apps/web/src/stale-build.ts`) is told apart
 * by. Never cached: the next deploy may hold the file.
 */
export const missingAsset = HttpServerResponse.text("Not found", {
  status: 404,
  headers: { "cache-control": "no-store" },
});
