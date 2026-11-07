import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { describe, expect, it } from "vitest";
import { crossOriginReason, serveOwnerCalls } from "./same-origin.ts";

const WORKER = ["localhost:1337"];

describe("crossOriginReason", () => {
  it("admits what the browser calls same-origin", () => {
    expect(crossOriginReason({ "sec-fetch-site": "same-origin" }, WORKER)).toBeUndefined();
  });

  it.each(["same-site", "cross-site", "none", "", "Same-Origin", "anything"])(
    "refuses Sec-Fetch-Site %j",
    (site) => {
      expect(crossOriginReason({ "sec-fetch-site": site }, WORKER)).toBe("fetch-site");
    },
  );

  it("lets Sec-Fetch-Site decide over Origin", () => {
    expect(
      crossOriginReason(
        { "sec-fetch-site": "cross-site", origin: "http://localhost:1337" },
        WORKER,
      ),
    ).toBe("fetch-site");
    expect(
      crossOriginReason({ "sec-fetch-site": "same-origin", origin: "https://evil.test" }, WORKER),
    ).toBeUndefined();
  });

  it("decides on Origin alone when there is no Sec-Fetch-Site", () => {
    expect(crossOriginReason({ origin: "http://localhost:1337" }, WORKER)).toBeUndefined();
    expect(crossOriginReason({ origin: "http://LOCALHOST:1337" }, WORKER)).toBeUndefined();
    expect(crossOriginReason({ origin: "https://evil.test" }, WORKER)).toBe("origin");
    // The same host on another port, and another host on the same port, are other origins.
    expect(crossOriginReason({ origin: "http://localhost:5173" }, WORKER)).toBe("origin");
    expect(crossOriginReason({ origin: "http://evil.test:1337" }, WORKER)).toBe("origin");
    // Not an origin at all.
    expect(crossOriginReason({ origin: "null" }, WORKER)).toBe("origin");
    expect(crossOriginReason({ origin: "" }, WORKER)).toBe("origin");
    expect(crossOriginReason({ origin: "http://localhost:1337, https://evil.test" }, WORKER)).toBe(
      "origin",
    );
    expect(crossOriginReason({ origin: "http://localhost:1337" }, [])).toBe("origin");
  });

  it("admits a call with neither header: a caller that is no browser", () => {
    expect(crossOriginReason({}, WORKER)).toBeUndefined();
    expect(crossOriginReason({ origin: undefined, "sec-fetch-site": undefined }, [])).toBe(
      undefined,
    );
  });
});

const session = "0190f0a8-1b2c-7d3e-8f40-123456789abc";

const answer = (label: string) => HttpServerResponse.text("", { headers: { "x-branch": label } });

// What a call gets: the branch it reached (`socket:<id>`, `rpc`), the refusal, or `undefined` for a request for neither.
const route = (method: string, url: string, headers: Record<string, string>) =>
  serveOwnerCalls({
    socket: (id) => Effect.succeed(answer(`socket:${id}`)),
    rpc: () => Effect.succeed(answer("rpc")),
  }).pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(url, { method, headers })),
    ),
    Effect.map((response) =>
      response === undefined
        ? undefined
        : response.status === 403
          ? { status: 403, cache: response.headers["cache-control"] }
          : { reached: response.headers["x-branch"] },
    ),
  );

const rpc = (headers: Record<string, string>) =>
  route("POST", "http://localhost:1337/rpc", headers);

const socket = (headers: Record<string, string>) =>
  route("GET", `http://localhost:1337/sessions/${session}/socket`, {
    upgrade: "websocket",
    ...headers,
  });

const reachedRpc = { reached: "rpc" };
const reachedSocket = { reached: `socket:${session}` };

const refusedOutright = { status: 403, cache: "no-store" };

describe("serveOwnerCalls", () => {
  // Vite proxies `/rpc` with `changeOrigin`: the Worker's Host is the proxy target's, the page's Origin is Vite's.
  it("admits Vite dev's /rpc: Origin :5173, Host :1337, same-origin", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const headers = {
          host: "localhost:1337",
          origin: "http://localhost:5173",
          "sec-fetch-site": "same-origin",
        };

        expect(yield* rpc(headers)).toEqual(reachedRpc);
      }),
    ));

  it("admits plain alchemy dev, with or without the fetch metadata", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const headers = { host: "localhost:1337", origin: "http://localhost:1337" };

        expect(yield* rpc({ ...headers, "sec-fetch-site": "same-origin" })).toEqual(reachedRpc);
        expect(yield* rpc(headers)).toEqual(reachedRpc);
        expect(yield* socket(headers)).toEqual(reachedSocket);
      }),
    ));

  it("admits a call with neither header", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(yield* rpc({})).toEqual(reachedRpc);
        expect(yield* socket({})).toEqual(reachedSocket);
      }),
    ));

  it("refuses a website's call to /rpc with a 403 cross_origin, not cached", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (const site of ["same-site", "cross-site", "none"]) {
          expect(
            yield* rpc({
              host: "localhost:1337",
              origin: "https://evil.test",
              "sec-fetch-site": site,
            }),
          ).toEqual(refusedOutright);
        }

        expect(yield* rpc({ host: "localhost:1337", origin: "https://evil.test" })).toEqual(
          refusedOutright,
        );
      }),
    ));

  it("holds the Session socket upgrade to the same rule", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        expect(
          yield* socket({
            host: "localhost:1337",
            origin: "https://evil.test",
            "sec-fetch-site": "cross-site",
          }),
        ).toEqual(refusedOutright);
        expect(yield* socket({ host: "localhost:1337", origin: "https://evil.test" })).toEqual(
          refusedOutright,
        );
        // The socket proxy of Vite keeps the Host, so the page's Origin names it.
        expect(yield* socket({ host: "localhost:5173", origin: "http://localhost:5173" })).toEqual(
          reachedSocket,
        );
      }),
    ));

  it("leaves every other request alone, whatever its headers", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const foreign = { origin: "https://evil.test", "sec-fetch-site": "cross-site" };

        expect(yield* route("GET", "http://localhost:1337/rpc", foreign)).toBeUndefined();
        expect(yield* route("GET", "http://localhost:1337/", foreign)).toBeUndefined();
        expect(
          yield* route(
            "PUT",
            `http://localhost:1337/sessions/${session}/attachments/a.png`,
            foreign,
          ),
        ).toBeUndefined();
      }),
    ));
});
