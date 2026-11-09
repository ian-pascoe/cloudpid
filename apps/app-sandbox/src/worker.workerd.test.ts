// @effect-diagnostics preferEffectArray:off preferEffectRecord:off -- assertions over native arrays and records.
// workerd's `cloudflare:test` APIs are Promise-based, so this file is too.
// @effect-diagnostics asyncFunction:off
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildCsp } from "./csp.ts";
import { FIXED_HEADERS } from "./headers.ts";
import { PROXY_JS, proxyPage } from "./proxy.ts";

const HASH = "5zdfpsreiskluv5bvtlks2urnj";
const PROD_ORIGIN = "https://pi.ianpascoe.dev";
const PREVIEW_ORIGIN = "https://cloudpid-server-pr-430.ian-g-pascoe.workers.dev";

const expectFixedHeaders = (response: Response) => {
  for (const [name, value] of Object.entries(FIXED_HEADERS)) {
    expect(response.headers.get(name)).toBe(value);
  }

  expect(response.headers.get("set-cookie")).toBeNull();
};

describe("the App sandbox Worker", () => {
  it("serves prod's proxy page, framed only by prod's app origin", async () => {
    const response = await SELF.fetch(`https://${HASH}.ianpascoe.app/`);
    const csp = response.headers.get("content-security-policy") ?? "";

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(csp).toContain(`frame-ancestors ${PROD_ORIGIN}`);
    expect(csp.match(/frame-ancestors [^;]*/)?.[0]).toBe(`frame-ancestors ${PROD_ORIGIN}`);
    expect(csp).toBe(buildCsp(null, PROD_ORIGIN));
    expect(await response.text()).toBe(proxyPage(PROD_ORIGIN));
    expectFixedHeaders(response);
  });

  it("serves a non-prod stage's proxy page, framed only by that stage's app origin", async () => {
    const response = await SELF.fetch(`https://${HASH}--pr-430.ianpascoe.app/`);
    const csp = response.headers.get("content-security-policy") ?? "";

    expect(response.status).toBe(200);
    expect(csp.match(/frame-ancestors [^;]*/)?.[0]).toBe(`frame-ancestors ${PREVIEW_ORIGIN}`);
    expect(csp).not.toContain(PROD_ORIGIN);
    expect(await response.text()).toBe(proxyPage(PREVIEW_ORIGIN));
    expectFixedHeaders(response);
  });

  it("takes the app origin from the hostname, not from the request's query, headers or cookies", async () => {
    const response = await SELF.fetch(
      `https://${HASH}.ianpascoe.app/?origin=https://evil.example&host=evil.example`,
      {
        headers: {
          origin: "https://evil.example",
          referer: "https://evil.example/",
          "x-forwarded-host": "evil.example",
          cookie: "CF_Authorization=secret",
        },
      },
    );

    const page = await response.text();

    expect(response.headers.get("content-security-policy")).not.toContain("evil.example");
    expect(page).not.toContain("evil.example");
    expect(page).toContain(`content="${PROD_ORIGIN}"`);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("builds the CSP from ?csp=, never naming cloudpid's own hosts", async () => {
    const csp = encodeURIComponent(
      JSON.stringify({
        connectDomains: [
          "https://api.example.com",
          "https://pi.ianpascoe.dev",
          "https://x.ianpascoe.app",
        ],
        resourceDomains: ["https://*.cloudflare.com"],
      }),
    );

    const response = await SELF.fetch(`https://${HASH}.ianpascoe.app/?csp=${csp}`);
    const header = response.headers.get("content-security-policy") ?? "";

    expect(header).toBe(
      buildCsp(
        JSON.stringify({
          connectDomains: ["https://api.example.com"],
          resourceDomains: ["https://*.cloudflare.com"],
        }),
        PROD_ORIGIN,
      ),
    );
    expect(header).toContain("connect-src https://api.example.com;");
    expect(header.replace(/; frame-ancestors .*$/, "")).not.toMatch(/ianpascoe\.(dev|app)/);
  });

  it("serves /proxy.js on a View's host, as plain script with the fixed headers", async () => {
    const response = await SELF.fetch(`https://${HASH}--pr-430.ianpascoe.app/proxy.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await response.text()).toBe(PROXY_JS);
    expectFixedHeaders(response);
  });

  it("answers HEAD like GET, without a body", async () => {
    const response = await SELF.fetch(`https://${HASH}.ianpascoe.app/`, { method: "HEAD" });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors");
    expect(await response.text()).toBe("");
  });

  it.each([
    "https://ianpascoe.app/",
    `https://${HASH.slice(1)}.ianpascoe.app/`,
    `https://${HASH}--.ianpascoe.app/`,
    `https://${HASH}--${"a".repeat(36)}.ianpascoe.app/`,
    `https://x.${HASH}.ianpascoe.app/`,
    "https://sandbox.example/",
  ])("answers 404 for the host that doesn't parse: %s", async (url) => {
    for (const path of ["", "proxy.js"]) {
      const response = await SELF.fetch(`${url}${path}`);

      expect(response.status).toBe(404);
      expect(response.headers.get("content-security-policy")).toBeNull();
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(await response.text()).toBe("Not found");
      expectFixedHeaders(response);
    }
  });

  it.each(["/sandbox.html", "/PROXY.JS", "/proxy.js/x"])(
    "answers 404 for %s on a View's host",
    async (path) => {
      const response = await SELF.fetch(`https://${HASH}.ianpascoe.app${path}`);

      expect(response.status).toBe(404);
      expectFixedHeaders(response);
    },
  );

  it.each(["POST", "DELETE"])("answers 405 to %s on a View's host", async (method) => {
    const response = await SELF.fetch(`https://${HASH}.ianpascoe.app/`, { method, body: "x" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    expectFixedHeaders(response);
  });

  it("answers a method it refuses with 404 on a host that doesn't parse", async () => {
    const response = await SELF.fetch("https://ianpascoe.app/", { method: "POST", body: "x" });

    expect(response.status).toBe(404);
  });
});
