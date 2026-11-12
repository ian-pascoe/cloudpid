import type { TranscriptPart } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import { describe, expect, it } from "vite-plus/test";
import {
  chipLabel,
  downloadBytes,
  isMarkdown,
  MAX_PREVIEW_BYTES,
  MAX_PREVIEW_CHARS,
  previewOf,
  readOf,
  resourcesOf,
  safeContentType,
  safeFilename,
  unavailableNote,
} from "./mcp-resources.ts";

type Result = Extract<TranscriptPart, { type: "tool-result" }>;

const details = (resources: ReadonlyArray<unknown>): Result["details"] =>
  // SAFETY: a result's `details`, as the `mcp` extension writes it.
  ({ server: "docs", tool: "find", resources }) as Result["details"];

describe("resourcesOf", () => {
  it("takes each reference, with the server of the call, and what the transcript holds of an embedded text or image", () => {
    const shown = resourcesOf(
      details([
        { uri: "https://x.test/a.md", kind: "link", mimeType: "text/markdown", size: 12 },
        { uri: "file:///notes.md", kind: "text", part: 1, at: 1 },
        { uri: "file:///p.png", kind: "image", part: 2, at: 2, mimeType: "image/png" },
        { uri: "file:///b.bin", kind: "spill", path: "/workspace/.cloudpid/tmp/mcp-1.bin" },
      ]),
      [
        { type: "text", text: "[link]" },
        { type: "text", text: "# Notes" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    );

    expect(shown).toEqual([
      expect.objectContaining({ server: "docs", kind: "link", held: undefined }),
      expect.objectContaining({ kind: "text", held: { kind: "text", text: "# Notes" } }),
      expect.objectContaining({
        kind: "image",
        held: { kind: "blob", base64: "AAAA", mimeType: "image/png" },
      }),
      expect.objectContaining({ kind: "spill", path: "/workspace/.cloudpid/tmp/mcp-1.bin" }),
    ]);
  });

  it("holds nothing for a text whose block was cut (no `at`), or an `at` that is another kind of block", () => {
    const shown = resourcesOf(
      details([
        { uri: "file:///cut.txt", kind: "text", part: 0 },
        { uri: "file:///wrong.png", kind: "image", part: 1, at: 0 },
      ]),
      [{ type: "text", text: "head" }],
    );

    expect(Arr.map(shown, (each) => each.held)).toEqual([undefined, undefined]);
  });

  it("leaves out a ui:// resource, which is an App's, and reads a kind it does not know as a link", () => {
    const shown = resourcesOf(
      details([
        { uri: "ui://app/index.html", kind: "link" },
        { uri: "https://x.test/y", kind: "hologram" },
      ]),
      [],
    );

    expect(shown).toEqual([expect.objectContaining({ uri: "https://x.test/y", kind: "link" })]);
  });

  it("has none for a result with no references, or details that are not an MCP call's", () => {
    expect(resourcesOf(undefined, [])).toEqual([]);
    // SAFETY: `details` is open JSON, which a tool other than an MCP call's fills with whatever it keeps.
    expect(resourcesOf({ other: true } as Result["details"], [])).toEqual([]);
    expect(resourcesOf(details([]), [])).toEqual([]);
  });
});

describe("previewOf", () => {
  it("draws a Markdown text as Markdown, by its type or by a .md path with no better type", () => {
    expect(isMarkdown("text/markdown; charset=utf-8", "x://a")).toBe(true);
    expect(isMarkdown(undefined, "file:///docs/README.md?x=1")).toBe(true);
    expect(isMarkdown("text/plain", "file:///a.markdown")).toBe(true);
    expect(isMarkdown("text/html", "file:///a.md")).toBe(false);
    expect(previewOf({ kind: "text", text: "# T" }, "text/markdown", "x://a")).toEqual({
      kind: "markdown",
      text: "# T",
      cut: false,
    });
  });

  it("shows any other text, HTML and SVG included, as source", () => {
    expect(previewOf({ kind: "text", text: "<b>x</b>" }, "text/html", "x://a.html")).toEqual({
      kind: "source",
      text: "<b>x</b>",
      cut: false,
    });
    expect(
      previewOf({ kind: "text", text: "<svg onload=x()/>" }, "image/svg+xml", "x://a.svg").kind,
    ).toBe("source");
  });

  it("cuts a long text to what a preview draws", () => {
    const preview = previewOf(
      { kind: "text", text: "a".repeat(MAX_PREVIEW_CHARS + 5) },
      "text/plain",
      "x://a",
    );

    expect(preview).toMatchObject({ kind: "source", cut: true });
    expect(preview.kind === "source" && preview.text.length).toBe(MAX_PREVIEW_CHARS);
  });

  it("shows a blob of an allowed image type as a data URL it builds, and no other image", () => {
    expect(
      previewOf({ kind: "blob", base64: "iVBORw0K", mimeType: "image/PNG" }, undefined, "x://p"),
    ).toEqual({
      kind: "image",
      src: "data:image/png;base64,iVBORw0K",
      mimeType: "image/png",
    });

    for (const type of ["image/x-icon", "image/bmp", "application/pdf"]) {
      expect(
        previewOf({ kind: "blob", base64: "AAAA", mimeType: type }, undefined, "x://p").kind,
      ).toBe("download");
    }

    // An SVG is a document with scripts: never an img, only the escaped source it is.
    expect(
      previewOf(
        { kind: "blob", base64: btoa("<svg onload=x()/>"), mimeType: "image/svg+xml" },
        undefined,
        "x://p",
      ).kind,
    ).toBe("source");
  });

  it("never builds a source from base64 that is not base64, so no quote or URL reaches an attribute", () => {
    expect(
      previewOf(
        { kind: "blob", base64: 'AAAA" onerror="x()', mimeType: "image/png" },
        undefined,
        "x://p",
      ),
    ).toEqual({ kind: "download", why: "type" });
    expect(
      previewOf(
        { kind: "blob", base64: "https://evil.test/x.png", mimeType: "image/png" },
        undefined,
        "x://p",
      ),
    ).toEqual({ kind: "download", why: "type" });
  });

  it("decodes a blob of a text type as the text it is, and leaves any other blob to a download", () => {
    const hello = btoa("# Hello");

    expect(
      previewOf({ kind: "blob", base64: hello, mimeType: "text/markdown" }, undefined, "x://a"),
    ).toEqual({
      kind: "markdown",
      text: "# Hello",
      cut: false,
    });
    expect(
      previewOf(
        { kind: "blob", base64: btoa("{}"), mimeType: "application/json" },
        undefined,
        "x://a",
      ).kind,
    ).toBe("source");
    expect(
      previewOf({ kind: "blob", base64: "AAEC", mimeType: "application/zip" }, undefined, "x://a"),
    ).toEqual({
      kind: "download",
      why: "type",
    });
  });

  it("draws no blob over a megabyte, an image or a text: the download has all of it, up to what a read carries", () => {
    const over = "A".repeat(Math.ceil(((MAX_PREVIEW_BYTES + 1) * 4) / 3) + 4);

    for (const mimeType of ["image/png", "text/plain", "application/json", "application/zip"]) {
      expect(previewOf({ kind: "blob", base64: over, mimeType }, undefined, "x://a")).toEqual({
        kind: "download",
        why: "size",
      });
    }

    // At the cap it is drawn.
    expect(
      previewOf(
        { kind: "blob", base64: "A".repeat((MAX_PREVIEW_BYTES / 3) * 4), mimeType: "image/png" },
        undefined,
        "x://a",
      ).kind,
    ).toBe("image");
    // A text keeps the cut of its characters, and a download of all of it.
    expect(
      previewOf({ kind: "text", text: "a".repeat(2 * MAX_PREVIEW_BYTES) }, "text/plain", "x://a"),
    ).toMatchObject({ kind: "source", cut: true });
  });

  it("holds the bytes of 16 MiB for a download, without drawing them", () => {
    // 5,592,405 groups of three bytes: 16 MiB less one byte.
    const sixteen = "A".repeat(5_592_405 * 4);
    const bytes = downloadBytes({ kind: "blob", base64: sixteen, mimeType: "application/zip" });

    expect(bytes?.byteLength).toBe(5_592_405 * 3);
  });
});

describe("a download", () => {
  it("is named from the URI's last segment, with nothing that is a path, a hidden file or a quote", () => {
    expect(safeFilename("https://x.test/docs/report.pdf?sig=1#top", "application/pdf")).toBe(
      "report.pdf",
    );
    expect(safeFilename("file:///a/%2e%2e/%2e%2e/etc/passwd", undefined)).toBe("passwd");
    expect(safeFilename('x://h/".bashrc', undefined)).toBe("bashrc");
    expect(safeFilename("x://h/a%00b%0d%0ac<script>.txt", undefined)).toBe("a_b_c_script_.txt");
    expect(safeFilename("x://h/..", undefined)).toBe("resource");
    expect(safeFilename("", "text/markdown")).toBe("resource.md");
    expect(safeFilename(`x://h/${"n".repeat(300)}`, undefined).length).toBeLessThanOrEqual(80);
  });

  it("takes an extension from the type only when the name has none", () => {
    expect(safeFilename("x://h/notes", "text/markdown")).toBe("notes.md");
    expect(safeFilename("x://h/notes.txt", "text/markdown")).toBe("notes.txt");
    expect(safeFilename("x://h/blob", "application/x-weird")).toBe("blob");
  });

  it("is given a content type from a short list, so it is never one the browser would run", () => {
    expect(safeContentType("application/pdf")).toBe("application/pdf");
    expect(safeContentType("IMAGE/PNG; x=y")).toBe("image/png");
    expect(safeContentType("text/html")).toBe("application/octet-stream");
    expect(safeContentType("image/svg+xml")).toBe("application/octet-stream");
    expect(safeContentType("application/javascript")).toBe("application/octet-stream");
    expect(safeContentType("text/x-python")).toBe("text/plain");
    expect(safeContentType("not a type\r\nx: y")).toBe("application/octet-stream");
    expect(safeContentType(undefined)).toBe("application/octet-stream");
  });
});

describe("a chip", () => {
  it("is named from the URI's file, or the URI", () => {
    expect(chipLabel("https://x.test/a/b%20c.md")).toBe("b c.md");
    expect(chipLabel("")).toBe("");
  });
});

describe("a read's answer", () => {
  const resource = { mimeType: "image/png" };

  it("is the first item's text or blob, the blob taking the resource's type when the item has none", () => {
    expect(readOf({ status: "contents", contents: [{ uri: "u", text: "hi" }] }, resource)).toEqual({
      status: "held",
      held: { kind: "text", text: "hi" },
    });
    expect(
      readOf({ status: "contents", contents: [{ uri: "u", blob: "AAAA" }] }, resource),
    ).toEqual({
      status: "held",
      held: { kind: "blob", base64: "AAAA", mimeType: "image/png" },
    });
  });

  it("says why there is none, and reads a status it does not know as unavailable", () => {
    expect(readOf({ status: "unavailable", reason: "stopped", message: "m" }, resource)).toEqual({
      status: "unavailable",
      reason: "stopped",
      message: "m",
    });
    expect(readOf({ status: "contents", contents: [] }, resource)).toMatchObject({
      status: "unavailable",
    });
    expect(readOf({ status: "from-the-future", message: "later" }, resource)).toEqual({
      status: "unavailable",
      reason: "failed",
      message: "later",
    });
  });

  it("is told to the owner in words: a stopped Container is why there is no live preview, and a question is for a conversation", () => {
    expect(unavailableNote("stopped", "")).toContain("never starts it");
    expect(unavailableNote("input_required", "")).toContain("Open it in a conversation");
    expect(unavailableNote("failed", "the server said no")).toBe("No preview: the server said no");
  });

  it("tells a host that cannot promise it starts no Container from a Session that is older than previews", () => {
    expect(unavailableNote("host_unsupported", "")).toContain("MCP host");
    expect(unavailableNote("session_unsupported", "")).not.toContain("MCP host");
    expect(unavailableNote("session_unsupported", "")).toContain("Session is older");
    expect(unavailableNote("too_large", "")).toContain("16 MiB");
  });

  it("reads a reason it does not know as failed, so its own words are shown", () => {
    expect(
      readOf(
        { status: "unavailable", reason: "from-the-future", message: "later words" },
        resource,
      ),
    ).toEqual({ status: "unavailable", reason: "failed", message: "later words" });
  });
});
