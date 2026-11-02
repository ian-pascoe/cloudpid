// @effect-diagnostics asyncFunction:off
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { describe, expect, it, vi } from "vitest";
import { serveAsset } from "./assets.ts";

const serve = (request: Request, layer: (request: Request) => Promise<Response>) =>
  Effect.runPromise(
    serveAsset({ fetch: layer }).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(request),
      ),
      Effect.map(HttpServerResponse.toWeb),
    ),
  );

const at = (path: string, method = "GET") =>
  new Request(`https://cloudpid.test${path}`, { method });

describe("the web app's files, served after the guard", () => {
  it("gives what the asset layer answers", async () => {
    const layer = vi.fn(() => Promise.resolve(new Response("<html>", { status: 200 })));
    const response = await serve(at("/sessions/abc"), layer);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<html>");
    expect(layer).toHaveBeenCalledTimes(1);
  });

  it("answers a missing /assets/ file with a 404 that is not cached, never the layer's", async () => {
    const response = await serve(at("/assets/old-chunk.js"), () =>
      Promise.resolve(new Response("nope", { status: 404 })),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Not found");
  });

  it("leaves another 404 as the layer gave it", async () => {
    const response = await serve(at("/favicon.ico"), () =>
      Promise.resolve(new Response("gone", { status: 404 })),
    );

    expect(await response.text()).toBe("gone");
  });

  it("does not ask the layer about a method it does not serve", async () => {
    const layer = vi.fn(() => Promise.resolve(new Response("x")));

    expect((await serve(at("/anything", "POST"), layer)).status).toBe(200);
    expect((await serve(at("/assets/a.js", "POST"), layer)).status).toBe(404);
    expect(layer).not.toHaveBeenCalled();
  });
});
