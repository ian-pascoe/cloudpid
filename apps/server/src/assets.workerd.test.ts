// @effect-diagnostics asyncFunction:off
// The real asset layer (the test Worker's `ASSETS` binding, configured as the deploy does), not a stand-in: what it
// answers for a missing path is the point.
import { env } from "cloudflare:test";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { describe, expect, it } from "vitest";
import { type AssetLayer, serveAsset } from "./assets.ts";

// SAFETY: the project binds the asset layer as `ASSETS` (vitest.config.ts).
const layer = (env as typeof env & { ASSETS: AssetLayer }).ASSETS;

const serve = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  Effect.runPromise(
    serveAsset(layer).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request(`https://cloudpid.test${path}`, { method, headers })),
      ),
      Effect.map(HttpServerResponse.toWeb),
    ),
  );

const navigation = { "sec-fetch-mode": "navigate", accept: "text/html" };

const script = { "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script", accept: "*/*" };

describe("the web app, from the real asset layer", () => {
  it("serves a file the build has", async () => {
    const response = await serve("/assets/chunk-abc123.js", script);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("chunk");
  });

  it("answers a chunk the build lacks with the uncached 404, never the page", async () => {
    const response = await serve("/assets/old-chunk-zzz.js", script);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Not found");
  });

  it("serves the app at /", async () => {
    const response = await serve("/", navigation);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root">');
  });

  it("serves the app to a navigation to a path that is no file", async () => {
    const response = await serve("/sessions/0190f0a8-1b2c-7d3e-8f40-123456789abc", navigation);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root">');
  });

  it("serves the app to a page load that only accepts HTML", async () => {
    const response = await serve("/settings/mcp", { accept: "text/html,*/*" });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<div id="root">');
  });

  it("leaves any other request for a path that is no file a 404, not the page", async () => {
    const response = await serve("/favicon.ico", { accept: "image/avif,image/webp,*/*" });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('<div id="root">');
  });
});
