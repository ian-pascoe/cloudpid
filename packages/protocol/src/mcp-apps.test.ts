// App records' bounds and messages (`docs/architecture/mcp-apps.md` → App records, Socket messages).
// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off
import { describe, expect, it } from "vitest";
import {
  appAuditSummary,
  appRecordBytes,
  boundAppRecord,
  MAX_MCP_APP_RECORD_BYTES,
  MCP_APP_TEXT_CUT_BYTES,
  type McpAppRecord,
} from "./mcp-apps.ts";

const record = (
  result: McpAppRecord["result"],
  args: McpAppRecord["arguments"] = {},
): McpAppRecord => ({
  callId: "call-1",
  server: "docs",
  tool: "page",
  conversation: "1",
  arguments: args,
  htmlHash: "h",
  result,
  audit: [],
  at: 1,
});

type Block = {
  readonly type?: string;
  readonly text?: string;
  readonly resource?: { readonly text: string };
};

/** A bounded record's content blocks. */
const blocksOf = (bounded: McpAppRecord): ReadonlyArray<Block> =>
  // SAFETY: the tests' records hold an array of blocks as their result's content.
  bounded.result["content"] as ReadonlyArray<Block>;

const text = (length: number, char = "a") => ({ type: "text", text: char.repeat(length) });

describe("boundAppRecord", () => {
  it("leaves a record within the bound exactly as it is", () => {
    const small = record({
      content: [text(10)],
      structuredContent: { rows: [1, 2, 3] },
      _meta: { view: "wide" },
    });

    expect(boundAppRecord(small)).toBe(small);
  });

  it("drops structuredContent first, and only that when it is enough", () => {
    const big = record({
      content: [text(100)],
      structuredContent: { rows: "x".repeat(MAX_MCP_APP_RECORD_BYTES) },
      _meta: { view: "wide" },
    });

    const bounded = boundAppRecord(big);

    expect(bounded.result).toEqual({ content: [text(100)], _meta: { view: "wide" } });
    expect(bounded.truncated).toBe(true);
    expect(appRecordBytes(bounded)).toBeLessThanOrEqual(MAX_MCP_APP_RECORD_BYTES);
  });

  it("then cuts the texts to 64 KiB each, whole characters only", () => {
    const big = record({
      content: [
        text(MAX_MCP_APP_RECORD_BYTES),
        text(MAX_MCP_APP_RECORD_BYTES, "é"),
        {
          type: "resource",
          resource: { uri: "x://y", text: "z".repeat(MAX_MCP_APP_RECORD_BYTES) },
        },
      ],
      structuredContent: { rows: "x".repeat(10) },
    });

    const bounded = boundAppRecord(big);

    expect(bounded.truncated).toBe(true);
    expect(bounded.result).not.toHaveProperty("structuredContent");
    expect(appRecordBytes(bounded)).toBeLessThanOrEqual(MAX_MCP_APP_RECORD_BYTES);
    const [first, second, third] = blocksOf(bounded);

    expect(first?.text).toHaveLength(MCP_APP_TEXT_CUT_BYTES);
    // Two bytes each: 32 Ki characters, never half of one.
    expect(second?.text).toBe("é".repeat(MCP_APP_TEXT_CUT_BYTES / 2));
    expect(third?.resource?.text).toHaveLength(MCP_APP_TEXT_CUT_BYTES);
  });

  it("replaces the largest binary blocks by a line when the texts are not what weighs", () => {
    const big = record({
      content: [
        text(5),
        { type: "image", mimeType: "image/png", data: "A".repeat(MAX_MCP_APP_RECORD_BYTES + 5) },
        { type: "image", mimeType: "image/png", data: "B".repeat(100) },
      ],
    });

    const bounded = boundAppRecord(big);

    expect(bounded.truncated).toBe(true);
    expect(bounded.result["content"]).toEqual([
      text(5),
      { type: "text", text: "[image content omitted: too large for an App's record]" },
      { type: "image", mimeType: "image/png", data: "B".repeat(100) },
    ]);
  });

  it("holds every record to the bound, down to the result's _meta and the arguments", () => {
    const hostile = record(
      { content: [text(10)], _meta: { x: "m".repeat(MAX_MCP_APP_RECORD_BYTES) } },
      { y: "a".repeat(MAX_MCP_APP_RECORD_BYTES) },
    );

    const bounded = boundAppRecord(hostile);

    expect(appRecordBytes(bounded)).toBeLessThanOrEqual(MAX_MCP_APP_RECORD_BYTES);
    expect(bounded.truncated).toBe(true);
    expect(bounded.result).toEqual({ content: [text(10)] });
    expect(bounded.arguments).toEqual({});
  });

  it("holds a result of many mid-size texts to the bound, by omitting blocks from the end", () => {
    // 40 texts of 70 KB are cut to 64 KiB each, which is still 2.6 MB.
    const bounded = boundAppRecord(
      record({
        content: Array.from({ length: 40 }, (_, at) => text(70_000, String(at % 10))),
        isError: true,
      }),
    );

    const blocks = blocksOf(bounded);

    expect(appRecordBytes(bounded)).toBeLessThanOrEqual(MAX_MCP_APP_RECORD_BYTES);
    expect(bounded.truncated).toBe(true);
    expect(bounded.result["isError"]).toBe(true);
    // The blocks that fit are the first ones, whole, and a line says how many went.
    expect(blocks.length).toBeGreaterThan(5);
    expect(blocks[0]?.text).toHaveLength(MCP_APP_TEXT_CUT_BYTES);
    expect(blocks.at(-1)?.text).toMatch(/^\[\d+ content blocks omitted/);
  });

  it("drops the keys of a result that a CallToolResult does not have, when one is what weighs", () => {
    const bounded = boundAppRecord(
      record({ content: [text(10)], isError: false, vendor: { rows: "x".repeat(3_000_000) } }),
    );

    expect(bounded.result).toEqual({ content: [text(10)], isError: false });
    expect(bounded.truncated).toBe(true);
    expect(appRecordBytes(bounded)).toBeLessThanOrEqual(MAX_MCP_APP_RECORD_BYTES);
  });

  it("holds tens of thousands of resource links to the bound", () => {
    const link = (at: number) => ({
      type: "resource_link",
      uri: `https://docs.example/page/${at}`,
      name: `page ${at}`,
    });

    const bounded = boundAppRecord(
      record({ content: Array.from({ length: 30_000 }, (_, at) => link(at)) }),
    );

    expect(appRecordBytes(bounded)).toBeLessThanOrEqual(MAX_MCP_APP_RECORD_BYTES);
    expect(bounded.truncated).toBe(true);
    expect(blocksOf(bounded)[0]).toEqual(link(0));
  });

  it("falls back to the line alone, keeping isError, when even one block does not fit", () => {
    // A block of an unknown type has no cut and no binary to drop: a single one of 3 MB.
    const bounded = boundAppRecord(
      record({ content: [{ type: "vendor", rows: "x".repeat(3_000_000) }], isError: true }),
    );

    expect(bounded.result).toEqual({
      content: [{ type: "text", text: "[1 content block omitted: too large for an App's record]" }],
      isError: true,
    });
    expect(appRecordBytes(bounded)).toBeLessThanOrEqual(MAX_MCP_APP_RECORD_BYTES);
  });

  it("redacts after dropping structuredContent and before cutting, so a Secret never splits across the cut", () => {
    const secret = "s3cret-value-xyz";

    // The Secret straddles the 64 KiB cut: cut first, half of it would stay in the text.
    const padding = "p".repeat(MCP_APP_TEXT_CUT_BYTES - 5);
    const whole = `${padding}${secret}${"q".repeat(MAX_MCP_APP_RECORD_BYTES)}`;

    const seen: Array<string> = [];

    const bounded = boundAppRecord(
      record({ content: [{ type: "text", text: whole }], structuredContent: { only: secret } }),
      (value) => {
        seen.push(JSON.stringify(value));

        return JSON.parse(JSON.stringify(value).replaceAll(secret, "${SECRET}"));
      },
    );

    // The redactor saw the record without its structuredContent.
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain('"structuredContent"');

    const [block] = blocksOf(bounded);

    expect(block?.text?.startsWith(padding)).toBe(true);
    expect(block?.text?.slice(padding.length)).toBe(
      "${SECRET}".slice(0, MCP_APP_TEXT_CUT_BYTES - padding.length),
    );
    expect(JSON.stringify(bounded)).not.toContain("s3cret");
  });

  it("redacts a record within the bound too", () => {
    const bounded = boundAppRecord(record({ content: [text(3)] }), (value) =>
      JSON.parse(JSON.stringify(value).replaceAll("aaa", "[x]")),
    );

    expect(bounded.result["content"]).toEqual([{ type: "text", text: "[x]" }]);
    expect(bounded.truncated).toBeUndefined();
  });
});

describe("an App View's request", () => {
  it("is summed up for the audit log in one line, the arguments cut to 2 KiB and the text to 500 characters", () => {
    const summary = appAuditSummary({
      method: "tools/call",
      target: "echo",
      arguments: { text: "é".repeat(3000) },
      outcome: {
        status: "result",
        result: { content: [{ type: "text", text: `line one\nline two ${"x".repeat(900)}` }] },
      },
    });

    expect(summary.startsWith('tools/call echo {"text":"é')).toBe(true);
    expect(summary).not.toContain("\n");
    expect(summary).toMatch(/ → ok: line one line two x+…$/);
    // 2 KiB of arguments, 500 characters of text and the words around them.
    expect(new TextEncoder().encode(summary).length).toBeLessThan(2048 + 500 * 1 + 60);

    expect(
      appAuditSummary({
        method: "resources/read",
        target: "ui://docs/page",
        outcome: { status: "error", reason: "hidden", message: "The page is hidden" },
      }),
    ).toBe("resources/read ui://docs/page → hidden: The page is hidden");

    expect(
      appAuditSummary({
        method: "tools/call",
        target: "t",
        arguments: {},
        outcome: {
          status: "result",
          result: { isError: true, content: [{ type: "text", text: "no" }] },
        },
      }),
    ).toBe("tools/call t → tool error: no");
  });
});
