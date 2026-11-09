import type { ApprovalRequest, ConversationId } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCard } from "./approval-card.tsx";
import { requestCardId } from "./request-anchor.ts";

const request = (after: string, before = "not kept"): ApprovalRequest => ({
  id: "r1",
  // SAFETY: a number is what the Session sends for a conversation ID.
  conversationId: 1 as ConversationId,
  tool: "environment_skill_install",
  target: "Global",
  change: "Install Skills",
  before,
  after,
  reason: "Restore my Skills",
});

const render = (after: string) =>
  renderToStaticMarkup(
    <ApprovalCard request={request(after)} disabled={false} onAnswer={() => {}} />,
  );

/** The scrolling region of a card: its opening tag, and the markup before and after it. */
const split = (markup: string) => {
  const start = markup.indexOf('<div role="region"');
  const end = markup.indexOf("</dl></div>", start) + "</dl></div>".length;

  expect(start).toBeGreaterThanOrEqual(0);

  return {
    before: markup.slice(0, start),
    opening: markup.slice(start, markup.indexOf(">", start)),
    inside: markup.slice(start, end),
    after: markup.slice(end),
  };
};

describe("ApprovalCard", () => {
  it("shows a request's notes above the values, outside the scrolling region, and none for a request without", () => {
    const notes = [
      "Runs: node server.js in /workspace/app.",
      "Sends: ${TOKEN} (a Secret) in headers.Authorization.",
    ];

    const markup = renderToStaticMarkup(
      <ApprovalCard
        request={{ ...request("after"), notes }}
        disabled={false}
        onAnswer={() => {}}
      />,
    );

    const { before, inside } = split(markup);

    expect(before).toContain("What it runs, sends and reaches");
    expect(before).toContain("Runs: node server.js in /workspace/app.");
    expect(before).toContain("headers.Authorization");
    expect(inside).not.toContain("Runs: node");
    expect(render("after")).not.toContain("What it runs, sends and reaches");
  });
});

describe("a card's anchor", () => {
  it("is the id `?request=` names, so the page can scroll to it", () => {
    expect(requestCardId("r1")).toBe("request-r1");
    expect(render("after")).toMatch(/<section[^>]*id="request-r1"/);
  });
});
