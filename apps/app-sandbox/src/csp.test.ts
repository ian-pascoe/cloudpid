// @effect-diagnostics preferEffectArray:off preferEffectRecord:off -- assertions over native arrays and records.
import {
  VISUAL_CSP,
  VISUAL_SANDBOX_DIRECTIVE,
  visualCheckPolicy,
} from "@cloudpid/protocol/visuals";
import { describe, expect, it } from "vitest";
import { buildCsp } from "./csp.ts";

const ANCESTOR = "https://pi.ianpascoe.dev";

interface Declaration {
  readonly connectDomains?: readonly string[];
  readonly resourceDomains?: readonly string[];
  readonly frameDomains?: readonly string[];
  readonly baseUriDomains?: readonly string[];
}

const declare = (csp: Declaration): string => buildCsp(JSON.stringify(csp), ANCESTOR);

/** The sources of one directive, or `undefined` when the policy has none. */
const directive = (policy: string, name: string): string[] | undefined => {
  const found = policy.split("; ").find((part) => part.startsWith(`${name} `));

  return found?.slice(name.length + 1).split(" ");
};

describe("buildCsp", () => {
  it("without a declaration allows only inline script and style, data: images and /proxy.js", () => {
    expect(buildCsp(null, ANCESTOR)).toBe(
      [
        "default-src 'none'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        "img-src data:",
        "connect-src 'none'",
        "frame-src 'none'",
        "base-uri 'none'",
        "object-src 'none'",
        "form-action 'none'",
        `frame-ancestors ${ANCESTOR}`,
      ].join("; "),
    );
  });

  it("allows exactly the declared domains, each in the directives the spec names", () => {
    const policy = declare({
      connectDomains: ["https://api.weather.com", "wss://realtime.service.com"],
      resourceDomains: ["https://cdn.jsdelivr.net", "https://*.cloudflare.com"],
      frameDomains: ["https://www.youtube.com"],
      baseUriDomains: ["https://base.example.com"],
    });

    const resources = ["https://cdn.jsdelivr.net", "https://*.cloudflare.com"];

    expect(directive(policy, "script-src")).toEqual(["'self'", "'unsafe-inline'", ...resources]);
    expect(directive(policy, "style-src")).toEqual(["'unsafe-inline'", ...resources]);
    expect(directive(policy, "img-src")).toEqual(["data:", ...resources]);
    expect(directive(policy, "font-src")).toEqual(resources);
    expect(directive(policy, "media-src")).toEqual(resources);
    expect(directive(policy, "connect-src")).toEqual([
      "https://api.weather.com",
      "wss://realtime.service.com",
    ]);
    expect(directive(policy, "frame-src")).toEqual(["https://www.youtube.com"]);
    expect(directive(policy, "base-uri")).toEqual(["https://base.example.com"]);
  });

  it("is never looser than the declaration: no source it didn't name", () => {
    const policy = declare({ connectDomains: ["https://api.example.com"] });

    expect(policy).not.toMatch(/unsafe-eval|blob:|\*(?!\.)|https:(?!\/\/)|wss:(?!\/\/)|http:/);
    expect(directive(policy, "connect-src")).toEqual(["https://api.example.com"]);
    expect(directive(policy, "script-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("form-action 'none'");
  });

  it("reads a policy that isn't usable as none: never as looser", () => {
    const empty = buildCsp(null, ANCESTOR);

    expect(buildCsp("", ANCESTOR)).toBe(empty);
    expect(buildCsp("not json", ANCESTOR)).toBe(empty);
    expect(buildCsp("[]", ANCESTOR)).toBe(empty);
    expect(buildCsp('{"connectDomains":"https://a.example.com"}', ANCESTOR)).toBe(empty);
    expect(buildCsp('{"connectDomains":[1]}', ANCESTOR)).toBe(empty);
    expect(
      buildCsp(`{"connectDomains":["https://a.example.com"],"x":"${"y".repeat(9000)}"}`, ANCESTOR),
    ).toBe(empty);
  });

  it.each([
    "https://pi.ianpascoe.dev",
    "https://ianpascoe.dev",
    "https://model-proxy.ianpascoe.dev",
    "https://deep.pi.ianpascoe.dev",
    "https://PI.IANPASCOE.DEV",
    "https://pi.ianpascoe.dev:443",
    "https://pi.ianpascoe.dev/path",
    "wss://pi.ianpascoe.dev",
    "https://ianpascoe.app",
    "https://x.ianpascoe.app",
    `https://${"a".repeat(26)}--pr-1.ianpascoe.app`,
    "https://cloudpid-server-pr-430.ian-g-pascoe.workers.dev",
    "https://cloudpid-server-dev-ian.ian-g-pascoe.workers.dev",
    "https://abcd1234-cloudpid-server-pr-430.ian-g-pascoe.workers.dev",
    "https://*.ianpascoe.dev",
    "https://*.pi.ianpascoe.dev",
    "https://*.ianpascoe.app",
    "https://*.ian-g-pascoe.workers.dev",
    "https://*.workers.dev",
    "https://*.dev",
    "https://*.app",
    "https://*.cloudpid-server-pr-1.ian-g-pascoe.workers.dev",
  ])("drops cloudpid's own host %s from every list", (domain) => {
    const policy = declare({
      connectDomains: [domain, "https://ok.example.com"],
      resourceDomains: [domain, "https://ok.example.com"],
      frameDomains: [domain, "https://ok.example.com"],
      baseUriDomains: [domain, "https://ok.example.com"],
    });

    // Everything but `frame-ancestors`, which is the stage's own app origin.
    expect(policy.replace(/; frame-ancestors .*$/, "")).not.toMatch(
      /ianpascoe|cloudpid|workers\.dev|\*\.(dev|app)/i,
    );
    expect(directive(policy, "connect-src")).toEqual(["https://ok.example.com"]);
    expect(directive(policy, "frame-src")).toEqual(["https://ok.example.com"]);
    expect(directive(policy, "base-uri")).toEqual(["https://ok.example.com"]);
    expect(directive(policy, "img-src")).toEqual(["data:", "https://ok.example.com"]);
  });

  it.each([
    "https://example.com",
    "https://ianpascoe.com",
    "https://ianpascoe.dev.example.com",
    "https://evilianpascoe.dev",
    "https://other.workers.dev",
    "https://my-mcp.ian-g-pascoe.workers.dev",
    "https://*.example.com",
    "https://*.com",
  ])("keeps %s, which is not cloudpid's", (domain) => {
    expect(directive(declare({ connectDomains: [domain] }), "connect-src")).toEqual([domain]);
  });

  it.each([
    ["a trailing dot", "https://pi.ianpascoe.dev."],
    ["a bare scheme", "https:"],
    ["a bare wildcard", "*"],
    ["a wildcard host", "https://*"],
    ["no scheme", "ok.example.com"],
    ["http", "http://ok.example.com"],
    ["ws", "ws://ok.example.com"],
    ["data:", "data:"],
    ["blob:", "blob:"],
    ["a keyword", "'unsafe-eval'"],
    ["a space", "https://ok.example.com 'unsafe-eval'"],
    ["a semicolon", "https://ok.example.com; script-src *"],
    ["a quote", "https://ok.example.com'"],
    ["a newline", "https://ok.example.com\nscript-src *"],
    ["a mid-label wildcard", "https://a*.example.com"],
    ["a port wildcard", "https://ok.example.com:*"],
    ["an IPv6 host", "https://[::1]"],
    ["a nested wildcard", "https://*.*.example.com"],
    ["an empty entry", ""],
  ])("drops %s", (_, domain) => {
    const policy = declare({ connectDomains: [domain], resourceDomains: [domain] });

    expect(directive(policy, "connect-src")).toEqual(["'none'"]);
    expect(directive(policy, "script-src")).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it.each([
    ["a path", "https://cdn.example.com/lib/"],
    ["a file", "https://cdn.example.com/app.js"],
    ["a query", "https://cdn.example.com/?v=1"],
    ["a fragment", "https://cdn.example.com/#x"],
    ["a username", "https://user@cdn.example.com"],
    ["a username and password", "https://user:pw@cdn.example.com"],
    ["a path on a wildcard host", "https://*.example.com/lib/"],
    ["a path on a wss host", "wss://rt.example.com/socket"],
  ])("drops an entry with %s whole, since its origin would be looser than declared", (_, entry) => {
    const policy = declare({
      connectDomains: [entry, "https://ok.example.com"],
      resourceDomains: [entry],
      frameDomains: [entry],
      baseUriDomains: [entry],
    });

    expect(directive(policy, "connect-src")).toEqual(["https://ok.example.com"]);
    expect(directive(policy, "script-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directive(policy, "frame-src")).toEqual(["'none'"]);
    expect(directive(policy, "base-uri")).toEqual(["'none'"]);
    expect(policy).not.toContain("cdn.example.com");
  });

  it("keeps an origin with a port, or with a trailing slash, as declared", () => {
    const policy = declare({
      connectDomains: [
        "https://api.example.com:8443",
        "https://api.example.com/",
        "wss://rt.example.com/",
      ],
    });

    expect(directive(policy, "connect-src")).toEqual([
      "https://api.example.com:8443",
      "https://api.example.com",
      "wss://rt.example.com",
    ]);
  });

  it("lists a domain once", () => {
    const policy = declare({
      resourceDomains: ["https://a.example.com", "https://a.example.com/"],
    });

    expect(directive(policy, "script-src")).toEqual([
      "'self'",
      "'unsafe-inline'",
      "https://a.example.com",
    ]);
  });

  it("frames only from the app origin it was given, whatever the declaration says", () => {
    const stage = "https://cloudpid-server-pr-430.ian-g-pascoe.workers.dev";

    const policy = buildCsp(
      JSON.stringify({
        frameDomains: [stage],
        connectDomains: ["https://frame-ancestors.example.com"],
      }),
      stage,
    );

    expect(directive(policy, "frame-ancestors")).toEqual([stage]);
    expect(directive(policy, "frame-src")).toEqual(["'none'"]);
  });
});

describe("the policy visual_check renders a page under", () => {
  // docs/architecture/visuals.md → The check: the header is the sandbox's own, which the browser host builds with the same
  // function but without the stage's own hosts; the fixed list names none of them, so the two agree.
  it("is the policy the sandbox gives a Visual's frame, with the frame's flags added", () => {
    expect(visualCheckPolicy()).toBe(
      `${buildCsp(JSON.stringify(VISUAL_CSP), "'none'")}; ${VISUAL_SANDBOX_DIRECTIVE}`,
    );
  });
});
