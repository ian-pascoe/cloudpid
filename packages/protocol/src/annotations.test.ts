import { describe, expect, it } from "vitest";
import { clampPageSource, isSamePage, type PageSource } from "./annotations.ts";
import { MAX_PAGE_URL } from "./live-view.ts";

// Kept apart so no source file spells a whole Secret Reference.
const REFERENCE = `${"{".repeat(2)}secret:API_TOKEN${"}".repeat(2)}`;

const source = (url: string): PageSource => ({
  kind: "page",
  url,
  ownerTabId: "tab-1",
  box: { x: 0, y: 0, width: 10, height: 10 },
  scroll: { x: 0, y: 0 },
  viewport: { width: 1280, height: 720 },
});

/** The URL the Session keeps for a draft drawn on `url`. */
const kept = (url: string): string => clampPageSource(source(url)).url;

describe("isSamePage", () => {
  it("matches the page a draft was drawn on, fragment aside, and no other", () => {
    expect(isSamePage(kept("https://app.test/login#top"), "https://app.test/login#other")).toBe(
      true,
    );
    expect(isSamePage(kept("https://app.test/login"), "https://app.test/logout")).toBe(false);
    expect(isSamePage(kept("https://app.test/login"), "https://app.test/login/more")).toBe(false);
  });

  it("matches a URL the Session cut at its bound, by what it kept", () => {
    const long = `https://app.test/?q=${"a".repeat(MAX_PAGE_URL)}`;
    const quoted = `https://app.test/?q=${'"'.repeat(MAX_PAGE_URL)}`;

    expect(kept(long)).not.toBe(long);
    expect(isSamePage(kept(long), long)).toBe(true);
    expect(isSamePage(kept(long), `https://app.test/?q=${"b".repeat(MAX_PAGE_URL)}`)).toBe(false);
    // Cut by its bytes as the Review writes it, escaped.
    expect(isSamePage(kept(quoted), quoted)).toBe(true);
  });

  it("matches a URL a held Secret was redacted from, the Secret standing for any text", () => {
    expect(
      isSamePage(
        `https://app.test/cb?token=${REFERENCE}&next=1`,
        "https://app.test/cb?token=s3cr3t&next=1",
      ),
    ).toBe(true);
    expect(
      isSamePage(
        `https://app.test/cb?token=${REFERENCE}&next=1`,
        "https://app.test/cb?token=s3cr3t&next=2",
      ),
    ).toBe(false);
  });

  it("matches a URL the page put control characters in, as the Session cleaned it", () => {
    expect(isSamePage(kept("https://app.test/a\u202Eb"), "https://app.test/a\u202Eb")).toBe(true);
  });
});
