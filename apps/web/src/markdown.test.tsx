import { renderToStaticMarkup } from "react-dom/server";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import { relativeLinksTo, StaticMarkdown } from "./markdown.tsx";

const BASE = "https://github.com/o/r/blob/abc/skills/tdd/";

interface TreeNode {
  readonly type: string;
  readonly url?: string;
  readonly children?: ReadonlyArray<TreeNode>;
}

/** The urls of the links and definitions of a markdown text after `relativeLinksTo` has run over its tree. */
const urlsAfterRewrite = (text: string): ReadonlyArray<string> => {
  const processor = unified().use(remarkParse).use(relativeLinksTo(BASE));
  const tree = processor.runSync(processor.parse(text));
  const urls: string[] = [];

  const walk = (node: TreeNode) => {
    if ((node.type === "link" || node.type === "definition") && node.url !== undefined) {
      urls.push(node.url);
    }

    for (const child of node.children ?? []) walk(child);
  };

  walk(tree);

  return urls;
};

const html = (text: string): string =>
  renderToStaticMarkup(<StaticMarkdown text={text} base={BASE} />);

describe("relativeLinksTo", () => {
  it("makes a link written relative to the SKILL.md absolute against where it is on GitHub", () => {
    expect(urlsAfterRewrite("[ref](references/q.md)")).toEqual([`${BASE}references/q.md`]);
  });

  it("resolves a link that climbs out of the folder", () => {
    expect(urlsAfterRewrite("[up](../other/SKILL.md)")).toEqual([
      "https://github.com/o/r/blob/abc/skills/other/SKILL.md",
    ]);
  });

  it("makes a link reference definition absolute too", () => {
    expect(urlsAfterRewrite("[a][q]\n\n[q]: references/q.md")).toEqual([`${BASE}references/q.md`]);
  });

  it("leaves an anchor, and a URL that is complete, as they are", () => {
    expect(
      urlsAfterRewrite("[a](#steps) [b](https://example.com/x) [c](mailto:me@example.com)"),
    ).toEqual(["#steps", "https://example.com/x", "mailto:me@example.com"]);
  });
});

describe("a rendered SKILL.md", () => {
  it("blocks a markdown link to a javascript: URL, showing its text", () => {
    const out = html("[click](javascript:alert(1))");

    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("<a ");
    expect(out).toContain("click [blocked]");
  });

  it("loads no image, whether written in markdown or as raw HTML, and shows its alt text", () => {
    const out = html(
      '![md pic](https://evil.test/a.png)\n\n<img src="https://evil.test/b.png" alt="raw pic">',
    );

    expect(out).not.toContain("<img");
    expect(out).not.toContain("evil.test");
    expect(out).toContain("raw pic");
  });

  it("shows a raw HTML link relative to the file as blocked text, not a link to the app's own URL", () => {
    const out = html('<a href="docs/x.md">raw relative</a>');

    expect(out).not.toContain("<a ");
    expect(out).not.toContain('href="docs/x.md"');
    expect(out).toContain("raw relative [blocked]");
  });

  it("blocks a raw HTML link to a javascript: URL", () => {
    const out = html('<a href="javascript:alert(1)">raw js</a>');

    expect(out).not.toContain("javascript:");
    expect(out).toContain("raw js [blocked]");
  });

  it("does not block a markdown link relative to the file, which it has made absolute", () => {
    const out = html("[ref](references/q.md)");

    expect(out).not.toContain("[blocked]");
    expect(out).toContain('data-streamdown="link"');
  });

  it("blocks that link when it is not told where the text is, as it would any relative URL", () => {
    const out = renderToStaticMarkup(<StaticMarkdown text="[ref](references/q.md)" />);

    expect(out).toContain("ref [blocked]");
  });
});
