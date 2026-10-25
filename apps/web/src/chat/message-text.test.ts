import * as Arr from "effect/Array";
import { describe, expect, it } from "vitest";
import { markdownHtml } from "./markdown-html.ts";
import { messageText } from "./message-text.ts";

describe("a copied message's text", () => {
  it("is its text parts, a blank line between each, without its tool calls or thinking", () => {
    expect(
      messageText([
        { type: "reasoning", text: "Let me look." },
        { type: "text", text: "First I read it.\n" },
        { type: "tool-call" },
        { type: "text", text: "  " },
        { type: "text", text: "**Done.**" },
      ]),
    ).toBe("First I read it.\n\n**Done.**");
  });

  it("is empty for a message without text", () => {
    expect(messageText([{ type: "image" }])).toBe("");
  });
});

describe("a copied message's HTML", () => {
  it("is its markdown, GitHub's flavour", () => {
    expect(markdownHtml("**Bold** and `code`\n\n- [x] done\n\n| a |\n| - |\n| 1 |")).toBe(
      Arr.join(
        [
          "<p><strong>Bold</strong> and <code>code</code></p>",
          '<ul class="contains-task-list">',
          '<li class="task-list-item"><input type="checkbox" checked disabled> done</li>',
          "</ul>",
          "<table>",
          "<thead>",
          "<tr>",
          "<th>a</th>",
          "</tr>",
          "</thead>",
          "<tbody>",
          "<tr>",
          "<td>1</td>",
          "</tr>",
          "</tbody>",
          "</table>",
        ],
        "\n",
      ),
    );
  });

  it("keeps links and code blocks", () => {
    expect(markdownHtml("[docs](https://example.com)\n\n```ts\nconst a = 1;\n```")).toBe(
      '<p><a href="https://example.com">docs</a></p>\n<pre><code class="language-ts">const a = 1;\n</code></pre>',
    );
  });

  it("drops raw HTML, scripts' links and images, keeping an image's alt text", () => {
    expect(
      markdownHtml(
        "<script>alert(1)</script>\n\n[x](javascript:alert(1)) ![a chart](https://tracker.example/p.png)",
      ),
    ).toBe("<p><a>x</a> a chart</p>");
  });
});
