import type { ApprovalRequest, ConversationId } from "@cloudpid/protocol";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import { renderToStaticMarkup } from "react-dom/server";
import { ApprovalCard } from "./approval-card.tsx";
import { WAITING_REQUESTS_CLASS } from "./waiting-requests.tsx";

const SKILL = `━━ review (/review/SKILL.md) ━━\n${"line of the file\n".repeat(900)}`;
const LISTING = Arr.join(Arr.replicate(SKILL, 10), "\n");

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

const render = (after: string, before?: string) =>
  renderToStaticMarkup(
    <ApprovalCard request={request(after, before)} disabled={false} onAnswer={() => {}} />,
  );

/** The element of `markup` that opens with `open`, up to its matching close, for markup with no nested `tag`. */
const region = (markup: string, open: RegExp, tag: string): string => {
  const start = markup.search(open);

  expect(start).toBeGreaterThanOrEqual(0);

  return markup.slice(start, markup.indexOf(`</${tag}>`, start));
};

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
  it("scrolls only Now and After, in a region of their own", () => {
    const { opening, inside } = split(render(LISTING));

    expect(opening).toContain("overflow-y-auto");
    expect(inside).toContain(">Now<");
    expect(inside).toContain(">After<");
    expect(inside).not.toContain(">Why<");
  });

  it("keeps the header, Why, the reason input and the buttons outside the scrolling region", () => {
    const { before, after } = split(render(LISTING));

    expect(before).toContain("The agent asks your Approval");

    for (const outside of [
      ">Why<",
      "Restore my Skills",
      "<input",
      "Decline</button>",
      "Approve</button>",
    ]) {
      expect(after).toContain(outside);
    }
  });

  it("bounds the card itself, so the area never has to push its buttons out", () => {
    expect(render(LISTING)).toMatch(/<section[^>]*max-h-/);
  });

  it("shows a multi-line value as written, in fixed-width text, and a short one as a sentence", () => {
    const markup = render(LISTING, "one line");

    expect(region(markup, /<dd class="font-mono[^"]*">━━/, "dd")).toContain("whitespace-pre-wrap");
    expect(markup).toContain('<dd class="break-words">one line</dd>');
  });
});

describe("the area of waiting requests", () => {
  it("is bounded by the viewport's height and scrolls on its own", () => {
    expect(WAITING_REQUESTS_CLASS).toContain("max-h-");
    expect(WAITING_REQUESTS_CLASS).toContain("overflow-y-auto");
  });
});
