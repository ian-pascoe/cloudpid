// Browser Run's hosted Live View, the fallback of the handoff card's "Open in Cloudflare": its page takes the CDP
// endpoint of a Live View link, without the scheme, as its `wss` parameter.

/** The hosted Live View page for `link` (a `wss://` Live View link). */
export const hostedLiveViewUrl = (link: string): string => {
  const url = new URL("https://live.browser.run/ui/view");

  url.searchParams.set("mode", "tab");
  url.searchParams.set("wss", link.replace(/^wss:\/\//, ""));

  return url.href;
};
