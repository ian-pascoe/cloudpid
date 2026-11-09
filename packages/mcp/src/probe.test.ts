/**
 * Golden tests of the era probe's outcomes (`docs/architecture/mcp.md` → Protocol eras; The MCP core #394 D2): what
 * `connect` fails with when the server answers `server/discover` with each row of the outcome table, through the SDK's
 * own classifier and the core's `fetch` tap.
 */
// @effect-diagnostics asyncFunction:off preferEffectArray:off
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordingClock, run, TARGET, testDeps, failedWith } from "./core.fixture.ts";
import {
  type FakeServer,
  fetchTo,
  hostileServer,
  legacyStatelessServer,
  modernServer,
  rpcMethods,
} from "./fakes.fixture.ts";
import {
  ProtocolViolation,
  ServerError,
  SignInRequired,
  StepUpRequired,
  TimedOut,
  Unreachable,
  Unsupported,
} from "./types.ts";
import { connect, type McpDeps } from "./index.ts";

/** A Modern server that answers its first `limit` probes with `answer`. */
const probeAnswered = (answer: () => Response, limit = Number.POSITIVE_INFINITY) => {
  let answered = 0;

  return hostileServer(modernServer(), (_request, rpc) => {
    if (rpc?.method !== "server/discover" || answered >= limit) {
      return undefined;
    }

    answered += 1;

    return answer();
  });
};

/** How `connect` ends: the era it connected in, or the error it failed with. */
const outcome = (deps: McpDeps, clock = recordingClock().clock) =>
  run(
    connect(TARGET, deps).pipe(
      Effect.map((connection) => ({ connected: connection.era })),
      Effect.catch((error) => Effect.succeed({ failed: error })),
    ),
    clock,
  );

const probes = (server: FakeServer) =>
  rpcMethods(server).filter((method) => method === "server/discover").length;

/** The URL paths of the requests that reached `server`. */
const paths = (server: FakeServer) =>
  server.received.map((received) => new URL(received.url).pathname);

afterEach(() => {
  vi.useRealTimers();
});

describe("the probe's outcome table", () => {
  it("401 when the auth hook has no token: sign-in required, asked once", async () => {
    const server = probeAnswered(() => new Response("Unauthorized", { status: 401 }));
    const asked: Array<boolean> = [];

    const deps = testDeps(fetchTo(server), {
      auth: (stale) =>
        Effect.sync(() => {
          asked.push(stale);

          return undefined;
        }),
    });

    expect(await outcome(deps)).toEqual(failedWith(SignInRequired, { rejected: false }));
    expect(probes(server)).toBe(1);
    expect(asked).toEqual([false]);
  });

  it("401 to a token, twice: the token is asked again with stale, then rejected", async () => {
    const server = probeAnswered(() => new Response("Unauthorized", { status: 401 }));
    const asked: Array<boolean> = [];

    const deps = testDeps(fetchTo(server), {
      auth: (stale) =>
        Effect.sync(() => {
          asked.push(stale);

          return stale ? "fresh-token" : "old-token";
        }),
    });

    expect(await outcome(deps)).toEqual(failedWith(SignInRequired, { rejected: true }));
    expect(asked).toEqual([false, true]);
    expect(server.received.map((received) => received.headers.get("authorization"))).toEqual([
      "Bearer old-token",
      "Bearer fresh-token",
    ]);
  });

  it("401 to a stale token, then 200 to a fresh one: connected", async () => {
    const server = probeAnswered(() => new Response("Unauthorized", { status: 401 }), 1);

    const deps = testDeps(fetchTo(server), {
      auth: (stale) => Effect.succeed(stale ? "fresh-token" : "old-token"),
    });

    expect(await outcome(deps)).toEqual({ connected: "modern" });
  });

  it("403 insufficient_scope: the step-up carries the challenge's parameters", async () => {
    const server = probeAnswered(
      () =>
        new Response("Forbidden", {
          status: 403,
          headers: {
            "www-authenticate":
              'Bearer error="insufficient_scope", scope="files:write", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", error_description="More scope"',
          },
        }),
    );

    expect(await outcome(testDeps(fetchTo(server)))).toEqual(
      failedWith(StepUpRequired, {
        scope: "files:write",
        challenge: {
          resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
          scope: "files:write",
          error: "insufficient_scope",
          errorDescription: "More scope",
        },
      }),
    );
  });

  it("401: the failure carries the challenge's parameters, with or without a token sent", async () => {
    const header =
      'Bearer error="invalid_token", error_description="expired", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"';

    const challenge = {
      resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
      error: "invalid_token",
      errorDescription: "expired",
    };

    const unauthorized = () =>
      new Response("Unauthorized", { status: 401, headers: { "www-authenticate": header } });

    expect(await outcome(testDeps(fetchTo(probeAnswered(unauthorized))))).toEqual(
      failedWith(SignInRequired, { rejected: false, challenge }),
    );

    const rejected = testDeps(fetchTo(probeAnswered(unauthorized)), {
      auth: (stale) => Effect.succeed(stale ? "fresh-token" : "old-token"),
    });

    expect(await outcome(rejected)).toEqual(
      failedWith(SignInRequired, { rejected: true, challenge }),
    );
  });

  it("any other 403: failed", async () => {
    const server = probeAnswered(() => new Response("Forbidden", { status: 403 }));

    expect(await outcome(testDeps(fetchTo(server)))).toEqual(
      failedWith(ServerError, { status: 403 }),
    );
  });

  it.each([408, 429])(
    "%i, then an answer: retried once after Retry-After, connected",
    async (status) => {
      const server = probeAnswered(
        () => new Response(null, { status, headers: { "retry-after": "3" } }),
        1,
      );

      const { clock, slept } = recordingClock();

      expect(await outcome(testDeps(fetchTo(server)), clock)).toEqual({ connected: "modern" });
      expect(probes(server)).toBe(2);
      expect(slept).toEqual([3000]);
    },
  );

  it.each([408, 429])("%i twice: unavailable, never Legacy, after at most 10 s", async (status) => {
    const server = probeAnswered(
      () => new Response(null, { status, headers: { "retry-after": "120" } }),
    );

    const { clock, slept } = recordingClock();

    expect(await outcome(testDeps(fetchTo(server)), clock)).toEqual(
      failedWith(Unreachable, { status }),
    );
    expect(probes(server)).toBe(2);
    expect(rpcMethods(server)).not.toContain("initialize");
    expect(slept).toEqual([10_000]);
  });

  it("429 with an HTTP-date Retry-After: retried when it names", async () => {
    const at = DateTime.toDateUtc(
      DateTime.makeUnsafe(Effect.runSync(Clock.currentTimeMillis) + 6_000),
    ).toUTCString();

    const server = probeAnswered(
      () => new Response(null, { status: 429, headers: { "retry-after": at } }),
      1,
    );

    const { clock, slept } = recordingClock();

    expect(await outcome(testDeps(fetchTo(server)), clock)).toEqual({ connected: "modern" });
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(4_000);
    expect(slept[0]).toBeLessThanOrEqual(6_000);
  });

  it("429 with no Retry-After: retried after 1 s", async () => {
    const server = probeAnswered(() => new Response(null, { status: 429 }), 1);
    const { clock, slept } = recordingClock();

    expect(await outcome(testDeps(fetchTo(server)), clock)).toEqual({ connected: "modern" });
    expect(slept).toEqual([1000]);
  });

  it.each([500, 502, 503])("%i: unavailable, not retried", async (status) => {
    const server = probeAnswered(() => new Response("Down", { status }));

    expect(await outcome(testDeps(fetchTo(server)))).toEqual(failedWith(Unreachable, { status }));
    expect(probes(server)).toBe(1);
    expect(rpcMethods(server)).not.toContain("initialize");
  });

  it("a network error: unavailable", async () => {
    const deps = testDeps(async () => {
      throw new TypeError("fetch failed");
    });

    expect(await outcome(deps)).toEqual(failedWith(Unreachable));
  });

  it("a redirect to another origin: failed, and not followed", async () => {
    const server = probeAnswered(
      () =>
        new Response(null, { status: 302, headers: { location: "https://elsewhere.test/mcp" } }),
    );

    expect(await outcome(testDeps(fetchTo(server)))).toEqual(
      failedWith(ServerError, { status: 302 }),
    );
    expect(server.received.map((received) => received.headers.get("host"))).toHaveLength(1);
  });

  it("a redirect within the origin: followed", async () => {
    const modern = modernServer();

    const server = hostileServer(modern, (request) =>
      new URL(request.url).pathname === "/mcp"
        ? new Response(null, { status: 307, headers: { location: "/mcp/" } })
        : undefined,
    );

    expect(await outcome(testDeps(fetchTo(server)))).toEqual({ connected: "modern" });
    expect(paths(server)).toContain("/mcp/");
  });

  it("a redirect within the origin while a token is in play: not followed", async () => {
    const server = hostileServer(modernServer(), (request) =>
      new URL(request.url).pathname === "/mcp"
        ? new Response(null, { status: 307, headers: { location: "/mcp/" } })
        : undefined,
    );

    const deps = testDeps(fetchTo(server), { auth: () => Effect.succeed("token") });

    expect(await outcome(deps)).toEqual(failedWith(ServerError, { status: 307 }));
    expect(new Set(paths(server))).toEqual(new Set(["/mcp"]));
  });

  it.each([
    ["HTML", () => new Response("<html></html>", { headers: { "content-type": "text/html" } })],
    ["JSON that is not JSON-RPC", () => Response.json({ hello: "world" })],
    [
      "a body that is not JSON",
      () => new Response("{", { headers: { "content-type": "application/json" } }),
    ],
  ])("a 2xx of %s: not an MCP server", async (_name, answer) => {
    const server = probeAnswered(answer);

    expect(await outcome(testDeps(fetchTo(server)))).toEqual(failedWith(ProtocolViolation));
    expect(rpcMethods(server)).not.toContain("initialize");
  });

  it.each([
    ["202", () => new Response(null, { status: 202 })],
    [
      "an empty stream",
      () => new Response("", { headers: { "content-type": "text/event-stream" } }),
    ],
  ])("%s: the probe's 15 s timeout", async (_name, answer) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const server = probeAnswered(answer);
    const ended = outcome(testDeps(fetchTo(server)));

    await vi.advanceTimersByTimeAsync(14_000);
    expect(probes(server)).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await ended).toEqual(failedWith(TimedOut));
    expect(rpcMethods(server)).not.toContain("initialize");
  });

  it("a JSON-RPC error: Legacy, by the SDK's classifier", async () => {
    const server = legacyStatelessServer();

    expect(await outcome(testDeps(fetchTo(server)))).toEqual({ connected: "legacy" });
  });

  it("no common version: unsupported, naming what the server supports", async () => {
    const server = probeAnswered(() =>
      Response.json({
        jsonrpc: "2.0",
        id: "server-discover-probe-1",
        result: { supportedVersions: ["2027-01-01"], capabilities: {} },
      }),
    );

    expect(await outcome(testDeps(fetchTo(server)))).toEqual(failedWith(Unsupported));
  });
});
