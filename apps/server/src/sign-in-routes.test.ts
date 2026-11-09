// @effect-diagnostics asyncFunction:off missedPipeableOpportunity:off
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Predicate from "effect/Predicate";
import { describe, expect, it, vi } from "vitest";
import { guardedRoutes, rawPathOf, serveSignInPaths, signInRoute } from "./sign-in-routes.ts";

const HASH = "aB3_-9xYz012";

describe("the exact public paths", () => {
  it("are the client document, the callback, and the callback below one 12-character hash", () => {
    expect(signInRoute("/oauth/mcp/client.json")).toEqual({ kind: "client-document" });
    expect(signInRoute("/oauth/mcp/callback")).toEqual({ kind: "callback", hash: undefined });
    expect(signInRoute(`/oauth/mcp/callback/${HASH}`)).toEqual({ kind: "callback", hash: HASH });
  });
});

describe("every other form of them", () => {
  it.each([
    ["capitalisation of the prefix", "/OAuth/mcp/callback"],
    ["a doubled leading slash", "//oauth/mcp/callback"],
    ["a trailing slash on the callback", "/oauth/mcp/callback/"],
    ["a sub-path of the callback", `/oauth/mcp/callback/${HASH}/x`],
    ["a hash that is too short", "/oauth/mcp/callback/aB3_-9xYz01"],
    ["a `;` after the callback", "/oauth/mcp/callback;x"],
    ["%2f before the hash", `/oauth/mcp/callback%2f${HASH}`],
    ["an escaped letter", "/oauth/mcp/callb%61ck"],
    ["a backslash", "/oauth/mcp\\callback"],
    ["a dot segment", "/oauth/mcp/./callback"],
  ])("is refused: %s", (_, path) => {
    expect(signInRoute(path)).toEqual({ kind: "refused" });
  });
});

describe("paths that are not the sign-in paths", () => {
  it.each(["/", "/oauth/mcp/start", "/oauth/mcp/callbac", "/x/oauth/mcp/callback"])(
    "%s goes on to the guard",
    (path) => {
      expect(signInRoute(path)).toBeUndefined();
    },
  );
});

describe("the path of a request's URL", () => {
  it.each([
    ["https://x.workers.dev/oauth/mcp/callback?code=1#f", "/oauth/mcp/callback"],
    ["https://x.workers.dev//oauth/mcp/callback", "//oauth/mcp/callback"],
    ["https://x.workers.dev", ""],
  ])("%s is %s", (url, path) => {
    expect(rawPathOf(url)).toBe(path);
  });
});

/** What serves the two exact paths: each answers with what it was given, so a test sees which one ran. */
const handlers = {
  clientDocument: Effect.succeed(HttpServerResponse.text("document")),
  callback: (path: string) => Effect.succeed(HttpServerResponse.text(`callback ${path}`)),
};

const bodyOf = (response: HttpServerResponse.HttpServerResponse): string =>
  Predicate.isTagged(response.body, "Uint8Array")
    ? new TextDecoder().decode(response.body.body)
    : "";

describe("the router ahead of the guarded routes", () => {
  const guarded = vi.fn(() => Effect.succeed(HttpServerResponse.text("guarded")));

  const run = (url: string) =>
    Effect.runPromise(
      serveSignInPaths(handlers)(Effect.suspend(guarded)).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request(url)),
        ),
      ),
    );

  const origin = "https://cloudpid-server-pr-444.ian-g-pascoe.workers.dev";

  it.each([
    [`${origin}/oauth/mcp/client.json`, "document"],
    [`${origin}/oauth/mcp/callback/${HASH}`, `callback /oauth/mcp/callback/${HASH}`],
  ])("hands %s to its handler, never to the guarded routes", async (url, answer) => {
    guarded.mockClear();

    const response = await run(url);

    expect(response.status).toBe(200);
    expect(bodyOf(response)).toBe(answer);
    expect(guarded).not.toHaveBeenCalled();
  });

  it.each([`${origin}/oauth/mcp/Callback`, `${origin}//oauth/mcp/callback`])(
    "answers a 404, never reaching the guarded routes, for %s",
    async (url) => {
      guarded.mockClear();

      const response = await run(url);

      expect(response.status).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(guarded).not.toHaveBeenCalled();
    },
  );

  it.each([`${origin}/`, `${origin}/oauth/mcp/start?server=x`])(
    "hands %s to the guarded routes",
    async (url) => {
      guarded.mockClear();

      const response = await run(url);

      expect(response.status).toBe(200);
      expect(guarded).toHaveBeenCalledTimes(1);
    },
  );
});

describe("the composition the Worker serves with", () => {
  // The Access guard's own answer to a request without an assertion is a 403; the router's is a 404. So which one a
  // request gets says which came first.
  const inner = vi.fn(() => Effect.succeed(HttpServerResponse.text("inside")));

  const run = (url: string, guard: Parameters<typeof guardedRoutes>[0]) =>
    Effect.runPromise(
      guardedRoutes(
        guard,
        handlers,
      )(Effect.suspend(inner)).pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(new Request(url, { headers: { host: new URL(url).host } })),
        ),
      ),
    );

  const deployed = {
    audience: "a".repeat(64),
    localMode: false,
    keys: () => Promise.resolve(undefined),
  };

  const origin = "https://cloudpid-server-pr-444.ian-g-pascoe.workers.dev";

  it.each(["/OAUTH/MCP/CLIENT.JSON", "/oauth/mcp%2fcallback"])(
    "answers %s with the router's 404, before the guard's 403, and runs no route",
    async (path) => {
      inner.mockClear();

      const response = await run(`${origin}${path}`, deployed);

      expect(response.status).toBe(404);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(inner).not.toHaveBeenCalled();
    },
  );

  it.each(["/oauth/mcp/client.json", `/oauth/mcp/callback/${HASH}`])(
    "serves %s to its handler with no assertion at all, never reading identity",
    async (path) => {
      inner.mockClear();

      const response = await run(`${origin}${path}`, deployed);

      expect(response.status).toBe(200);
      expect(bodyOf(response)).toMatch(/^(document|callback )/);
      expect(inner).not.toHaveBeenCalled();
    },
  );

  it.each(["/rpc", "/oauth/mcp/start"])(
    "still gives %s to the guard, which refuses a request with no assertion",
    async (path) => {
      inner.mockClear();

      const response = await run(`${origin}${path}`, deployed);

      expect(response.status).toBe(403);
      expect(inner).not.toHaveBeenCalled();
    },
  );

  it("runs the routes behind the guard for a request it admits", async () => {
    inner.mockClear();

    const response = await run("http://localhost:1337/", {
      audience: undefined,
      localMode: true,
      keys: deployed.keys,
    });

    expect(response.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
  });
});
