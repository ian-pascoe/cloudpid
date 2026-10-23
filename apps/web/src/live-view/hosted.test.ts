import { describe, expect, it } from "vitest";
import { hostedLiveViewUrl } from "./hosted.ts";

describe("the hosted Live View", () => {
  it("opens a link's endpoint, without its scheme, as the hosted page's wss parameter", () => {
    const url = new URL(
      hostedLiveViewUrl("wss://live.browser.run/api/devtools/browser/b1/page/T1?jwt=a.b"),
    );

    expect(url.origin + url.pathname).toBe("https://live.browser.run/ui/view");
    expect(url.searchParams.get("mode")).toBe("tab");
    expect(url.searchParams.get("wss")).toBe(
      "live.browser.run/api/devtools/browser/b1/page/T1?jwt=a.b",
    );
  });
});
