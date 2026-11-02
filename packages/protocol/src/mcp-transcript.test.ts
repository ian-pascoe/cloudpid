import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";
import {
  ENTRY_TEXT_CHARS,
  middleCut,
  pageTranscript,
  redactGithubTokens,
  renderTranscript,
  TOOL_ARGUMENT_CHARS,
  transcriptChars,
} from "./mcp-transcript.ts";
import type { TranscriptEntry } from "./mcp-api.ts";
import type { TranscriptMessage } from "./transcript.ts";

const at = Date.UTC(2026, 0, 2, 14, 2, 30);

const user = (
  id: number,
  text: string,
  extra: Partial<TranscriptMessage> = {},
): TranscriptMessage => ({
  id: String(id),
  role: "user",
  parts: [{ type: "text", text }],
  timestamp: at,
  ...extra,
});

const ids = (list: readonly TranscriptEntry[]) => Arr.map(list, (entry) => entry.entry_id);

const render = (...messages: TranscriptMessage[]) => renderTranscript(messages);

describe("middleCut", () => {
  it("keeps both ends within the limit", () => {
    const cut = middleCut(`${"a".repeat(500)}${"z".repeat(500)}`, 200);

    expect(cut.length).toBeLessThanOrEqual(200);
    expect(cut.startsWith("aaa")).toBe(true);
    expect(cut.endsWith("zzz")).toBe(true);
    expect(cut).toContain("characters cut");
  });

  it("leaves short text and survives tiny limits", () => {
    expect(middleCut("short", 10)).toBe("short");
    expect(middleCut("x".repeat(100), 5)).toHaveLength(5);
  });
});

describe("renderTranscript", () => {
  it("heads a user block with its role and time, and a via mark", () => {
    const [plain, via] = render(
      user(1, "hello"),
      user(2, "again", { via: { auth: "oauth", client: { name: "claude-code" } } }),
    );

    expect(plain).toEqual({
      entry_id: 1,
      role: "user",
      at: "2026-01-02T14:02:30.000Z",
      text: "### user · 14:02\nhello",
    });
    expect(via?.text).toBe("### user · 14:02 · via claude-code (MCP)\nagain");
  });

  it("cuts text by detail, leaves thinking out and shows each call on a line", () => {
    const long = "w".repeat(10_000);

    const message: TranscriptMessage = {
      id: "3",
      role: "assistant",
      timestamp: 0,
      parts: [
        { type: "thinking", text: "secret musings" },
        { type: "text", text: long },
        { type: "tool-call", id: "c1", name: "bash", arguments: { command: "npm   test" } },
        {
          type: "tool-call",
          id: "c2",
          name: "edit",
          arguments: { path: "a".repeat(400), text: "b" },
        },
      ],
    };

    const [summary] = renderTranscript([message]);
    const [full] = renderTranscript([message], { detail: "full" });

    expect(summary?.at).toBe("");
    expect(summary?.text).not.toContain("musings");
    expect(summary?.text.startsWith("### assistant\n")).toBe(true);
    expect(summary?.text).toContain("→ bash  npm test");

    const edit = Arr.findFirst(summary?.text.split("\n") ?? [], (line) =>
      line.startsWith("→ edit"),
    );

    expect(Option.getOrThrow(edit).length).toBeLessThanOrEqual(
      "→ edit  ".length + TOOL_ARGUMENT_CHARS,
    );
    expect(summary?.text.length).toBeLessThan(ENTRY_TEXT_CHARS.summary + 1_000);
    expect(full?.text.length).toBeGreaterThan(summary?.text.length ?? 0);
    expect(full?.text.length).toBeLessThan(ENTRY_TEXT_CHARS.full + 1_000);
  });

  it("shows a tool result as a count, or as its first failing line", () => {
    const result = (text: string, error: boolean): TranscriptMessage => ({
      id: "5",
      role: "tool",
      timestamp: at,
      parts: [
        { type: "tool-result", id: "c1", name: "bash", content: [{ type: "text", text }], error },
      ],
    });

    expect(render(result("a\nb\nc", false))[0]?.text).toBe("### tool · bash · 14:02\n✓ 3 lines");
    expect(render(result("\nboom here\nmore", true))[0]?.text).toBe(
      "### tool · bash · 14:02\n✗ boom here",
    );
    expect(renderTranscript([result("a\nb", false)], { detail: "full" })[0]?.text).toContain(
      "✓ a\nb",
    );
  });

  it("shows images by size and notices on one line, and skips what shows nothing", () => {
    const picture: TranscriptMessage = {
      id: "6",
      role: "user",
      timestamp: at,
      parts: [{ type: "image", mimeType: "image/png", data: "A".repeat(307_200) }],
    };

    const notice: TranscriptMessage = {
      id: "7",
      role: "notice",
      title: "Context compacted (auto)",
      timestamp: at,
      parts: [],
    };

    const musing: TranscriptMessage = {
      id: "8",
      role: "assistant",
      timestamp: at,
      parts: [{ type: "thinking", text: "hmm" }],
    };

    const rendered = render(picture, notice, musing);

    expect(ids(rendered)).toEqual([6, 7]);
    expect(rendered[0]?.text).toContain("[image png 225 KB]");
    expect(rendered[1]?.text).toBe("· Context compacted (auto)");
  });

  it("redacts every block: GitHub tokens, and what the caller's redactor takes", () => {
    const token = `ghs_${"A1".repeat(20)}`;
    const [entry] = renderTranscript([user(1, `use ${token} and github_pat_${"x".repeat(30)}`)]);

    expect(entry?.text).toBe(
      "### user · 14:02\nuse [REDACTED github token] and [REDACTED github token]",
    );

    const [custom] = renderTranscript([user(1, "my hunter2")], {
      redact: (text) => text.replaceAll("hunter2", "$SECRET"),
    });

    expect(custom?.text).toContain("$SECRET");
    expect(redactGithubTokens("ghp_short")).toBe("ghp_short");
  });

  it("redacts a Secret the cut would have split", () => {
    const secret = "s3cr3t-value-that-is-long";
    const text = `${"x".repeat(1_990)}${secret}${"y".repeat(1_990)}`;

    const [entry] = renderTranscript([user(1, text)], {
      redact: (block) => block.replaceAll(secret, "[S]"),
    });

    expect(entry?.text).not.toContain("s3cr3t");
  });
});

const entries = (count: number, size = 100): TranscriptEntry[] =>
  Array.from({ length: count }, (_, index) => ({
    entry_id: index + 1,
    role: "user" as const,
    at: "",
    text: `${String(index + 1)}:`.padEnd(size, "."),
  }));

describe("pageTranscript", () => {
  it("reads the latest page, then older ones by `before`, then newer by `after`", () => {
    const all = entries(30, 1_000);
    const latest = pageTranscript(all, { maxChars: 5_000 });

    expect(ids(latest.entries)).toEqual([26, 27, 28, 29, 30]);
    expect(latest).toMatchObject({ hasOlder: true, hasNewer: false });

    const older = pageTranscript(all, { before: 26, maxChars: 5_000 });

    expect(ids(older.entries)).toEqual([21, 22, 23, 24, 25]);
    expect(older.hasNewer).toBe(true);

    const newer = pageTranscript(all, { after: 21, maxChars: 5_000 });

    expect(ids(newer.entries)).toEqual([22, 23, 24, 25, 26]);
    expect(newer).toMatchObject({ hasOlder: true, hasNewer: true });
  });

  it("holds the whole transcript when it fits, and no more than 200 entries", () => {
    expect(pageTranscript(entries(3), {})).toMatchObject({ hasOlder: false, hasNewer: false });
    expect(pageTranscript(entries(500, 10), { maxChars: 40_000 }).entries).toHaveLength(200);
  });

  it("always holds one entry, trimmed to fit", () => {
    const page = pageTranscript(entries(1, 9_000), { maxChars: 2_000 });

    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.text.length).toBeLessThanOrEqual(2_000);
  });

  it("answers nothing newer for an `after` at the end", () => {
    expect(pageTranscript(entries(4), { after: 4 })).toEqual({
      entries: [],
      hasOlder: false,
      hasNewer: false,
    });
  });

  it("keeps max_chars within its bounds", () => {
    expect(transcriptChars(undefined)).toBe(12_000);
    expect(transcriptChars(1)).toBe(2_000);
    expect(transcriptChars(10_000_000)).toBe(40_000);
  });
});
