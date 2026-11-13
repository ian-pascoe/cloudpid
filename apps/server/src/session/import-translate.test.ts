// @effect-diagnostics preferEffectArray:off preferEffectRecord:off globalDate:off -- plain arrays of fixtures.
// The Session import's translation (`docs/architecture/mcp-endpoint.md` → Session import → Translation).
import type { EntryRecord } from "@earendil-works/pi-durable";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  assistantMessage,
  contextHandoff,
  contextNote,
  conversation,
  header,
  line,
  message,
  todoState,
  toolCall,
  toolResultMessage,
  userMessage,
} from "./import-pi-session.fixture.ts";
import { NOTICE_TOOL_LIMIT } from "./import-notice.ts";
import {
  CONTEXT_EDIT_KIND,
  type ImportFacts,
  NOT_RUN_TEXT,
  TOO_LARGE_TEXT,
  type Translation,
  translatePiSession,
  translated,
} from "./import-translate.ts";

const facts: ImportFacts = {
  branch: "feature/x",
  repos: [{ name: "app", directory: "/workspace/app" }],
  warnings: ["The local model m is not one of the owner's models."],
};

/** The translation of `lines`, which must be one. */
const translate = (lines: Iterable<string>, given: ImportFacts = facts): Translation => {
  const out = translatePiSession(lines, given);

  if (!translated(out)) throw new Error(out.failed);

  return out;
};

/** Every entry of the translation, from its pages. */
const entriesOf = (translation: Translation) => [...translation.pages()].flat();

/** The content parts of the first message of `entry`, read by key. */
const partsOf = (entry: EntryRecord | undefined): Array<Record<string, string>> => {
  const first = entry?.model?.[0];

  if (first === undefined || first.role === "system" || Predicate.isString(first.content))
    return [];

  return first.content.map((part): Record<string, string> =>
    Object.fromEntries(Object.entries(part).filter(([, value]) => Predicate.isString(value))),
  );
};

const noticeOf = (translation: Translation): string =>
  JSON.stringify(entriesOf(translation).at(-1)?.model);

describe("the translation", () => {
  it("maps the three message roles unchanged and ends with the notice", () => {
    const out = translate(conversation());
    const entries = entriesOf(out);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "pi.user",
      "pi.assistant",
      "pi.tool-result",
      "pi.assistant",
      "pi.user",
      "pi.user",
    ]);
    expect(entries.map((entry) => Number(entry.id))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(out.count).toBe(6);

    // Content unchanged, and only message timestamps survive.
    expect(entries[0]?.model?.[0]).toEqual(userMessage("Why does the build ignore the lockfile?"));
    expect(entries[2]?.model?.[0]).toEqual(
      toolResultMessage("call-1", "read", "export const key = hash(src);"),
    );
    expect(entries[2]?.data).toEqual({ diagnostics: [] });
    expect(JSON.stringify(entries.slice(0, 5))).not.toContain("2026-01-02");

    // The notice is last, and a user-role text entry.
    const last = entries.at(-1);

    expect(last?.model?.[0]).toMatchObject({ role: "user" });
    expect(noticeOf(out)).toContain("[cloudpid import]");
  });

  it("drops what it does not carry, counts the kinds it cannot map, and says nothing of what it replaces", () => {
    const out = translate([
      header,
      message("a", null, userMessage("hi")),
      line("model_change", "b", "a", { provider: "anthropic", modelId: "m" }),
      line("thinking_level_change", "c", "b", { thinkingLevel: "high" }),
      line("label", "d", "c", { targetId: "a", label: "start" }),
      line("session_info", "e", "d", { name: "Build" }),
      line("usage", "f", "e", { kind: "cache_warm" }),
      message("g", "f", { role: "system", content: "You are pi.", timestamp: 1 }),
      message("h", "g", { role: "bashExecution", command: "ls", output: "", timestamp: 1 }),
      line("future_kind", "i", "h"),
      line("future_kind", "j", "i"),
    ]);

    expect(out.summary).toEqual({
      cut: 0,
      dropped: { "message:bashExecution": 1, future_kind: 2 },
      closed: 0,
    });
    // Only the user message and the notice: no system, no `toolsRemoved`, no entry for a model or thinking change.
    expect(entriesOf(out).map((entry) => entry.kind)).toEqual(["pi.user", "pi.user"]);
  });

  it("is just the notice for a file with a header and nothing else", () => {
    expect(entriesOf(translate([header]))).toHaveLength(1);
  });

  it.each([
    ["an empty file", [], /empty/],
    ["a file without a header", [conversation()[1] ?? ""], /header/],
    ["a line that is not an entry", [header, "not json"], /Line 2/],
    [
      "a line that is no entry, past the first that is",
      [header, ...conversation().slice(1), "{"],
      /Line 7/,
    ],
  ])("fails %s with a sentence", (_name, lines, text) => {
    const out = translatePiSession(lines, facts);

    expect(translated(out)).toBe(false);
    expect(translated(out) ? "" : out.failed).toMatch(text);
  });

  it("reads a generator, which can be read once, as many times as it needs", () => {
    const out = translate(
      (function* () {
        yield* conversation();
      })(),
    );

    expect(entriesOf(out)).toHaveLength(6);
    expect(entriesOf(out)).toHaveLength(6);
  });

  it("takes the path that ends at the last line, and no other branch", () => {
    const out = translate([
      header,
      message("a", null, userMessage("first")),
      message("b", "a", assistantMessage([{ type: "text", text: "abandoned answer" }])),
      message("c", "a", assistantMessage([{ type: "text", text: "kept answer" }])),
      message("d", "c", userMessage("go on")),
    ]);

    const text = JSON.stringify(entriesOf(out));

    expect(text).toContain("kept answer");
    expect(text).not.toContain("abandoned answer");
    expect(entriesOf(out)).toHaveLength(4);
  });
});

describe("compaction, summaries, custom messages and context edits", () => {
  it("maps a compaction to pi.compaction with its head the first kept entry, renumbered as the translation's own", () => {
    const out = translate([
      header,
      message("a", null, userMessage("old")),
      message("b", "a", assistantMessage([{ type: "text", text: "old answer" }])),
      message("c", "b", userMessage("kept question")),
      message("d", "c", assistantMessage([{ type: "text", text: "kept answer" }])),
      line("compaction", "e", "d", {
        summary: "They talked about the build.",
        firstKeptEntryId: "c",
        tokensBefore: 1234,
        details: { files: [] },
      }),
      message("f", "e", userMessage("next")),
    ]);

    const entries = entriesOf(out);
    const compaction = entries[4];

    expect(compaction).toMatchObject({ kind: "pi.compaction", head: 3 });
    expect(JSON.stringify(compaction?.model)).toContain(
      "compacted into the following summary:\\n\\n<summary>\\nThey talked about the build.\\n</summary>",
    );
    // The compaction's own details, tokens and entry-level time do not survive.
    expect(JSON.stringify(compaction)).not.toContain("tokensBefore");
  });

  it("starts the head at the next entry when the first kept one made none, and at the summary when none is kept", () => {
    const out = translate([
      header,
      message("a", null, userMessage("old")),
      line("label", "b", "a", { targetId: "a", label: "x" }),
      message("c", "b", userMessage("kept")),
      line("compaction", "d", "c", { summary: "s", firstKeptEntryId: "b" }),
      line("compaction", "e", "d", { summary: "t", firstKeptEntryId: "gone" }),
    ]);

    const [, kept, first, second] = entriesOf(out);

    expect(kept?.kind).toBe("pi.user");
    expect(first).toMatchObject({ kind: "pi.compaction", head: 2 });
    expect(second).toMatchObject({ kind: "pi.compaction", head: 4 });
  });

  it("maps a branch summary and a custom message, which is context, to entries with messages", () => {
    const out = translate([
      header,
      message("a", null, userMessage("q")),
      line("branch_summary", "b", "a", { fromId: "z", summary: "They tried the other way." }),
      line("custom_message", "c", "b", {
        customType: "plannotator",
        content: "Review notes: tighten the cache key.",
        display: false,
      }),
    ]);

    const [, summary, custom] = entriesOf(out);

    expect(summary?.kind).toBe("cloudpid.branch-summary");
    expect(JSON.stringify(summary?.model)).toContain("They tried the other way.");
    expect(summary?.model?.[0]).toMatchObject({ role: "user" });
    expect(custom).toMatchObject({
      kind: "pi.user",
      model: [{ role: "user", content: "Review notes: tighten the cache key." }],
    });
  });

  it("maps a context edit to edits on the entry it names: an omission, and a replacement of the content", () => {
    const out = translate([
      header,
      message("a", null, userMessage("secret")),
      message("b", "a", assistantMessage([{ type: "text", text: "answer" }])),
      line("context_edit", "c", "b", { targetId: "a", replacement: null }),
      line("context_edit", "d", "c", {
        targetId: "b",
        replacement: { content: [{ type: "text", text: "redacted answer" }] },
      }),
      line("context_edit", "e", "d", { targetId: "nobody", replacement: null }),
    ]);

    const [, , omit, replace] = entriesOf(out);

    expect(omit).toMatchObject({ kind: CONTEXT_EDIT_KIND, edits: [{ target: 1, action: "omit" }] });
    expect(omit?.model).toBeUndefined();
    expect(replace?.edits?.[0]).toMatchObject({
      target: 2,
      action: "replace",
      messages: [
        {
          role: "assistant",
          provider: "anthropic",
          content: [{ type: "text", text: "redacted answer" }],
        },
      ],
    });
    // An edit of an entry that is not there makes nothing.
    expect(entriesOf(out)).toHaveLength(5);
  });
});

describe("extension state", () => {
  it("takes the last Todo List, the Notes replayed in order, and the last Handoff, and drops the rest by type", () => {
    const out = translate([
      header,
      message("a", null, userMessage("hi")),
      todoState("t1", "a"),
      contextNote("n1", "t1", "plan", "first"),
      contextNote("n2", "n1", "facts", "kept"),
      contextNote("n3", "n2", "plan", "second"),
      contextNote("n4", "n3", "facts", null),
      contextNote("n5", "n4", "again", "new"),
      contextHandoff("h1", "n5", "old handoff"),
      contextHandoff("h2", "h1", "the handoff"),
      line("custom", "x1", "h2", { customType: "pi-context-origin", data: { version: 1 } }),
      line("custom", "x2", "x1", { customType: "pi-git-checkpoints.model-step-start", data: {} }),
    ]);

    expect(out.todo).toMatchObject({
      nextId: 4,
      rev: 0,
      tasks: [
        { id: 1, title: "Reproduce the failing build", status: "completed" },
        { id: 2, title: "Fix the cache key", description: "The key ignores the lockfile hash." },
        { id: 3, title: "Open the pull request", status: "pending" },
      ],
      shown: null,
      changedBy: [],
    });
    expect(out.context?.notes.map((note) => [note.name, note.content])).toEqual([
      ["plan", "second"],
      ["again", "new"],
    ]);
    expect(out.context?.notes[0]?.updatedAt).toBe(Date.parse("2026-01-02T03:04:05.000Z"));
    expect(out.context?.handoff).toBe("the handoff");
    expect(out.summary.dropped).toEqual({
      "custom:pi-context-origin": 1,
      "custom:pi-git-checkpoints.model-step-start": 1,
    });
    // They make no entry, and the notice says what came across.
    expect(entriesOf(out)).toHaveLength(2);
    expect(noticeOf(out)).toContain("Todo List of 3 Tasks");
    expect(noticeOf(out)).toContain("2 Notes and the saved Handoff");
  });

  it("drops what is unknown, invalid or over a limit as custom:<type>, never failing the import", () => {
    const tooMany = Array.from({ length: 129 }, (_value, at) =>
      contextNote(
        `n${String(at)}`,
        at === 0 ? "b3" : `n${String(at - 1)}`,
        `note ${String(at)}`,
        "x",
      ),
    );

    const out = translate([
      header,
      message("a", null, userMessage("hi")),
      // An unknown version, and one that is not an object.
      line("custom", "v", "a", {
        customType: "pi-context-note",
        data: { version: 2, name: "n", content: "c", sourceSession: "s" },
      }),
      line("custom", "w", "v", { customType: "pi-todo-state", data: "no" }),
      // A list whose ids are not in order, one with an untrimmed title, and one with too many Tasks.
      line("custom", "t1", "w", {
        customType: "pi-todo-state",
        data: {
          nextId: 9,
          tasks: [
            { id: 2, title: "b", status: "pending" },
            { id: 1, title: "a", status: "pending" },
          ],
        },
      }),
      line("custom", "t2", "t1", {
        customType: "pi-todo-state",
        data: { nextId: 2, tasks: [{ id: 1, title: " padded ", status: "pending" }] },
      }),
      line("custom", "t3", "t2", {
        customType: "pi-todo-state",
        data: {
          nextId: 202,
          tasks: Array.from({ length: 201 }, (_value, at) => ({
            id: at + 1,
            title: "t",
            status: "pending",
          })),
        },
      }),
      // A Note with a name that is no label, another with a key the format does not have, a Handoff that is empty.
      contextNote("b1", "t3", "../etc/passwd", "x"),
      line("custom", "b2", "b1", {
        customType: "pi-context-note",
        data: { version: 1, name: "n", content: "c", sourceSession: "s", extra: true },
      }),
      contextHandoff("b3", "b2", ""),
      ...tooMany,
    ]);

    expect(out.todo).toBeNull();
    expect(out.context?.handoff).toBeNull();
    expect(out.context?.notes).toHaveLength(128);
    expect(out.summary.dropped).toEqual({
      "custom:pi-context-note": 4,
      "custom:pi-todo-state": 4,
      "custom:pi-context-handoff": 1,
    });
  });
});

describe("tool calls", () => {
  const withCall = (rest: string[]) => [
    header,
    message("a", null, userMessage("go")),
    message(
      "b",
      "a",
      assistantMessage(
        [toolCall("c1", "bash", { command: "ls" }), toolCall("c2", "read", { path: "x" })],
        "toolUse",
      ),
    ),
    ...rest,
  ];

  it("closes a call that has no result when the file ends, with an error result, before the notice", () => {
    const out = translate(withCall([message("c", "b", toolResultMessage("c1", "bash", "out"))]));
    const entries = entriesOf(out);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "pi.user",
      "pi.assistant",
      "pi.tool-result",
      "pi.tool-result",
      "pi.user",
    ]);
    expect(entries[3]?.model?.[0]).toMatchObject({
      role: "toolResult",
      toolCallId: "c2",
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: NOT_RUN_TEXT }],
    });
    expect(out.summary.closed).toBe(1);
    expect(noticeOf(out)).toContain("closed 1 tool call");
  });

  it("closes a call that the next message found without a result, in place of the result", () => {
    const out = translate(withCall([message("c", "b", userMessage("never mind"))]));

    expect(entriesOf(out).map((entry) => entry.kind)).toEqual([
      "pi.user",
      "pi.assistant",
      "pi.tool-result",
      "pi.tool-result",
      "pi.user",
      "pi.user",
    ]);
    expect(out.summary.closed).toBe(2);
  });

  it("keeps a call as it is and closes none of an assistant message the model's context leaves out", () => {
    const out = translate([
      header,
      message("a", null, userMessage("go")),
      message("b", "a", assistantMessage([toolCall("c1", "bash")], "aborted")),
    ]);

    expect(out.summary.closed).toBe(0);
    expect(entriesOf(out)[1]?.model?.[0]).toMatchObject({
      content: [{ type: "toolCall", name: "bash" }],
    });
  });

  it("spells an MCP tool's name as cloudpid does in calls and results, and leaves unknown names as they are", () => {
    const out = translate([
      header,
      message("a", null, userMessage("go")),
      message(
        "b",
        "a",
        assistantMessage(
          [toolCall("c1", "mcp__github__getUser"), toolCall("c2", "laptop_only_tool")],
          "toolUse",
        ),
      ),
      message("c", "b", toolResultMessage("c1", "mcp__github__getUser", "{}")),
      message("d", "c", toolResultMessage("c2", "laptop_only_tool", "ok")),
    ]);

    const [, assistant, result] = entriesOf(out);

    expect(assistant?.model?.[0]).toMatchObject({
      content: [{ name: "mcp__github__get_user" }, { name: "laptop_only_tool" }],
    });
    expect(result?.model?.[0]).toMatchObject({ toolName: "mcp__github__get_user" });
  });
});

describe("bounds", () => {
  describe("a tool result that cannot be cut to fit", () => {
    /** A call and its result, the result being `result`. */
    const answered = (result: {
      readonly details?: Schema.Json;
      readonly content?: Schema.Json;
    }) => [
      header,
      message("a", null, userMessage("run it")),
      message("b", "a", assistantMessage([toolCall("c1", "bash", { command: "dump" })], "toolUse")),
      message("c", "b", { ...toolResultMessage("c1", "bash", "out"), ...result }),
    ];

    it("keeps the result with its details replaced, which the model never sees: the call is answered, and the cut is counted once", () => {
      // 300,000 small objects: no string among them is long enough to be cut, so only the details can go.
      const details = Array.from({ length: 300_000 }, (_value, at) => ({
        name: "abcdefgh",
        at,
      }));

      const out = translate(answered({ details }));
      const entries = entriesOf(out);

      expect(entries.map((entry) => entry.kind)).toEqual([
        "pi.user",
        "pi.assistant",
        "pi.tool-result",
        "pi.user",
      ]);
      expect(entries[2]?.model?.[0]).toMatchObject({
        role: "toolResult",
        toolCallId: "c1",
        isError: false,
        content: [{ type: "text", text: "out" }],
        details: { reason: "import_too_large" },
      });
      expect(out.summary).toEqual({ cut: 1, dropped: {}, closed: 0 });
    });

    it("answers the call with an error result when the details were not what made it too large, and counts it closed", () => {
      // 100,000 parts of 100 characters each: too many to hold, and none long enough to be cut.
      const content = Array.from({ length: 100_000 }, () => ({
        type: "text",
        text: "x".repeat(100),
      }));

      const out = translate(answered({ content }));
      const entries = entriesOf(out);

      expect(entries.map((entry) => entry.kind)).toEqual([
        "pi.user",
        "pi.assistant",
        "pi.tool-result",
        "pi.user",
      ]);
      expect(entries[2]?.model?.[0]).toMatchObject({
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: TOO_LARGE_TEXT }],
      });
      expect(out.summary).toEqual({ cut: 0, dropped: {}, closed: 1 });
    });
  });

  it("holds the images of one tool result to the total a live result holds, in order", () => {
    // Three images of 600,000 characters: two fit the 1,500,000 a result holds, the third does not.
    const image = { type: "image", data: "x".repeat(600_000), mimeType: "image/png" };

    const out = translate([
      header,
      message("a", null, userMessage("shoot")),
      message("b", "a", assistantMessage([toolCall("c1", "shot", {})], "toolUse")),
      message("c", "b", {
        ...toolResultMessage("c1", "shot", "pictures"),
        content: [{ type: "text", text: "pictures" }, image, image, image],
      }),
    ]);

    const parts = partsOf(entriesOf(out)[2]);

    expect(parts.map((part) => part.type)).toEqual(["text", "image", "image", "text"]);
    expect(parts[3]?.text).toContain("one tool result holds at most 1,500,000");
    expect(out.summary.cut).toBe(1);
  });

  it("cuts the largest parts to one level, so a smaller one beside them stays whole, and withdraws a signature", () => {
    const out = translate([
      header,
      message(
        "a",
        null,
        assistantMessage([
          { type: "thinking", thinking: "t".repeat(3_000_000), thinkingSignature: "sig" },
          { type: "text", text: "u".repeat(3_000_000) },
          { type: "text", text: "small" },
        ]),
      ),
    ]);

    const parts = partsOf(entriesOf(out)[0]);

    expect(parts[0]?.thinking?.length).toBeLessThan(2_600_000);
    expect(parts[0]?.thinkingSignature).toBeUndefined();
    expect(parts[1]?.text?.length).toBeLessThan(2_600_000);
    expect(parts[2]?.text).toBe("small");
    expect(
      Math.abs((parts[0]?.thinking?.length ?? 0) - (parts[1]?.text?.length ?? 0)),
    ).toBeLessThan(1000);
  });

  it("writes the entries in pages, none holding more than the page's entries, and the pages are the same each time", () => {
    const many = Array.from({ length: 450 }, (_value, at) =>
      message(
        `m${String(at)}`,
        at === 0 ? null : `m${String(at - 1)}`,
        userMessage(`message ${String(at)}`),
      ),
    );

    const out = translate([header, ...many]);
    const pages = [...out.pages()];

    expect(pages.map((page) => page.length)).toEqual([200, 200, 51]);
    expect(out.count).toBe(451);

    const again = [...out.pages()].flat();

    expect(again.slice(0, 450)).toEqual(pages.flat().slice(0, 450));
    expect(Number(again.at(-1)?.id)).toBe(451);
  });

  it("cuts a page by size, so a few large entries make several", () => {
    const text = "z".repeat(1_500_000);

    const out = translate([
      header,
      ...[0, 1, 2, 3, 4].map((at) =>
        message(`m${String(at)}`, at === 0 ? null : `m${String(at - 1)}`, userMessage(text)),
      ),
    ]);

    expect([...out.pages()].length).toBeGreaterThan(1);
    expect([...out.pages()].flat()).toHaveLength(6);
  });
});

describe("the notice", () => {
  it("is the last entry, whatever the file holds", () => {
    for (const lines of [
      [header],
      conversation(),
      [header, ...conversation().slice(1), todoState("t", "a5")],
      [header, message("a", null, assistantMessage([toolCall("c", "bash")], "toolUse"))],
    ]) {
      const entries = entriesOf(translate(lines));

      expect(JSON.stringify(entries.at(-1)?.model)).toContain("[cloudpid import]");
      expect(
        entries.filter((entry) => JSON.stringify(entry).includes("[cloudpid import]")),
      ).toHaveLength(1);
    }
  });

  it("names the cwd, each Repo and the branch, the fallback, the counts, the Todo and Notes, and the git pull", () => {
    const out = translate([
      header,
      message("a", null, userMessage("hi")),
      line("future_kind", "b", "a"),
      todoState("t", "b"),
    ]);

    const notice = noticeOf(out);

    expect(notice).toContain("/Users/example/src/app");
    expect(notice).toContain("`feature/x`");
    expect(notice).toContain("app at /workspace/app");
    expect(notice).toContain("not one of the owner's models");
    expect(notice).toContain("dropped 1 entry");
    expect(notice).toContain("future_kind 1");
    expect(notice).toContain("Todo List of 3 Tasks");
    expect(notice).toContain("no Notes or Handoff");
    expect(notice).toContain("git status");
    expect(notice).toContain(
      "`git pull` on `feature/x`: commit and push your work there when you finish",
    );
  });

  it.each([
    [true, "uncommitted Changes were carried"],
    [undefined, "which this import is not told"],
  ])("says what finish said of the Changes carried (%s)", (changesCarried, sentence) => {
    const out = translate(conversation(), { ...facts, changesCarried });

    expect(noticeOf(out)).toContain(sentence);
  });

  it("lists the laptop tools this Session lacks, at most 30 and then how many more, and none of an MCP tool", () => {
    const names = Array.from(
      { length: NOTICE_TOOL_LIMIT + 5 },
      (_value, at) => `laptop_${String(at).padStart(2, "0")}`,
    );

    const lines = [
      header,
      message("a", null, userMessage("go")),
      message(
        "b",
        "a",
        assistantMessage(
          [
            ...names.map((name) => toolCall(name, name)),
            toolCall("r", "read"),
            toolCall("m", "mcp__x__getUser"),
          ],
          "stop",
        ),
      ),
    ];

    const notice = noticeOf(translate(lines, { ...facts, tools: ["read", "bash"] }));

    expect(notice).toContain("Tools this Session lacks");
    expect(notice).toContain("laptop_00");
    expect(notice).toContain(`laptop_${String(NOTICE_TOOL_LIMIT - 1)}`);
    expect(notice).not.toContain(`laptop_${String(NOTICE_TOOL_LIMIT)}`);
    expect(notice).toContain("and 5 more");
    expect(notice).toContain("you can't call them here");
    expect(notice).not.toContain("mcp__x__get_user,");
    expect(notice).not.toMatch(/lacks[^.]*\bread\b/u);

    // With the Session's tools not known, nothing is said of them.
    expect(noticeOf(translate(lines))).not.toContain("Tools this Session lacks");
  });
});
