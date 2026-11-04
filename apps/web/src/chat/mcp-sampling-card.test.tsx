import type { ConversationId, McpSamplingRequest } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { McpSamplingCard } from "./mcp-sampling-card.tsx";
import { samplingLine } from "./mcp-sampling-detail.ts";

const request = (more: Partial<McpSamplingRequest> = {}): McpSamplingRequest => ({
  id: "call-1:s1",
  callId: "call-1",
  // SAFETY: a number is what the Session sends for a conversation ID.
  conversationId: 1 as ConversationId,
  server: "docs",
  tool: "mcp__docs__summarize",
  role: "small",
  model: "m/small",
  roles: [
    { role: "small", model: "m/small" },
    { role: "medium", model: "m/medium" },
  ],
  systemPrompt: "Be <b>brief</b>",
  messages: [{ role: "user", text: "Summarize **this**" }],
  tools: [{ name: "lookup", description: "Looks a thing up" }],
  notes: ["asked to include context; none given"],
  writable: true,
  deadline: 10 * 60 * 1000 + 1000,
  ...more,
});

const render = (req: McpSamplingRequest, disabled = false, agent?: string) =>
  renderToStaticMarkup(
    <McpSamplingCard
      request={req}
      disabled={disabled}
      agent={agent}
      now={1000}
      onAnswer={() => Promise.resolve(null)}
    />,
  );

describe("McpSamplingCard", () => {
  it("names the server, shows what it asked as plain text, and the countdown", () => {
    const markup = render(request());

    expect(markup).toContain("docs asks to use a model");
    expect(markup).toContain("Be &lt;b&gt;brief&lt;/b&gt;");
    expect(markup).not.toContain("<b>brief</b>");
    expect(markup).toContain("Summarize **this**");
    expect(markup).toContain("1 tool offered");
    expect(markup).toContain("Looks a thing up");
    expect(markup).toContain("asked to include context; none given");
    expect(markup).toContain("docs&#x27;s call ends in 10:00");
  });

  it("offers the Role picker on the request's Role, with each Role's model", () => {
    const markup = render(request());

    expect(markup).toContain("Run on");
    expect(markup).toMatch(/<option value="small" selected[^>]*>small · m\/small/);
    expect(markup).toContain("medium · m/medium");
  });

  it("allows for this call by default, with the Session and Always in the menu, and refuses likewise", () => {
    const markup = render(request());

    expect(markup).toContain("Allow for this call");
    expect(markup).toContain("Allow in this Session");
    expect(markup).toContain("Always allow");
    expect(markup).toContain(">Refuse<");
    expect(markup).toContain("Refuse in this Session");
    expect(markup).toContain(">Never<");
  });

  it("hides Always allow and Never where the definition is not the owner's to write", () => {
    const markup = render(request({ writable: false }));

    expect(markup).toContain("Allow in this Session");
    expect(markup).toContain("Refuse in this Session");
    expect(markup).not.toContain("Always allow");
    expect(markup).not.toContain(">Never<");
  });

  it("shows no countdown for a request that waits for the owner, and Reconnecting while off", () => {
    expect(render(request({ waits: "owner" }))).toContain("docs waits for you");
    expect(render(request({ waits: "owner" }))).not.toContain("call ends in");
    expect(render(request(), true)).toContain("Reconnecting…");
    expect(render(request(), true)).toMatch(/<button[^>]*disabled=""[^>]*>Allow for this call/);
  });

  it("says which agent asked, and where the definition is", () => {
    expect(render(request())).toContain("· the agent");
    expect(render(request(), false, "reviewer (checks)")).toContain("· subagent reviewer (checks)");
    expect(render(request({ source: { kind: "global" } }))).toContain(">Global<");
  });
});

describe("samplingLine", () => {
  it("says who decided and what came of each request", () => {
    expect(samplingLine({ server: "docs", status: "answered", by: "definition" })).toBe(
      "docs used a model, as its definition allows",
    );
    expect(
      samplingLine({ server: "docs", status: "answered", by: "grant", role: "medium", cost: 0.5 }),
    ).toBe("docs used a model, as you allowed for this Session (medium, $0.50)");
    expect(samplingLine({ server: "docs", status: "refused", by: "owner" })).toBe(
      "You refused docs's request to use a model",
    );
    expect(
      samplingLine({
        server: "docs",
        status: "failed",
        by: "cloudpid",
        reason: "the model failed",
      }),
    ).toBe("docs's request to use a model failed: the model failed");
  });
});
