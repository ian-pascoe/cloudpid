// docs/architecture/mcp-apps.md → The App sandbox. Which origins the page frames an App View at, what of a declared CSP it keeps,
// and the proxy URL it builds.
import { describe, expect, it } from "vitest";
import { declaredCsp, frameUrl, isSandboxOrigin } from "./frame-url.ts";

const VIEW = "https://aaaaaaaaaaaaaaaaaaaaaaaaaa.ianpascoe.app";

describe("isSandboxOrigin", () => {
  it("accepts a View's host, with or without a stage label, and the local sandbox", () => {
    expect(isSandboxOrigin(VIEW)).toBe(true);
    expect(isSandboxOrigin("https://aaaaaaaaaaaaaaaaaaaaaaaaaa--pr-12.ianpascoe.app")).toBe(true);
    expect(isSandboxOrigin("http://localhost:1338")).toBe(true);
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
      "https://localhost:1338",
      "",
    ]) {
      expect(isSandboxOrigin(origin), origin).toBe(false);
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

    const url = new URL(frameUrl(VIEW, { connectDomains: ["https://api.example"] }, "x"));

    expect(url.origin).toBe(VIEW);
    expect(JSON.parse(url.searchParams.get("csp") ?? "")).toEqual({
      connectDomains: ["https://api.example"],
    });
    expect(url.searchParams.has("host")).toBe(false);
  });

  it("names the page's own origin at the local sandbox only", () => {
    const url = new URL(frameUrl("http://localhost:1338", undefined, "http://localhost:5173"));

    expect(url.searchParams.get("host")).toBe("http://localhost:5173");
  });

  it("leaves out a CSP too long for the Worker to read", () => {
    const url = frameUrl(VIEW, { connectDomains: ["https://a.example/".repeat(1000)] }, "x");

    expect(url).toBe(`${VIEW}/`);
  });

  it("throws for an origin that is not a sandbox's, rather than frame it", () => {
    expect(() => frameUrl("https://evil.example", undefined, "x")).toThrow();
  });
});
