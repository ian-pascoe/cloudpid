// docs/architecture/mcp-apps.md → The bridge: `ui/open-link`. Only http and https are taken, the owner confirms with the whole URL
// in front of them, dismissing answers -32000, and a newer request replaces the one waiting.
/* oxlint-disable anti-slop/no-unknown-parameters -- a View's params are whatever it sent */
// @effect-diagnostics preferEffectArray:off asyncFunction:off -- recorded calls in native lists, and promises a handler answers.
import { describe, expect, it, vi } from "vitest";
import { RpcError } from "./bridge.ts";
import { DISMISSED, linkOf, openLinkHandler, type PendingLink, shownLink } from "./open-link.ts";

describe("linkOf", () => {
  it("takes http and https URLs", () => {
    expect(linkOf({ url: "https://a.example/x?y=1" }).href).toBe("https://a.example/x?y=1");
    expect(linkOf({ url: "http://a.example:8080/" }).host).toBe("a.example:8080");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<p>",
    "file:///etc/passwd",
    "blob:https://a.example/1",
    "mailto:a@b.example",
    "ftp://a.example/",
    "//a.example/",
    "a.example/path",
    "https://user:pass@a.example/",
    "",
  ])("refuses %j with -32602", (url) => {
    expect(() => linkOf({ url })).toThrowError(RpcError);
    expect(() => linkOf({ url })).toThrowError(expect.objectContaining({ code: -32_602 }));
  });

  it("refuses params with no url, a url that is not text, and a URL too long to read", () => {
    for (const params of [
      undefined,
      {},
      { url: 3 },
      "https://a.example/",
      { url: `https://a.example/${"p".repeat(5000)}` },
    ]) {
      expect(() => linkOf(params)).toThrowError(expect.objectContaining({ code: -32_602 }));
    }
  });
});

describe("shownLink", () => {
  it("splits the URL around its host, so that what is shown is what is opened", () => {
    const shown = shownLink(new URL("https://docs.example.com:8443/a/b?c=d#e"));

    expect(shown.before + shown.host + shown.after).toBe(shown.url);
    expect(shown.host).toBe("docs.example.com:8443");
    expect(shown.before).toBe("https://");
    expect(shown.after).toBe("/a/b?c=d#e");
  });
});

describe("openLinkHandler", () => {
  const setup = () => {
    const shown: Array<PendingLink | null> = [];
    const open = vi.fn<(url: string) => void>();
    const openInPane = vi.fn<(url: string) => void>();
    const controller = new AbortController();

    const handler = openLinkHandler({ show: (link) => shown.push(link), open, openInPane });
    const ask = (url: unknown) => handler({ url }, { signal: controller.signal });

    return { shown, open, openInPane, controller, ask };
  };

  it("shows the confirmation and opens nothing until the owner chooses", async () => {
    const { shown, open, openInPane, ask } = setup();
    const answer = ask("https://a.example/x");

    await Promise.resolve();
    expect(shown.at(-1)?.url).toBe("https://a.example/x");
    expect(open).not.toHaveBeenCalled();
    expect(openInPane).not.toHaveBeenCalled();

    shown.at(-1)?.settle("open");
    await expect(answer).resolves.toEqual({});
    expect(open).toHaveBeenCalledWith("https://a.example/x");
    expect(shown.at(-1)).toBeNull();
  });

  it("opens in the Browser Pane when the owner asks for it", async () => {
    const { shown, open, openInPane, ask } = setup();
    const answer = ask("https://a.example/");

    shown.at(-1)?.settle("pane");
    await expect(answer).resolves.toEqual({});
    expect(openInPane).toHaveBeenCalledWith("https://a.example/");
    expect(open).not.toHaveBeenCalled();
  });

  it("answers -32000 when the owner dismisses it, and opens nothing", async () => {
    const { shown, open, openInPane, ask } = setup();
    const answer = ask("https://a.example/");

    shown.at(-1)?.settle("dismiss");
    await expect(answer).rejects.toMatchObject({ code: DISMISSED });
    expect(open).not.toHaveBeenCalled();
    expect(openInPane).not.toHaveBeenCalled();
  });

  it("replaces a pending link with a newer one, answering the old one -32000", async () => {
    const { shown, open, ask } = setup();
    const first = ask("https://one.example/");
    const second = ask("https://two.example/");

    await expect(first).rejects.toMatchObject({ code: DISMISSED });
    expect(shown.at(-1)?.url).toBe("https://two.example/");

    shown.at(-1)?.settle("open");
    await expect(second).resolves.toEqual({});
    expect(open.mock.calls).toEqual([["https://two.example/"]]);
  });

  it("answers a bad link -32602 at once, shows nothing and leaves the pending one", async () => {
    const { shown, ask } = setup();
    const pending = ask("https://a.example/");

    await expect(ask("javascript:alert(1)")).rejects.toMatchObject({ code: -32_602 });
    expect(shown.at(-1)?.url).toBe("https://a.example/");

    shown.at(-1)?.settle("dismiss");
    await expect(pending).rejects.toMatchObject({ code: DISMISSED });
  });

  it("is dismissed when the frame goes first", async () => {
    const { shown, controller, ask } = setup();
    const answer = ask("https://a.example/");

    controller.abort();
    await expect(answer).rejects.toMatchObject({ code: DISMISSED });
    expect(shown.at(-1)).toBeNull();
  });
});
