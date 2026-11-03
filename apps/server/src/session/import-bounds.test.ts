// @effect-diagnostics preferEffectArray:off -- plain arrays of fixtures.
// What a translated entry is held to (`import-bounds.ts`).
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { EntryId, EntryRecord } from "@earendil-works/pi-durable";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { capImages, fitEntry, middleCut, storedBytes } from "./import-bounds.ts";

const entry = (text: string, extra: Partial<ToolResultMessage> = {}): EntryRecord => ({
  // SAFETY: an ID for a fixture.
  id: 1 as EntryId,
  conversationId: ROOT_CONVERSATION_ID,
  kind: "pi.tool-result",
  model: [
    {
      role: "toolResult",
      toolCallId: "c",
      toolName: "bash",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 1,
      ...extra,
    },
  ],
});

describe("middleCut", () => {
  it("keeps the start and the end, and says how many characters went", () => {
    const cut = middleCut(`${"a".repeat(1000)}${"z".repeat(1000)}`, 400);

    expect(cut.length).toBeLessThanOrEqual(400);
    expect(cut.startsWith("aaa")).toBe(true);
    expect(cut.endsWith("zzz")).toBe(true);
    expect(cut).toMatch(/\[… \d+ characters cut by the cloudpid import …\]/u);
  });

  it("leaves a text that fits, and never splits a surrogate pair", () => {
    expect(middleCut("short", 100)).toBe("short");

    const emoji = "😀".repeat(500);

    for (const keep of [300, 301, 302, 303]) {
      const cut = middleCut(emoji, keep);

      expect(cut).not.toMatch(
        /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u,
      );
    }
  });
});

describe("capImages", () => {
  it("replaces an image over the cap and one of a type the models do not take, and keeps the rest", () => {
    const content: Array<
      { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
    > = [
      { type: "image", data: "x".repeat(750_001), mimeType: "image/png" },
      { type: "image", data: "x", mimeType: "image/tiff" },
      { type: "image", data: "x", mimeType: "image/webp" },
    ];

    expect(capImages(content)).toBe(true);
    expect(content.map((part) => part.type)).toEqual(["text", "text", "image"]);
    expect(capImages(content)).toBe(false);
  });
});

describe("fitEntry", () => {
  it("returns an entry that fits untouched", () => {
    const small = entry("ok");

    expect(fitEntry(small, 10_000)).toEqual({ entry: small, cut: false });
  });

  it("cuts a text over the limit to within it, and keeps both its ends", () => {
    const big = entry(`HEAD${"x".repeat(50_000)}TAIL`);
    const fitted = fitEntry(big, 10_000);

    expect(fitted.cut).toBe(true);
    expect(fitted.entry === undefined ? 0 : storedBytes(fitted.entry)).toBeLessThanOrEqual(10_000);
    expect(JSON.stringify(fitted.entry)).toContain("HEAD");
    expect(JSON.stringify(fitted.entry)).toContain("TAIL");
  });

  it("holds an entry whose text escapes to more bytes than it has characters", () => {
    // Each of these is six bytes of JSON.
    const fitted = fitEntry(entry("\u0001".repeat(40_000)), 10_000);

    expect(fitted.entry === undefined ? 0 : storedBytes(fitted.entry)).toBeLessThanOrEqual(10_000);
  });

  it("cuts a long string of a result's details and of a call's arguments, not only the text", () => {
    const fitted = fitEntry(entry("short", { details: { diff: "d".repeat(50_000) } }), 10_000);

    expect(fitted.cut).toBe(true);
    expect(fitted.entry === undefined ? 0 : storedBytes(fitted.entry)).toBeLessThanOrEqual(10_000);
  });

  it("replaces images, the largest first, when the text cannot make the entry fit; and drops one that nothing can", () => {
    const images = entry("t", {
      content: [
        { type: "image", data: "a".repeat(6_000), mimeType: "image/png" },
        { type: "image", data: "b".repeat(5_000), mimeType: "image/png" },
      ],
    });

    const fitted = fitEntry(images, 7_000);

    expect(fitted.cut).toBe(true);
    expect(JSON.stringify(fitted.entry)).toContain("image omitted");
    expect(fitted.entry === undefined ? 0 : storedBytes(fitted.entry)).toBeLessThanOrEqual(7_000);

    // Nothing that can be cut is left of an entry with only a very long id.
    expect(fitEntry(entry("t", { toolCallId: "i".repeat(20_000) }), 5_000).entry).toBeUndefined();
  });
});
