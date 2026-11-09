import type { ConversationId, McpSignInRequest } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { McpSignInCard } from "./mcp-sign-in-card.tsx";

const request = (more: Partial<McpSignInRequest> = {}): McpSignInRequest => ({
  id: "signin-3",
  // SAFETY: a number is what the Session sends for a conversation ID.
  conversationId: 1 as ConversationId,
  server: "sentry",
  environment: "env_1",
  urlHost: "mcp.sentry.dev",
  reason: "I need the issue list for the crash you described",
  why: "required",
  scopes: [],
  askedAt: 1,
  ...more,
});

const render = (req: McpSignInRequest, disabled = false, agent?: string) =>
  renderToStaticMarkup(
    <McpSignInCard
      request={req}
      sessionId="s 1"
      disabled={disabled}
      agent={agent}
      onDecline={() => Promise.resolve(null)}
    />,
  );

describe("McpSignInCard", () => {
  it("names the server, its hosts and the agent's reason as the agent's own words", () => {
    const markup = render(
      request({
        issuerHost: "auth.sentry.dev",
        source: { kind: "global" },
        reason: "<b>bold</b> please",
      }),
    );

    expect(markup).toContain("sentry needs you to sign in");
    expect(markup).toContain('id="request-signin-3"');
    expect(markup).toContain("mcp.sentry.dev");
    expect(markup).toContain("auth.sentry.dev");
    expect(markup).toContain("Global");
    expect(markup).toContain("The agent says:");
    expect(markup).toContain("&lt;b&gt;bold&lt;/b&gt; please");
    expect(markup).not.toContain("<b>bold</b>");
  });

  it("links Sign in to the start page in a new tab, naming the Session and the request", () => {
    const markup = render(request());

    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener"');
    expect(markup).toContain(
      'href="/oauth/mcp/start?environment=env_1&amp;server=sentry&amp;session=s+1&amp;request=signin-3&amp;return=%2Fsessions%2Fs%25201"',
    );
  });

  it("asks for a step-up when the server wants more access, and shows the scopes and the problem", () => {
    const markup = render(
      request({ why: "step_up", scopes: ["issues:read", "issues:write"], problem: "Denied once" }),
    );

    expect(markup).toContain("step_up=1");
    expect(markup).toContain("issues:read issues:write");
    expect(markup).toContain("Denied once");
    expect(markup).toContain("The server wants more access than the sign-in has");
  });

  it("turns Decline off while the Session is not live", () => {
    const markup = render(request(), true);

    expect(markup).toContain("Reconnecting…");
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Decline/);
  });
});
