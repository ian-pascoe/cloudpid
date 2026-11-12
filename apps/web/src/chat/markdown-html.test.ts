import { describe, expect, it } from "vite-plus/test";
import { markdownHtml } from "./markdown-html.ts";

describe("a copied message's HTML", () => {
  it("drops raw HTML, scripts' links and images, keeping an image's alt text", () => {
    expect(
      markdownHtml(
        "<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![a chart](https://tracker.example/p.png)",
      ),
    ).toBe("<p><a>x</a> a chart</p>");
  });
});
