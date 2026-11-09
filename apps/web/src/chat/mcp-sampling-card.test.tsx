import type { ConversationId, McpSamplingRequest } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import { renderToStaticMarkup } from "react-dom/server";
import {
  type AlsoWaiting,
  alsoLine,
  McpSamplingCard,
  samplingCalls,
} from "./mcp-sampling-card.tsx";

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

const render = (
  req: McpSamplingRequest,
  disabled = false,
  agent?: string,
  also?: AlsoWaiting,
  more: ReadonlyArray<McpSamplingRequest> = [],
) =>
  renderToStaticMarkup(
    <McpSamplingCard
      requests={[req, ...more]}
      also={also}
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

  it("says a request that waits for the owner waits, with no countdown", () => {
    const markup = render(request({ waits: "owner", deadline: 30 * 24 * 60 * 60 * 1000 }));

    expect(markup).toContain("docs waits for your answer");
    expect(markup).not.toContain("call ends in");
  });

  it("lists the call's requests on one card, each with its own messages, and one decision for all", () => {
    const markup = render(request(), false, undefined, undefined, [
      request({
        id: "call-1:s2",
        messages: [{ role: "user", text: "And this" }],
        tools: [],
        waits: "owner",
      }),
    ]);

    expect(markup).toContain("docs asks to use a model");
    expect(markup).toContain("2 requests");
    expect(markup).toContain("Request 1 of 2");
    expect(markup).toContain("Request 2 of 2");
    expect(markup).toContain("Summarize **this**");
    expect(markup).toContain("And this");
    // One set of buttons, one Role picker.
    expect(markup.match(/Allow for this call/g)).toHaveLength(1);
    expect(markup.match(/Run on/g)).toHaveLength(1);
    // The call ends on the earliest deadline, since one of the requests does not wait for the owner.
    expect(markup).toContain("call ends in");
  });

  it("says each request answers on the Role it was shown with when they differ, until the picker moves", () => {
    const markup = render(request(), false, undefined, undefined, [
      request({ id: "call-1:s2", role: "medium", model: "m/medium" }),
    ]);

    expect(markup).toContain("each answers on the Role it was shown with");
    expect(markup).toContain("m/small");
    expect(markup).toContain("m/medium");
    // Requests on one Role keep the single line.
    expect(
      render(request(), false, undefined, undefined, [request({ id: "call-1:s2" })]),
    ).toContain('answers on <span class="font-mono">m/small</span>');
  });

  it("groups the requests by call, in the order each call first appears", () => {
    const calls = samplingCalls([
      request({ id: "a:1", callId: "a" }),
      request({ id: "b:1", callId: "b" }),
      request({ id: "a:2", callId: "a" }),
    ]);

    expect(Arr.map(calls, (call) => Arr.map(call, (each) => each.id))).toEqual([
      ["a:1", "a:2"],
      ["b:1"],
    ]);
  });

  it("says what else the call waits on: its forms and pages, which keep their own cards", () => {
    expect(render(request(), false, undefined, { forms: 1, pages: 0 })).toContain(
      "also waiting: docs&#x27;s form",
    );
    expect(alsoLine("docs", { forms: 2, pages: 1 })).toBe("also waiting: docs's 2 forms and page");
    expect(alsoLine("docs", { forms: 0, pages: 0 })).toBeUndefined();
    expect(render(request())).not.toContain("also waiting");
  });

  it("hides Always allow and Never where the definition is not the owner's to write", () => {
    const markup = render(request({ writable: false }));

    expect(markup).toContain("Allow in this Session");
    expect(markup).toContain("Refuse in this Session");
    expect(markup).not.toContain("Always allow");
    expect(markup).not.toContain(">Never<");
  });

  it("says Reconnecting while the socket is not live, with the buttons off", () => {
    expect(render(request(), true)).toContain("Reconnecting…");
    expect(render(request(), true)).toMatch(/<button[^>]*disabled=""[^>]*>Allow for this call/);
  });

  it("says when Always allow and Never change a Global server, which every Environment has", () => {
    const global = render(request({ source: { kind: "global" } }));

    expect(global).toContain("Always allow (every Environment)");
    expect(global).toContain("Never (every Environment)");

    const own = render(request({ source: { kind: "environment" } }));

    expect(own).toContain("Always allow");
    expect(own).not.toContain("every Environment");
  });

  it("offers only the Roles this build can pick, and shows the request's own whatever it is", () => {
    const markup = render(
      request({
        role: "xxlarge",
        roles: [
          { role: "small", model: "m/small" },
          { role: "xxlarge", model: "m/huge" },
        ],
      }),
    );

    expect(markup).toContain("small · m/small");
    expect(markup).not.toContain("m/huge ");
    expect(markup).not.toContain('value="xxlarge"');
  });
});
