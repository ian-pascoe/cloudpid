import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PreviewBody, ReadPreview, ResourceChips, ResourceMarkdown } from "./mcp-resource-view.tsx";
import { previewOf, type ShownResource } from "./mcp-resources.ts";

const resource = (extra: Partial<ShownResource> = {}): ShownResource => ({
  server: "docs",
  uri: "file:///notes.md",
  kind: "link",
  ...extra,
});

describe("a Markdown preview", () => {
  it("renders Markdown, and shows raw HTML as the text it is: no element comes of it", () => {
    const html = renderToStaticMarkup(
      <ResourceMarkdown
        text={
          '# Title\n\n**bold** <b>raw</b> <script>alert(1)</script>\n\n<img src="https://evil.test/x.png" onerror="x()">\n\n<details><summary>s</summary>hid</details>'
        }
      />,
    );

    expect(html).toContain("Title");
    expect(html).toContain("bold");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain('onerror="');
    expect(html).toContain("&lt;script&gt;");
  });

  it("loads no image the Markdown names, and blocks a link to a javascript: URL", () => {
    const html = renderToStaticMarkup(
      <ResourceMarkdown text={"![pic](https://evil.test/p.png)\n\n[go](javascript:alert(1))"} />,
    );

    expect(html).not.toContain("<img");
    expect(html).not.toContain("evil.test/p.png");
    expect(html).toContain("pic");
    expect(html).not.toContain('href="javascript:');
  });
});

describe("a source preview", () => {
  it("escapes the text, HTML included", () => {
    const html = renderToStaticMarkup(
      <PreviewBody
        preview={previewOf(
          { kind: "text", text: '<script>alert("x")</script>' },
          "text/html",
          "x://a.html",
        )}
      />,
    );

    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<script");
  });

  it("says when it shows only the first part", () => {
    const html = renderToStaticMarkup(
      <PreviewBody preview={{ kind: "source", text: "head", cut: true }} />,
    );

    expect(html).toContain("The first part is shown");
  });
});

describe("an image preview", () => {
  it("is an img of a data URL of an allowed type, and never a URL the resource names", () => {
    const html = renderToStaticMarkup(
      <PreviewBody
        preview={previewOf(
          { kind: "blob", base64: "iVBORw0KGgo=", mimeType: "image/png" },
          "image/png",
          "https://evil.test/track.png",
        )}
      />,
    );

    expect(html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(html).not.toContain("evil.test");
  });

  it("is no img for a type outside the list, or for base64 that is not", () => {
    for (const held of [
      { kind: "blob", base64: "AAAA", mimeType: "image/svg+xml" },
      { kind: "blob", base64: 'x" onerror="y', mimeType: "image/png" },
    ] as const) {
      const html = renderToStaticMarkup(
        <ReadPreview resource={resource()} read={{ status: "held", held }} />,
      );

      expect(html).not.toContain("<img");
      expect(html).toContain("Download");
    }
  });
});

describe("a download", () => {
  it("is offered with the preview, and alone for a type that is not previewed", () => {
    const html = renderToStaticMarkup(
      <ReadPreview
        resource={resource({ uri: "file:///a.zip", mimeType: "application/zip" })}
        read={{
          status: "held",
          held: { kind: "blob", base64: "AAEC", mimeType: "application/zip" },
        }}
      />,
    );

    expect(html).toContain("This type is not previewed");
    expect(html).toContain("Download");
  });
});

describe("a download of a blob over what a card draws", () => {
  it("is offered alone, saying it is too large to show, whatever its type", () => {
    const html = renderToStaticMarkup(
      <ReadPreview
        resource={resource({ uri: "file:///big.png", mimeType: "image/png" })}
        read={{
          status: "held",
          // A megabyte and a little more, decoded.
          held: { kind: "blob", base64: "A".repeat(1_500_000), mimeType: "image/png" },
        }}
      />,
    );

    expect(html).toContain("Too large to show here");
    expect(html).not.toContain("<img");
    expect(html).toContain("Download");
  });
});

describe("a read that has no preview", () => {
  it("says why: a stopped Container is never started for it", () => {
    const html = renderToStaticMarkup(
      <ReadPreview
        resource={resource()}
        read={{ status: "unavailable", reason: "stopped", message: "" }}
      />,
    );

    expect(html).toContain("Container that is not running");
    expect(html).toContain("never starts it");
  });
});

describe("the chips of a card", () => {
  const link = resource({ uri: "https://x.test/spec.md", mimeType: "text/markdown", size: 2048 });

  const embedded = resource({
    uri: "file:///notes.md",
    kind: "text",
    mimeType: "text/markdown",
    held: { kind: "text", text: "# Embedded heading" },
  });

  it("draws a chip for each resource, with its type and size, and no preview until one is opened", () => {
    const Live = vi.fn(() => null);
    const html = renderToStaticMarkup(<ResourceChips resources={[link, embedded]} Live={Live} />);

    expect(html).toContain("spec.md");
    expect(html).toContain("text/markdown · 2.0 KB");
    expect(html).toContain("notes.md");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Embedded heading");
    expect(Live).not.toHaveBeenCalled();
  });

  it("previews an embedded resource from the transcript's data and reads nothing: the live read is never asked for", () => {
    const Live = vi.fn(() => null);

    const html = renderToStaticMarkup(
      <ResourceChips resources={[link, embedded]} Live={Live} initiallyOpen={1} />,
    );

    expect(html).toContain("Embedded heading");
    expect(html).toContain('aria-expanded="true"');
    expect(Live).not.toHaveBeenCalled();
  });

  it("hands a link, which holds no data, to the live read", () => {
    const Live = vi.fn(({ resource: each }: { resource: ShownResource }) => <p>live {each.uri}</p>);

    const html = renderToStaticMarkup(
      <ResourceChips resources={[link, embedded]} Live={Live} initiallyOpen={0} />,
    );

    expect(Live).toHaveBeenCalledTimes(1);
    expect(html).toContain("live https://x.test/spec.md");
  });

  it("draws nothing for a card with no resources", () => {
    expect(renderToStaticMarkup(<ResourceChips resources={[]} Live={() => null} />)).toBe("");
  });
});
