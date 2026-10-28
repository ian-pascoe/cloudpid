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
  target: "Every environment",
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

describe("ApprovalCard", () => {
  it("scrolls Now, After and Why in a region bounded by the viewport's height", () => {
    const markup = render(LISTING);
    const body = region(markup, /<div role="region"/, "dl");

    expect(body).toMatch(/max-h-\[\d+dvh\]/);
    expect(body).toContain("Now");
    expect(body).toContain("After");
    expect(body).toContain("Why");
  });

  it("keeps the header, the reason input and the buttons outside the scrolling region", () => {
    const markup = render(LISTING);
    const scrolled = markup.indexOf("overflow-y-auto");
    const closed = markup.indexOf("</dl></div>", scrolled);

    expect(markup.indexOf("Approval requested")).toBeLessThan(scrolled);
    expect(markup.indexOf("The agent asks your Approval")).toBeLessThan(scrolled);

    for (const outside of ['<input type="text"', "Decline</button>", "Approve</button>"]) {
      expect(markup.indexOf(outside)).toBeGreaterThan(closed);
    }
  });

  it("shows a multi-line value as written, in fixed-width text, and a short one as a sentence", () => {
    const markup = render(LISTING, "one line");

    expect(region(markup, /<dd class="font-mono[^"]*">━━/, "dd")).toContain("whitespace-pre-wrap");
    expect(markup).toContain('<dd class="break-words">one line</dd>');
  });

  it("lets the value column shrink, so a long line wraps inside the card", () => {
    expect(render(LISTING)).toContain("grid-cols-[auto_minmax(0,1fr)]");
  });
});

describe("the area of waiting requests", () => {
  it("is bounded by the viewport's height and scrolls on its own", () => {
    expect(WAITING_REQUESTS_CLASS).toMatch(/max-h-\[\d+dvh\]/);
    expect(WAITING_REQUESTS_CLASS).toContain("overflow-y-auto");
  });
});
