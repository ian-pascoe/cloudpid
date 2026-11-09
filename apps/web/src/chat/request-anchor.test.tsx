// docs/architecture/mcp-endpoint.md → Waiting requests: `?request=<request_id>` scrolls the Session page to that card.
import type { BrowserHandoffRequest, ConversationId, SecretRequest } from "@cloudpid/protocol";
import { describe, expect, it, type Mock, vi } from "@effect/vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserHandoffCard } from "./handoff-prompt.tsx";
import { ShownSession } from "./conversation.ts";
import {
  type CardSource,
  followRequest,
  REQUEST_WAIT_MS,
  requestCardId,
} from "./request-anchor.ts";
import { SecretCard } from "./secret-form.tsx";

/** A page of cards that tests add to, change and let time pass on. */
const page = () => {
  const cards = new Map<string, Mock<(options: { block: "center" }) => void>>();
  let onChange: (() => void) | undefined;
  let giveUp: (() => void) | undefined;
  const stops = { watch: 0, timer: 0 };

  const source: CardSource = {
    find: (id) => {
      const scroll = cards.get(id);

      return scroll === undefined ? null : { scrollIntoView: scroll };
    },
    watch: (change) => {
      onChange = change;

      return () => {
        stops.watch += 1;
        onChange = undefined;
      };
    },
    after: (_ms, then) => {
      giveUp = then;

      return () => {
        stops.timer += 1;
        giveUp = undefined;
      };
    },
  };

  return {
    source,
    stops,
    /** A card renders: the page changes. */
    render: (id: string) => {
      const scroll = vi.fn<(options: { block: "center" }) => void>();

      cards.set(id, scroll);
      onChange?.();

      return scroll;
    },
    /** An unrelated change of the page. */
    change: () => {
      onChange?.();
    },
    watching: () => onChange !== undefined,
    timeUp: () => giveUp?.(),
    waits: () => giveUp !== undefined,
  };
};

describe("followRequest", () => {
  it("scrolls to the card at once when it is on the page, and watches for nothing", () => {
    const browser = page();
    const scroll = browser.render(requestCardId("r1"));

    followRequest("r1", browser.source);

    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ block: "center" });
    expect(browser.watching()).toBe(false);
    expect(browser.waits()).toBe(false);
  });

  it("watches until the card appears, ignores other changes, scrolls once, then stops watching", () => {
    const browser = page();

    followRequest("r1", browser.source);

    expect(browser.watching()).toBe(true);

    browser.render(requestCardId("other"));
    browser.change();
    expect(browser.watching()).toBe(true);

    const scroll = browser.render(requestCardId("r1"));

    expect(scroll).toHaveBeenCalledTimes(1);
    expect(browser.watching()).toBe(false);
    expect(browser.waits()).toBe(false);

    // Later changes of the page do not scroll again.
    browser.change();
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it(`gives up after ${String(REQUEST_WAIT_MS)} ms, leaving the page where it is`, () => {
    const timers: Array<number> = [];
    const browser = page();

    followRequest("r1", {
      ...browser.source,
      after: (ms, then) => {
        timers.push(ms);

        return browser.source.after(ms, then);
      },
    });

    expect(timers).toEqual([REQUEST_WAIT_MS]);
    expect(browser.watching()).toBe(true);

    browser.timeUp();

    expect(browser.watching()).toBe(false);
    expect(browser.stops).toEqual({ watch: 1, timer: 1 });

    // A card that renders after the wait is not scrolled to.
    expect(browser.render(requestCardId("r1"))).not.toHaveBeenCalled();
  });

  it("stops watching and cancels the timer when the page leaves the request (the effect's cleanup)", () => {
    const browser = page();
    const stop = followRequest("r1", browser.source);

    stop();

    expect(browser.watching()).toBe(false);
    expect(browser.waits()).toBe(false);
    expect(browser.render(requestCardId("r1"))).not.toHaveBeenCalled();
  });
});

describe("the cards' anchors", () => {
  it("is on the Secret form", () => {
    const request: SecretRequest = {
      id: "s1",
      // SAFETY: a number is what the Session sends for a conversation ID.
      conversationId: 1 as ConversationId,
      names: ["API_KEY"],
    };

    const markup = renderToStaticMarkup(
      <SecretCard request={request} lifetimeMinutes={30} disabled={false} onAnswer={() => {}} />,
    );

    expect(markup).toMatch(/<form[^>]*id="request-s1"/);
  });

  it("is on the Browser Handoff card", () => {
    const request: BrowserHandoffRequest = {
      id: "h1",
      // SAFETY: a number is what the Session sends for a conversation ID.
      conversationId: 1 as ConversationId,
      instructions: "Solve the captcha",
      deadline: 1_800_000_000_000,
    };

    const markup = renderToStaticMarkup(
      <ShownSession.Provider value="s1">
        <BrowserHandoffCard request={request} agent={undefined} />
      </ShownSession.Provider>,
    );

    expect(markup).toMatch(/<section[^>]*id="request-h1"/);
  });
});
