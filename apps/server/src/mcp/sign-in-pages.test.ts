// The pages of an MCP sign-in (`docs/architecture/mcp-sign-in.md` → Page outcomes): their headers, their CSP hashes, what they
// escape and what they never hold.
// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off
import { MCP_SIGN_IN_FAILURES, type McpSignInFailure } from "@cloudpid/mcp/types";
import { describe, expect, it } from "vitest";
import {
  CALLBACK_SCRIPT,
  callbackPage,
  cancelledPage,
  cspHash,
  escapeHtml,
  interstitialPage,
  invalidCallbackPage,
  PAGE_STYLE,
  type Page,
  startProblemPage,
  startPromptPage,
} from "./sign-in-pages.ts";

const sha256Source = async (text: string): Promise<string> => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );

  return `'sha256-${btoa(String.fromCharCode(...digest))}'`;
};

const failure = (status: McpSignInFailure["status"]): McpSignInFailure => ({
  status,
  retry: { environment: "env_1", server: "sentry" },
  returnPath: "/settings",
});

const pages = (): ReadonlyArray<readonly [string, Page]> => [
  [
    "signed_in",
    callbackPage({
      status: "signed_in",
      server: "sentry",
      environments: [{ id: "env_1", name: "Work" }],
      resolved: [],
      revision: 3,
      returnPath: "/settings",
    }),
  ],
  ...MCP_SIGN_IN_FAILURES.map((status) => [status, callbackPage(failure(status))] as const),
  ["invalid", invalidCallbackPage()],
];

describe("the CSP hashes", () => {
  it("are the SHA-256 of the script and the style, as the browser computes them", async () => {
    expect(cspHash(CALLBACK_SCRIPT)).toBe(await sha256Source(CALLBACK_SCRIPT));
    expect(cspHash(PAGE_STYLE)).toBe(await sha256Source(PAGE_STYLE));
  });

  it.each(pages())("allow what the %s page carries and nothing else", async (_name, page) => {
    const csp = page.headers["content-security-policy"] ?? "";

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`style-src ${await sha256Source(PAGE_STYLE)}`);
    expect(csp).toContain(`script-src ${await sha256Source(CALLBACK_SCRIPT)}`);
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain("nonce");
    expect(csp).not.toContain("unsafe");
    expect(page.html).toContain(`<script>${CALLBACK_SCRIPT}</script>`);
    expect(page.html).toContain(`<style>${PAGE_STYLE}</style>`);
  });
});

describe("the CSP of the form pages", () => {
  const forms = [
    startPromptPage({
      environment: "env_1",
      server: "sentry",
      stepUp: false,
      requester: undefined,
      back: undefined,
    }),
    interstitialPage({
      state: "s".repeat(43),
      server: "sentry",
      source: "owner",
      url: "https://mcp.example/mcp",
      issuer: "https://as.example",
      clientId: "client",
    }),
  ];

  // Browsers apply `form-action` to every redirect after the submission, so `'self'` blocks the POST's 303 to the
  // authorization server. Nothing else is loosened.
  it.each(forms)("has no form-action and keeps every other directive", (page) => {
    const csp = page.headers["content-security-policy"] ?? "";

    expect(csp).not.toContain("form-action");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(page.headers["x-frame-options"]).toBe("DENY");
  });
});

describe("the referrer policy", () => {
  const interstitial = interstitialPage({
    state: "s".repeat(43),
    server: "sentry",
    source: "owner",
    url: "https://mcp.example/mcp",
    issuer: "https://as.example",
    clientId: "client",
  });

  const prompt = startPromptPage({
    environment: "env_1",
    server: "sentry",
    stepUp: false,
    requester: undefined,
    back: undefined,
  });

  // Under `no-referrer` a browser's form POST carries `Origin: null`, which the Worker refuses: a form page must say
  // `same-origin`, in the header and in the tag.
  it.each([
    ["the prompt", prompt],
    ["the interstitial", interstitial],
  ])("of %s keeps the form's Origin and sends nothing to another site", (_name, page) => {
    expect(page.headers["referrer-policy"]).toBe("same-origin");
    expect(page.html).toContain(`<meta name="referrer" content="same-origin">`);
    expect(page.html).not.toContain("no-referrer");
  });

  const withoutForm: ReadonlyArray<readonly [string, Page]> = [
    ...pages(),
    ["cancelled", cancelledPage()],
    ["a problem", startProblemPage("x", 400, undefined)],
  ];

  it.each(withoutForm)("of the %s page, which has no form, is no-referrer", (_name, page) => {
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.html).toContain(`<meta name="referrer" content="no-referrer">`);
  });
});

describe("the callback script", () => {
  it("never redirects the page", () => {
    expect(CALLBACK_SCRIPT).not.toMatch(/location\s*=|location\.(href|assign|replace)/);
    expect(pages().every(([, page]) => !/http-equiv=["']?refresh/i.test(page.html))).toBe(true);
  });
});

describe("every callback page", () => {
  it.each(pages())("%s is private, uncacheable and unframeable", (_name, page) => {
    expect(page.headers).toMatchObject({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
  });

  it.each(pages())("%s offers Back", (_name, page) => {
    expect(page.html).toContain(">Back</a>");
  });

  it.each(pages())("%s carries its outcome for the channel", (name, page) => {
    expect(page.html).toContain(`data-outcome="${name}"`);
  });

  it("offers Start again on the signed-in page too, back to where the owner was", () => {
    const page = callbackPage({
      status: "signed_in",
      server: "sentry",
      environments: [],
      resolved: [],
      revision: 1,
      retry: { environment: "env_1", server: "sentry" },
      returnPath: "/settings",
    });

    expect(page.html).toContain(
      `href="/oauth/mcp/start?environment=env_1&amp;server=sentry&amp;return=%2Fsettings"`,
    );
  });

  it("offers Start again on a failure that has a server to start, back to where the owner was", () => {
    const page = callbackPage(failure("exchange_failed"));

    expect(page.html).toContain(
      `href="/oauth/mcp/start?environment=env_1&amp;server=sentry&amp;return=%2Fsettings"`,
    );
    expect(callbackPage({ status: "expired" }).html).not.toContain("Start again");
  });

  it("answers 200 to a success and a decline, 503 to an unreadable store and 400 to the rest", () => {
    const status = Object.fromEntries(pages().map(([name, page]) => [name, page.status]));

    expect(status).toMatchObject({
      signed_in: 200,
      declined: 200,
      unavailable: 503,
      expired: 400,
      provider_error: 400,
      exchange_failed: 400,
      invalid: 400,
    });
  });
});

describe("what a page says", () => {
  it("escapes what an authorization server said", () => {
    const hostile = `<script>alert(1)</script>"'&`;

    const page = callbackPage({
      status: "provider_error",
      code: "server_error",
      message: hostile,
    });

    expect(page.html).not.toContain(hostile);
    expect(page.html).toContain(escapeHtml(hostile));
    expect(page.html.match(/<script/g)).toHaveLength(1);
  });

  it("escapes a server name, an Environment name and a return path", () => {
    const page = callbackPage({
      status: "signed_in",
      server: "<b>s</b>",
      environments: [{ id: "e", name: `"><img src=x>` }],
      resolved: [],
      revision: 1,
      returnPath: `/a"onmouseover="x`,
    });

    expect(page.html).not.toContain("<b>s</b>");
    expect(page.html).not.toContain("<img");
    expect(page.html).not.toContain(`"onmouseover=`);
  });

  it("names the Environments a sign-in serves", () => {
    const signedIn = (environments: ReadonlyArray<{ id: string; name: string }>) =>
      callbackPage({
        status: "signed_in",
        server: "sentry",
        environments,
        resolved: [],
        revision: 1,
      }).html;

    expect(
      signedIn([
        { id: "a", name: "Work" },
        { id: "b", name: "Home" },
      ]),
    ).toContain("Work, Home");
  });

  it("holds no code, state or token even when a failure names them", () => {
    const page = callbackPage({ status: "exchange_failed", code: "invalid_grant" });

    expect(page.html).toContain("invalid_grant");
    expect(page.html).not.toMatch(/code=|state=|access_token|refresh_token/);
  });
});

describe("the issuer interstitial", () => {
  const confirmation = {
    state: "Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9",
    server: "sentry",
    source: "owner",
    url: "https://mcp.example/mcp",
    issuer: "https://as.example",
    clientId: "https://cloudpid.example/oauth/mcp/client.json",
  };

  it("shows what is about to be trusted, and a POST of the state with Continue and Cancel", () => {
    const page = interstitialPage({
      ...confirmation,
      previousIssuer: "https://old.example",
      secret: { scope: "secret", name: "SENTRY_CLIENT_SECRET" },
    });

    expect(page.status).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.html).toContain("https://as.example");
    expect(page.html).toContain("https://old.example");
    expect(page.html).toContain("Your own entry");
    expect(page.html).toContain("${SENTRY_CLIENT_SECRET}, from your Secrets");
    expect(page.html).toContain(`<form method="post" action="/oauth/mcp/start">`);
    expect(page.html).toContain(`name="state" value="${confirmation.state}"`);
    expect(page.html).toContain(`name="decision" value="continue"`);
    expect(page.html).toContain(`name="decision" value="cancel"`);
  });
});

describe("the page a start asks on", () => {
  it("says what will start, escaped, and posts it to this origin only", () => {
    const page = startPromptPage({
      environment: "all",
      server: `<i>"s"</i>`,
      stepUp: true,
      requester: { session: "s1", request: "r1" },
      back: "/settings",
    });

    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).not.toContain("form-action");
    expect(page.headers["content-security-policy"]).toContain("script-src 'none'");
    expect(page.html).not.toContain("<i>");
    expect(page.html).toContain("All Environments");
    expect(page.html).toContain(`<form method="post" action="/oauth/mcp/start">`);
    expect(page.html).toContain(`name="step_up" value="1"`);
    expect(page.html).toContain(`name="return" value="/settings"`);
    expect(page.html).toContain(">Continue</button>");
  });
});

describe("the start's pages", () => {
  it("say why, escaped, with the status given and Back to the safe path", () => {
    const page = startProblemPage("<i>no</i>", 403, "/settings");

    expect(page.status).toBe(403);
    expect(page.html).toContain("&lt;i&gt;no&lt;/i&gt;");
    expect(page.html).toContain(`href="/settings"`);
  });
});
