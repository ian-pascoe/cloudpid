// The page fixtures and main-content expectations come from pi-web-tools' `test/web-fetch.test.ts` (MIT; see
// ../../NOTICE.md); the Markdown expectations are for the Worker-side converter that replaces Turndown.
// @effect-diagnostics preferEffectArray:off globalDate:off
import { describe, expect, it } from "vitest";
import { convertContent, type WebFetchFormat } from "./content.ts";
import { htmlToMarkdown } from "./html-markdown.ts";

const page = (html: string, format: WebFetchFormat): string =>
  convertContent(html, "text/html", format);

const NAVIGATION_PAGE = `<!doctype html><html><head><title>Guide to Widgets</title><style>.x{}</style></head>
<body>
<header><a href="/">SiteBrand Home</a></header>
<nav><ul><li><a href="/a">NavAlpha</a></li><li><a href="/b">NavBeta</a></li></ul></nav>
<main><h1>Widgets</h1><p>Widgets are small <strong>useful</strong> things.</p>
<nav><a href="#t">InPageToc</a></nav></main>
<aside>SidebarAds</aside>
<footer>FooterLegal</footer>
<script>trackingBeacon()</script>
</body></html>`;

const ARTICLE_PAGE = `<html><head><title>Blog Post Title</title></head><body>
<nav>NavAlpha</nav>
<div class="layout"><article><h2>Post Heading</h2><p>Post body text.</p></article></div>
<footer>FooterLegal</footer></body></html>`;

const CHROME_PAGE = `<html><head><title>Plain Page</title></head><body>
<header>SiteBrand Home</header><nav>NavAlpha</nav>
<div><h2>Content Heading</h2><p>Content body text.</p></div>
<section><header>Section Heading Block</header><p>Section text.</p></section>
<aside>SidebarAds</aside><footer>FooterLegal</footer></body></html>`;

describe("htmlToMarkdown", () => {
  it("renders headings, paragraphs, emphasis, links, and inline code", () => {
    expect(
      htmlToMarkdown(
        '<h1>Title</h1><p>Hello <b>bold</b> and <em>em</em> <a href="https://x.y/z">link</a> <code>c</code></p><h3>Sub</h3>',
      ),
    ).toBe("# Title\n\nHello **bold** and *em* [link](https://x.y/z) `c`\n\n### Sub");
  });

  it("moves whitespace outside emphasis markers, and drops empty spans and links", () => {
    expect(htmlToMarkdown("<p>a<b> bold </b>b <i></i><a href='/x'> </a>c</p>")).toBe(
      "a **bold** b c",
    );
  });

  it("renders nested lists, ordered lists with a start, and list items holding paragraphs", () => {
    expect(
      htmlToMarkdown(
        "<ul><li>a</li><li>b<ul><li>nested</li></ul></li></ul><ol start='3'><li>x</li><li>y</li></ol>",
      ),
    ).toBe("- a\n- b\n  - nested\n\n3. x\n4. y");
    expect(htmlToMarkdown("<ul><li><p>one</p></li><li><p>two</p></li></ul>")).toBe(
      "- one\n\n- two",
    );
  });

  it("fences code, keeps its blank lines, takes the language, and outgrows backticks inside it", () => {
    expect(
      htmlToMarkdown(
        '<pre><code class="language-js">const a = 1;\n\nlet b;</code></pre><p>after</p>',
      ),
    ).toBe("```js\nconst a = 1;\n\nlet b;\n```\n\nafter");
    expect(htmlToMarkdown("<pre>use ``` fences</pre>")).toBe("````\nuse ``` fences\n````");
  });

  it("prefixes every line of a block quote, also around code", () => {
    expect(htmlToMarkdown("<blockquote><p>one</p><p>two</p></blockquote><p>out</p>")).toBe(
      "> one\n>\n> two\n\nout",
    );
    expect(htmlToMarkdown("<ul><li>item<pre>x\ny</pre></li></ul>")).toBe(
      "- item\n\n  ```\n  x\n  y\n  ```",
    );
  });

  it("escapes Markdown syntax in text, and block starters at the start of a line", () => {
    expect(
      htmlToMarkdown(
        "<p>Foo_bar *star* [x] \\</p><p># not a heading</p><p>1. not a list</p><p>- no</p>",
      ),
    ).toBe("Foo\\_bar \\*star\\* \\[x\\] \\\\\n\n\\# not a heading\n\n1\\. not a list\n\n\\- no");
  });

  it("renders images, and skips inline data: images", () => {
    expect(
      htmlToMarkdown('<img src="a b.png" alt="pic [1]"><img src="data:image/png;base64,AAAA">'),
    ).toBe("![pic \\[1\\]](a%20b.png)");
  });

  it("renders a rule, a hard break, and a table as one line per row", () => {
    expect(
      htmlToMarkdown(
        "<p>a<br>b</p><hr><table><tr><th>H</th><th>I</th></tr><tr><td>1</td><td>2</td></tr></table>",
      ),
    ).toBe("a  \nb\n\n---\n\nH | I\n1 | 2");
  });

  it("decodes entities, drops scripts, styles, and templates, and keeps noscript", () => {
    expect(
      htmlToMarkdown(
        "<p>Tom &amp; Jerry &lt;3</p><script>bad()</script><style>.x{}</style><template>t</template><noscript>kept</noscript>",
      ),
    ).toBe("Tom & Jerry <3\n\nkept");
  });

  it("keeps the text of malformed input", () => {
    expect(htmlToMarkdown("<p>one<p>two")).toBe("one\n\ntwo");
    expect(htmlToMarkdown("<div><b>unclosed bold <a href='/x'>link")).toBe(
      "**unclosed bold [link](/x)**",
    );
    expect(htmlToMarkdown("</div><p>stray</p>")).toBe("stray");
    expect(htmlToMarkdown("")).toBe("");
  });

  it("does not need stack for deep nesting, and stays linear on a multi-MiB flat page", () => {
    expect(htmlToMarkdown(`${"<div>".repeat(50_000)}deep${"</div>".repeat(50_000)}`)).toBe("deep");
    expect(htmlToMarkdown(`${"<ul><li>".repeat(5_000)}deep`)).toContain("deep");

    const flat = `<body>${"<p>text <a href='http://x.y/z'>y</a> and <b>bold</b></p>\n".repeat(90_000)}</body>`;

    expect(flat.length).toBeGreaterThan(5_000_000);

    const started = Date.now();
    const markdown = htmlToMarkdown(flat);

    // A quadratic converter takes minutes here; this one takes about a second. The bound is loose for slow runners.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(markdown.split("\n\n")).toHaveLength(90_000);
  });
});

describe("convertContent", () => {
  it.each(["markdown", "text"] as const)(
    "returns <main> without site chrome in %s format",
    (format) => {
      const output = page(NAVIGATION_PAGE, format);

      for (const chrome of [
        "SiteBrand",
        "NavAlpha",
        "NavBeta",
        "SidebarAds",
        "FooterLegal",
        "InPageToc",
        "trackingBeacon",
      ]) {
        expect(output).not.toContain(chrome);
      }

      expect(output).toContain("Widgets are small");
      expect(output).toContain("Site chrome outside the main content was removed");
      expect(
        output.startsWith(format === "markdown" ? "# Guide to Widgets" : "Guide to Widgets"),
      ).toBe(true);
    },
  );

  it("renders the main content as Markdown", () => {
    expect(page(NAVIGATION_PAGE, "markdown")).toBe(
      "# Guide to Widgets\n\n*Site chrome outside the main content was removed.*\n\n# Widgets\n\nWidgets are small **useful** things.",
    );
  });

  it("prefers [role=main] and skips a title the content already repeats", () => {
    const html = `<html><head><title>Widgets</title></head><body><nav>NavAlpha</nav><div role="main"><h1>Widgets</h1><p>Body.</p></div></body></html>`;

    expect(page(html, "markdown")).toBe(
      "*Site chrome outside the main content was removed.*\n\n# Widgets\n\nBody.",
    );
  });

  it.each(["markdown", "text"] as const)(
    "falls back to a single <article> in %s format",
    (format) => {
      const output = page(ARTICLE_PAGE, format);

      expect(output).toContain("Blog Post Title");
      expect(output).toContain("Post body text.");
      expect(output).not.toContain("NavAlpha");
      expect(output).not.toContain("FooterLegal");
    },
  );

  it.each(["markdown", "text"] as const)(
    "strips page-level chrome when there is no main or article in %s format",
    (format) => {
      const output = page(CHROME_PAGE, format);

      for (const chrome of ["SiteBrand", "NavAlpha", "SidebarAds", "FooterLegal"]) {
        expect(output).not.toContain(chrome);
      }

      expect(output).toContain("Content body text.");
      expect(output).toContain("Section Heading Block");
    },
  );

  it("says how much text chrome removal dropped, and how to see it", () => {
    const links = Array.from(
      { length: 120 },
      (_, index) => `<a href="/${index}">Nav item ${index}</a>`,
    );

    const html = `<html><head><title>Docs</title></head><body><nav>${links.join(" ")}</nav><main><h1>Widgets</h1><p>Short body.</p></main></body></html>`;

    expect(page(html, "markdown")).toMatch(
      /Site chrome outside the main content was removed \(\d+% of page text\); use format: html for the full page\./,
    );
  });

  it("keeps a <main> that is the whole page without claiming chrome was removed", () => {
    expect(
      page(
        "<html><head><title>Solo</title></head><body><main><p>Only main.</p></main></body></html>",
        "markdown",
      ),
    ).toBe("# Solo\n\nOnly main.");
  });

  it("does not repeat a title that Markdown escapes", () => {
    const html = `<html><head><title>Foo_bar</title></head><body><nav>NavAlpha</nav><main><h1>Foo_bar</h1><p>Body.</p></main></body></html>`;

    expect(page(html, "markdown").match(/Foo\\?_bar/g)).toHaveLength(1);
  });

  it("puts text-format block elements on their own lines and collapses blank runs", () => {
    const html = `<html><head><title>Layout</title></head><body><main>
      <h1>Heading</h1>


      <p>First   paragraph,
         wrapped.</p><p>Second <em>inline</em> one.<br>After break</p>
      <ul><li>one</li><li>two</li></ul>
      <div>Block<div>Nested</div></div>
      <table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>
      <pre>  keep
    indent</pre>
    </main></body></html>`;

    expect(page(html, "text")).toBe(
      [
        "Layout",
        "",
        "Heading",
        "",
        "First paragraph, wrapped.",
        "",
        "Second inline one.",
        "After break",
        "",
        "one",
        "two",
        "",
        "Block",
        "Nested",
        "",
        "a b",
        "c d",
        "",
        "  keep",
        "    indent",
      ].join("\n"),
    );
  });

  it("returns html format unchanged, and JSON re-indented", () => {
    expect(page(NAVIGATION_PAGE, "html")).toBe(NAVIGATION_PAGE);
    expect(convertContent('{"a":[1]}', "application/json", "text")).toBe(
      '{\n  "a": [\n    1\n  ]\n}',
    );
    expect(convertContent('{"a":[1]}', "application/json", "html")).toBe('{"a":[1]}');
    expect(convertContent('{"a":[1]}', "text/plain", "text")).toBe('{"a":[1]}');
  });
});
