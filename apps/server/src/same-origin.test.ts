import { Effect } from "effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { describe, expect, it } from "vitest";
import { crossOriginProblem, refuseCrossOrigin } from "./same-origin.ts";

const WORKER = ["localhost:1337"];

describe("crossOriginProblem", () => {
  it("admits what the browser calls same-origin", () => {
    expect(crossOriginProblem({ "sec-fetch-site": "same-origin" }, WORKER)).toBeUndefined();
  });

  it.each(["same-site", "cross-site", "none", "", "Same-Origin", "anything"])(
    "refuses Sec-Fetch-Site %j",
    (site) => {
      expect(crossOriginProblem({ "sec-fetch-site": site }, WORKER)).toBe("fetch-site");
    },
  );

  it("lets Sec-Fetch-Site decide over Origin", () => {
    expect(
      crossOriginProblem(
        { "sec-fetch-site": "cross-site", origin: "http://localhost:1337" },
        WORKER,
      ),
    ).toBe("fetch-site");
    expect(
      crossOriginProblem({ "sec-fetch-site": "same-origin", origin: "https://evil.test" }, WORKER),
    ).toBeUndefined();
  });

  it("decides on Origin alone when there is no Sec-Fetch-Site", () => {
    expect(crossOriginProblem({ origin: "http://localhost:1337" }, WORKER)).toBeUndefined();
    expect(crossOriginProblem({ origin: "http://LOCALHOST:1337" }, WORKER)).toBeUndefined();
    expect(crossOriginProblem({ origin: "https://evil.test" }, WORKER)).toBe("origin");
    // The same host on another port, and another host on the same port, are other origins.
    expect(crossOriginProblem({ origin: "http://localhost:5173" }, WORKER)).toBe("origin");
    expect(crossOriginProblem({ origin: "http://evil.test:1337" }, WORKER)).toBe("origin");
    // Not an origin at all.
    expect(crossOriginProblem({ origin: "null" }, WORKER)).toBe("origin");
    expect(crossOriginProblem({ origin: "" }, WORKER)).toBe("origin");
    expect(crossOriginProblem({ origin: "http://localhost:1337, https://evil.test" }, WORKER)).toBe(
      "origin",
    );
    expect(crossOriginProblem({ origin: "http://localhost:1337" }, [])).toBe("origin");
  });

  it("admits a call with neither header: a caller that is no browser", () => {
    expect(crossOriginProblem({}, WORKER)).toBeUndefined();
    expect(crossOriginProblem({ origin: undefined, "sec-fetch-site": undefined }, [])).toBe(
      undefined,
    );
  });
});

const call = (url: string, headers: Record<string, string>) =>
  HttpServerRequest.fromWeb(new Request(url, { method: "POST", headers }));

const refused = (url: string, headers: Record<string, string>) =>
  Effect.runPromise(refuseCrossOrigin(call(url, headers)));

describe("refuseCrossOrigin", () => {
  // Vite proxies `/rpc` with `changeOrigin`: the Worker's Host is the proxy target's, the page's Origin is Vite's.
  it("admits Vite dev: Origin :5173, Host :1337, same-origin", async () => {
    expect(
      await refused("http://localhost:1337/rpc", {
        host: "localhost:1337",
        origin: "http://localhost:5173",
        "sec-fetch-site": "same-origin",
      }),
    ).toBeUndefined();
  });

  it("admits plain alchemy dev, with or without the fetch metadata", async () => {
    const headers = { host: "localhost:1337", origin: "http://localhost:1337" };

    expect(
      await refused("http://localhost:1337/rpc", { ...headers, "sec-fetch-site": "same-origin" }),
    ).toBeUndefined();
    expect(await refused("http://localhost:1337/rpc", headers)).toBeUndefined();
  });

  it("admits a deployed stage's own page", async () => {
    expect(
      await refused("https://pi.ianpascoe.dev/rpc", {
        host: "pi.ianpascoe.dev",
        origin: "https://pi.ianpascoe.dev",
        "sec-fetch-site": "same-origin",
      }),
    ).toBeUndefined();
  });

  it("refuses a website's call to the local Worker with a 403 cross_origin, not cached", async () => {
    for (const site of ["same-site", "cross-site", "none"]) {
      const response = await refused("http://localhost:1337/rpc", {
        host: "localhost:1337",
        origin: "https://evil.test",
        "sec-fetch-site": site,
      });

      expect(response?.status).toBe(403);
      expect(response?.headers["cache-control"]).toBe("no-store");
    }
  });

  it("refuses a foreign Origin where there is no Sec-Fetch-Site", async () => {
    const response = await refused("http://localhost:1337/rpc", {
      host: "localhost:1337",
      origin: "https://evil.test",
    });

    expect(response?.status).toBe(403);
  });
});
