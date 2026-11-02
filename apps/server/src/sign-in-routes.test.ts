// @effect-diagnostics asyncFunction:off missedPipeableOpportunity:off
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { describe, expect, it, vi } from "vitest";
import {
  CALLBACK_PATH,
  CLIENT_DOCUMENT_PATH,
  rawPathOf,
  serveSignInPaths,
  signInRoute,
} from "./sign-in-routes.ts";

const HASH = "aB3_-9xYz012";

describe("the exact public paths", () => {
  it("are the client document, the callback, and the callback below one 12-character hash", () => {
    expect(signInRoute("/oauth/mcp/client.json")).toEqual({ kind: "client-document" });
    expect(signInRoute("/oauth/mcp/callback")).toEqual({ kind: "callback", hash: undefined });
    expect(signInRoute(`/oauth/mcp/callback/${HASH}`)).toEqual({ kind: "callback", hash: HASH });
  });

  it("are the two the bypass application is declared for", () => {
    expect([CLIENT_DOCUMENT_PATH, CALLBACK_PATH]).toEqual([
      "/oauth/mcp/client.json",
      "/oauth/mcp/callback",
    ]);
  });
});

describe("every other form of them", () => {
  it.each([
    ["capitalisation of the prefix", "/OAuth/mcp/callback"],
    ["capitalisation of the callback", "/oauth/mcp/Callback"],
    ["capitalisation of the document", "/oauth/mcp/CLIENT.JSON"],
    ["capitalisation of a hash's route", `/OAUTH/MCP/CALLBACK/${HASH}`],
    ["a doubled leading slash", "//oauth/mcp/callback"],
    ["a doubled slash inside", "/oauth//mcp/callback"],
    ["a doubled slash before the document", "/oauth/mcp//client.json"],
    ["a doubled slash before the hash", `/oauth/mcp/callback//${HASH}`],
    ["a trailing slash on the callback", "/oauth/mcp/callback/"],
    ["a trailing slash on the document", "/oauth/mcp/client.json/"],
    ["a sub-path of the callback", `/oauth/mcp/callback/${HASH}/x`],
    ["a sub-path of the document", "/oauth/mcp/client.json/x"],
    ["a suffix on the callback", "/oauth/mcp/callbackx"],
    ["a suffix on the document", "/oauth/mcp/client.json.bak"],
    ["a hash that is too short", "/oauth/mcp/callback/aB3_-9xYz01"],
    ["a hash that is too long", `/oauth/mcp/callback/${HASH}3`],
    ["a hash with a character outside the alphabet", "/oauth/mcp/callback/aB3_-9xYz0.2"],
    ["a `;` after the callback", "/oauth/mcp/callback;x"],
    ["a `;` with a value after the callback", "/oauth/mcp/callback;x=1"],
    ["a `;` before the hash", `/oauth/mcp/callback;x/${HASH}`],
    ["a `;` after the document", "/oauth/mcp/client.json;.css"],
    ["a `;` in the prefix", "/oauth;x/mcp/callback"],
    ["a `;` segment", `/oauth/mcp/;/callback`],
    ["%2f before the hash", `/oauth/mcp/callback%2f${HASH}`],
    ["%2F in the prefix", "/oauth%2Fmcp/callback"],
    ["%2f before the callback", "/oauth/mcp%2fcallback"],
    ["%2f before the document", "/oauth/mcp%2Fclient.json"],
    ["%2f after the document", "/oauth/mcp/client.json%2f"],
    ["a double-encoded slash", "/oauth/mcp/callback%252f"],
    ["an escaped letter", "/oauth/mcp/callb%61ck"],
    ["an escaped dot", "/oauth/mcp/client%2ejson"],
    ["an escaped first letter", "/%6fauth/mcp/callback"],
    ["a backslash", "/oauth/mcp\\callback"],
    ["a dot segment", "/oauth/mcp/./callback"],
    ["a dot-dot segment", "/oauth/mcp/other/../callback"],
  ])("is refused: %s", (_, path) => {
    expect(signInRoute(path)).toEqual({ kind: "refused" });
  });
});

describe("paths that are not the sign-in paths", () => {
  it.each([
    "/",
    "/rpc",
    "/mcp",
    "/oauth",
    "/oauth/mcp",
    "/oauth/mcp/start",
    "/oauth/mcp/starts",
    "/oauth/mcp/callbac",
    "/oauth/other/callback",
    "/sessions/0190f0a8-1b2c-7d3e-8f40-123456789abc/socket",
    "/assets/index-abc.js",
    "/oauth/mcp/start/callback",
    "/x/oauth/mcp/callback",
  ])("%s goes on to the guard", (path) => {
    expect(signInRoute(path)).toBeUndefined();
  });
});

describe("the path of a request's URL", () => {
  it.each([
    ["https://x.workers.dev/oauth/mcp/callback?code=1#f", "/oauth/mcp/callback"],
    ["https://x.workers.dev//oauth/mcp/callback", "//oauth/mcp/callback"],
    ["https://x.workers.dev", ""],
    ["https://x.workers.dev?a=/b", ""],
    ["/oauth/mcp/callback;x?q", "/oauth/mcp/callback;x"],
    ["//oauth/mcp/callback", "//oauth/mcp/callback"],
    ["https://x.workers.dev/oauth/mcp%2fcallback", "/oauth/mcp%2fcallback"],
  ])("%s is %s", (url, path) => {
    expect(rawPathOf(url)).toBe(path);
  });
});

describe("the router ahead of the guarded routes", () => {
  const guarded = vi.fn(() => Effect.succeed(HttpServerResponse.text("guarded")));

  const run = (url: string) =>
    Effect.runPromise(
      serveSignInPaths(Effect.suspend(guarded)).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request(url)),
        ),
      ),
    );

  const origin = "https://cloudpid-server-pr-444.ian-g-pascoe.workers.dev";

  it.each([
    `${origin}/oauth/mcp/client.json`,
    `${origin}/oauth/mcp/callback?code=x&state=y`,
    `${origin}/oauth/mcp/callback/${HASH}`,
    `${origin}/oauth/mcp/Callback`,
    `${origin}//oauth/mcp/callback`,
    `${origin}/oauth/mcp/callback/${HASH}/x`,
    `${origin}/oauth/mcp/callback;x`,
    `${origin}/oauth/mcp%2fcallback`,
  ])("answers a 404, never reaching the guarded routes, for %s", async (url) => {
    guarded.mockClear();

    const response = await run(url);

    expect(response.status).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(guarded).not.toHaveBeenCalled();
  });

  it.each([
    `${origin}/`,
    `${origin}/rpc`,
    `${origin}/oauth/mcp/start?server=x`,
    `${origin}/sessions/0190f0a8-1b2c-7d3e-8f40-123456789abc`,
    `${origin}/assets/index.js`,
  ])("hands %s to the guarded routes", async (url) => {
    guarded.mockClear();

    const response = await run(url);

    expect(response.status).toBe(200);
    expect(guarded).toHaveBeenCalledTimes(1);
  });
});
