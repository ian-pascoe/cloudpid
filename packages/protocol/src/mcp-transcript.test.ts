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
import { projectEntries, type TranscriptMessage } from "./transcript.ts";
import { USER_ENTRY_KIND } from "./user-entry.ts";
import type { EntryRecord } from "@earendil-works/pi-durable";

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

  it("writes a Visual a call showed as its title and summary, never its page", () => {
    const shown: TranscriptMessage = {
      id: "7",
      role: "tool",
      timestamp: at,
      parts: [
        {
          type: "tool-result",
          id: "v1",
          name: "visual_show",
          content: [{ type: "text", text: 'Shown "Sales". Don\'t restate it.' }],
          error: false,
          details: { visual: { id: "v1", title: "Sales", summary: "Sales by month, as bars" } },
        },
      ],
    };

    expect(render(shown)[0]?.text).toBe(
      "### tool · visual_show · 14:02\n✓ 1 line\nVisual: Sales — Sales by month, as bars (not rendered)",
    );
    expect(renderTranscript([shown], { detail: "full" })[0]?.text).toContain(
      "\nVisual: Sales — Sales by month, as bars (not rendered)",
    );
  });

  it("adds a link to the Visual's Pane when it knows the Session and the call", () => {
    const shown: TranscriptMessage = {
      id: "7",
      role: "tool",
      timestamp: at,
      parts: [
        {
          type: "tool-result",
          id: "v1",
          name: "visual_show",
          content: [{ type: "text", text: "Shown." }],
          error: false,
          details: { visual: { id: "call_1|fc:2", title: "Sales", summary: "Bars" } },
        },
      ],
    };

    const line = "Visual: Sales — Bars (not rendered) · /sessions/s1?pane=visual:call_1%7Cfc:2";

    expect(renderTranscript([shown], { sessionId: "s1" })[0]?.text).toContain(`\n${line}`);
    expect(renderTranscript([shown], { sessionId: "s1", detail: "full" })[0]?.text).toContain(
      `\n${line}`,
    );
    // Without the Session's ID, or from a result that names no call, the line has none.
    expect(renderTranscript([shown])[0]?.text).not.toContain("/sessions/");
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

  it("redacts a stateless installation token whole", () => {
    // `ghs_<app id>_<JWT>`, about 520 characters: GitHub's format for every new one since 2026-10-02.
    const token =
      "ghs_1234567_eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJnaXRodWIiLCJpbnN0YWxsYXRpb24iOjk4NzY1fQ." +
      "aB3-_x9Q".repeat(50);

    expect(redactGithubTokens(`use ${token} now`)).toBe("use [REDACTED github token] now");
    expect(redactGithubTokens(`use ${token}${"aB3-_x9Q".repeat(600)} now`)).toBe(
      "use [REDACTED github token] now",
    );
  });

  describe("redacts a Secret before the cut can split it", () => {
    const secret = "s3cr3t-value-that-is-long";
    const redact = (text: string) => text.replaceAll(secret, "[S]");
    /** Starts from `from` on, one character apart: the cut's edge is in there somewhere. */
    const starts = (from: number) => Arr.makeBy(120, (index) => from + index);

    /** Where the secret starts, around the head the cut keeps, so one offset straddles the edge. */
    const around = (start: number, total: number) =>
      `${"x".repeat(start)}${secret}${"y".repeat(total)}`;

    const shows = (entry: TranscriptEntry | undefined) =>
      entry?.text.includes("s3cr3t") === true || entry?.text.includes(secret) === true;

    it("in an entry's text, at every offset near the edge of the cut", () => {
      for (const start of starts(900)) {
        const [entry] = renderTranscript([user(1, around(start, 4_000))], { redact });

        expect(shows(entry)).toBe(false);
        expect(entry?.text).toContain("characters cut");
      }
    });

    it("when it spans lines, in a tool call's string argument", () => {
      const pem = "-----BEGIN KEY-----\nMIIEvQIBADANBgkq\nhkiG9w0BAQEFAASC\n-----END KEY-----";

      const call: TranscriptMessage = {
        id: "1",
        role: "assistant",
        parts: [{ type: "tool-call", id: "c", name: "bash", arguments: `cat <<EOF\n${pem}\nEOF` }],
        timestamp: at,
      };

      const [entry] = renderTranscript([call], { redact: (text) => text.replaceAll(pem, "[S]") });

      expect(entry?.text).toContain("[S]");
      expect(entry?.text).not.toContain("MIIEvQ");
      expect(entry?.text).not.toContain("BEGIN KEY");
    });

    it("in a tool call's arguments, and in a tool result and an error", () => {
      for (const start of starts(20)) {
        const call: TranscriptMessage = {
          id: "1",
          role: "assistant",
          parts: [
            {
              type: "tool-call",
              id: "c",
              name: "bash",
              arguments: { command: around(start, 400) },
            },
          ],
          timestamp: at,
        };

        expect(shows(renderTranscript([call], { redact })[0])).toBe(false);
      }

      for (const start of starts(650)) {
        const result: TranscriptMessage = {
          id: "2",
          role: "tool",
          parts: [
            {
              type: "tool-result",
              id: "c",
              name: "bash",
              error: false,
              content: [{ type: "text", text: around(start, 6_000) }],
            },
          ],
          timestamp: at,
        };

        expect(shows(renderTranscript([result], { detail: "full", redact })[0])).toBe(false);
      }

      for (const start of starts(40)) {
        const failed: TranscriptMessage = {
          id: "3",
          role: "assistant",
          parts: [],
          error: around(start, 600),
          timestamp: at,
        };

        expect(shows(renderTranscript([failed], { redact })[0])).toBe(false);
      }
    });
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

describe("an input sent over the endpoint", () => {
  it("projects with its mark and renders it in the header", () => {
    const entry = {
      id: 4,
      kind: USER_ENTRY_KIND,
      data: {
        display: "hello",
        skills: [],
        via: { auth: "service_token", client: { name: "pi" } },
      },
      model: [{ role: "user", content: "hello", timestamp: at }],
    };

    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: the fields of an entry the projection reads.
    const [message] = projectEntries([entry as unknown as EntryRecord]);

    expect(message?.via).toEqual({ auth: "service_token", client: { name: "pi" } });
    expect(render(...(message === undefined ? [] : [message]))[0]?.text).toBe(
      "### user · 14:02 · via pi (MCP)\nhello",
    );
  });
});
