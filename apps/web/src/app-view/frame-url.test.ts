// docs/architecture/mcp-apps.md → The App sandbox. Which origins the page frames an App View at, what of a declared CSP it keeps,
// and the proxy URL it builds.
import { describe, expect, it } from "vitest";
import {
  LOCAL_APP_ORIGINS as SERVER_LOCAL_APP_ORIGINS,
  LOCAL_SANDBOX_ORIGIN as SERVER_LOCAL_ORIGIN,
  viewHost,
} from "../../../server/src/view-host.ts";
import {
  APP_DOMAIN,
  LOCAL_APP_ORIGINS,
  LOCAL_SANDBOX_ORIGIN,
  declaredCsp,
  frameUrl,
  isSandboxOrigin,
} from "./frame-url.ts";

const VIEW = "https://aaaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app";
const PROD_PAGE = "https://pi.ianpascoe.dev";

describe("isSandboxOrigin", () => {
  it("accepts a View's host, with or without a stage label, and the local sandbox", () => {
    expect(isSandboxOrigin(VIEW, PROD_PAGE)).toBe(true);
    expect(
      isSandboxOrigin("https://aaaaaaaaaaaaaaaaaaaaaaaaaa--pr-12.ianpascoe.app", PROD_PAGE),
    ).toBe(true);
  });

  it("accepts the local sandbox only for a page at a local app origin, whatever the build", () => {
    // `alchemy dev` serves a production build at :1337 and Vite serves the page at :5173.
    expect(isSandboxOrigin(LOCAL_SANDBOX_ORIGIN, "http://localhost:1337")).toBe(true);
    expect(isSandboxOrigin(LOCAL_SANDBOX_ORIGIN, "http://localhost:5173")).toBe(true);
    // A deployed page never frames a loopback address, nor does any page at another port or host.
    expect(isSandboxOrigin(LOCAL_SANDBOX_ORIGIN, PROD_PAGE)).toBe(false);
    expect(
      isSandboxOrigin(
        LOCAL_SANDBOX_ORIGIN,
        "https://cloudpid-server-pr-1.ian-g-pascoe.workers.dev",
      ),
    ).toBe(false);
    expect(isSandboxOrigin(LOCAL_SANDBOX_ORIGIN, "http://localhost:3000")).toBe(false);
    expect(isSandboxOrigin(LOCAL_SANDBOX_ORIGIN, "http://127.0.0.1:1337")).toBe(false);
    expect(isSandboxOrigin(LOCAL_SANDBOX_ORIGIN, "")).toBe(false);
  });

  it("refuses anything else: another domain, a path, a port, a lookalike, a short hash", () => {
    for (const origin of [
      "https://evil.example",
      `${VIEW}/x`,
      `${VIEW}:8443`,
      "https://aaaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app.evil.example",
      "https://evil.aaaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app",
      "https://aaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app",
      "https://AAAAAAAAAAAAAAAAAAAAAAAAAA.ianpascoe.app",
      "http://aaaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app",
      "http://localhost:1337",
      // The old local sandbox origin shared the app's cookie jar.
      "http://localhost:1338",
      "https://127.0.0.1:1338",
      "",
    ]) {
      expect(isSandboxOrigin(origin, "http://localhost:1337"), origin).toBe(false);
    }
  });
});

describe("declaredCsp", () => {
  it("keeps the four lists of strings and nothing else", () => {
    expect(
      declaredCsp({
        connectDomains: ["https://api.example"],
        resourceDomains: [],
        frameDomains: ["https://embed.example"],
        script: "unsafe-inline",
      }),
    ).toEqual({ connectDomains: ["https://api.example"], frameDomains: ["https://embed.example"] });
  });

  it("is undefined for none, an empty one, or one that is not lists of strings", () => {
    expect(declaredCsp(undefined)).toBeUndefined();
    expect(declaredCsp({})).toBeUndefined();
    expect(declaredCsp({ connectDomains: [] })).toBeUndefined();
    expect(declaredCsp({ connectDomains: "https://api.example" })).toBeUndefined();
    expect(declaredCsp({ connectDomains: [1] })).toBeUndefined();
    expect(declaredCsp("default-src *")).toBeUndefined();
  });
});

describe("frameUrl", () => {
  it("is the origin's root, carrying the declared CSP as JSON", () => {
    expect(frameUrl(VIEW, undefined, "https://app.example")).toBe(`${VIEW}/`);

    const url = new URL(frameUrl(VIEW, { connectDomains: ["https://api.example"] }, PROD_PAGE));

    expect(url.origin).toBe(VIEW);
    expect(JSON.parse(url.searchParams.get("csp") ?? "")).toEqual({
      connectDomains: ["https://api.example"],
    });
    expect(url.searchParams.has("host")).toBe(false);
  });

  it("names the page's own origin at the local sandbox only", () => {
    const url = new URL(frameUrl("http://127.0.0.1:1338", undefined, "http://localhost:5173"));

    expect(url.searchParams.get("host")).toBe("http://localhost:5173");
  });

  it("frames the local sandbox from a page at :1337 (the Worker's build) as at :5173, and from no deployed page", () => {
    for (const page of ["http://localhost:1337", "http://localhost:5173"]) {
      expect(
        new URL(frameUrl(LOCAL_SANDBOX_ORIGIN, undefined, page)).searchParams.get("host"),
      ).toBe(page);
    }

    expect(() => frameUrl(LOCAL_SANDBOX_ORIGIN, undefined, "https://pi.ianpascoe.dev")).toThrow();
  });

  it("leaves out a CSP too long for the Worker to read", () => {
    const url = frameUrl(VIEW, { connectDomains: ["https://a.example/".repeat(1000)] }, "x");

    expect(url).toBe(`${VIEW}/`);
  });

  it("throws for an origin that is not a sandbox's, rather than frame it", () => {
    expect(() => frameUrl("https://evil.example", undefined, "x")).toThrow();
  });
});

describe("the copies of the server's sandbox constants", () => {
  // The page does not depend on the server's package, so it keeps its own copies; these hold them to the server's.
  it("name the same local origin, local app origins and domain", () => {
    expect(LOCAL_SANDBOX_ORIGIN).toBe(SERVER_LOCAL_ORIGIN);
    expect(LOCAL_APP_ORIGINS).toEqual(SERVER_LOCAL_APP_ORIGINS);
    expect(viewHost("a".repeat(26), "prod")).toBe(`${"a".repeat(26)}.${APP_DOMAIN}`);
  });

  it("accept every origin the server builds for a View, on prod and on any stage", () => {
    for (const stage of ["prod", "pr-12", "dev_ian", "preview-with-a-longer-label"]) {
      expect(isSandboxOrigin(`https://${viewHost("a".repeat(26), stage)}`, PROD_PAGE), stage).toBe(
        true,
      );
    }
  });
});
