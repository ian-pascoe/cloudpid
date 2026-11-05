// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off asyncFunction:off -- plain TypeScript over pi's arrays, as the example is.

import { diffRevisions } from "@earendil-works/chord/delta";
import type { ConversationView, EntryQuery, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { pageBlock } from "./attached-pages.ts";
import { ConversationMirror } from "./mirror.ts";
import type { EntriesPage } from "./session.ts";
import { projectEntries } from "./transcript.ts";
import { skillBlock } from "./user-entry.ts";
import { EMPTY_VIEW, type SessionView } from "./view.ts";

/** The parts of pi's shapes a fixture sets. */
type FixtureValue =
  | string
  | number
  | boolean
  | null
  | EntryRecord
  | readonly FixtureValue[]
  | { readonly [key: string]: FixtureValue };

type Fixture = { readonly [key: string]: FixtureValue };

// The views and entries below are the parts of pi's shapes the projection reads.
// SAFETY: a fixture holds only the fields the projection reads; the other fields of pi's types are never looked at.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const asEntry = (entry: Fixture): EntryRecord => entry as unknown as EntryRecord;

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const user = (id: number, text: string) =>
  asEntry({
    id,
    conversationId: 1,
    kind: "pi.user",
    model: [{ role: "user", content: text, timestamp: id }],
  });

const assistantMessage = (content: Fixture[], extra: Fixture = {}) => ({
  role: "assistant",
  content,
  api: "",
  provider: "p",
  model: "m",
  usage,
  stopReason: "stop",
  timestamp: 2,
  ...extra,
});

const assistant = (id: number, content: Fixture[], extra: Fixture = {}) =>
  asEntry({
    id,
    conversationId: 1,
    kind: "pi.assistant",
    model: [assistantMessage(content, extra)],
  });

const toolResult = (id: number, callId: string, text: string, isError = false) =>
  asEntry({
    id,
    conversationId: 1,
    kind: "pi.tool",
    model: [
      {
        role: "toolResult",
        toolCallId: callId,
        toolName: "roll_dice",
        content: [{ type: "text", text }],
        isError,
        timestamp: id,
      },
    ],
  });

/** A conversation view's fixture, built a field at a time. */
type ViewFixture = {
  conversation: Fixture;
  entries: readonly EntryRecord[];
  before?: number;
  docs: { "pi.live": Fixture; "pi.inbox"?: Fixture; "pi.agent"?: Fixture };
};

/** pi's conversation view: a window of `entries` and the documents, as a watch sends it. */
const conversationView = ({
  entries = [],
  before,
  live = {},
  inbox,
  agent,
}: {
  readonly entries?: readonly EntryRecord[];
  readonly before?: number;
  readonly live?: Fixture;
  readonly inbox?: Fixture;
  readonly agent?: Fixture;
}): ConversationView => {
  const docs: ViewFixture["docs"] = { "pi.live": live };

  if (inbox !== undefined) docs["pi.inbox"] = inbox;

  if (agent !== undefined) docs["pi.agent"] = agent;

  const view: ViewFixture = { conversation: { id: 1 }, entries, docs };

  if (before !== undefined) view.before = before;

  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- SAFETY: as `asEntry`: the fixture holds what the projection and the transcript read.
  return view as unknown as ConversationView;
};

/** What a loader was asked, and the pages it answers with, in order. */
const loader = (...pages: EntriesPage[]) => {
  const asked: { readonly query: Omit<EntryQuery, "conversationId">; readonly limit: number }[] =
    [];

  const load = (query: Omit<EntryQuery, "conversationId">, limit: number) => {
    asked.push({ query, limit });

    const page = pages.shift();

    return page === undefined ? Promise.reject(new Error("no page")) : Promise.resolve(page);
  };

  return { asked, load };
};

/** A mirror that was sent `views` in turn: the first as a `view`, each later one as the ops that make it. */
const watched = (views: readonly ConversationView[], load = loader().load) => {
  const mirror = new ConversationMirror(load);
  let last: ConversationView | undefined;

  for (const view of views) {
    mirror.receive(
      last === undefined
        ? { type: "view", view }
        : // SAFETY: a fixture view is JSON.
          { type: "ops", ops: diffRevisions(last as never, view as never) },
    );
    last = view;
  }

  return mirror;
};

/** What a client shows after watching `views` in turn. */
const shown = (...views: ConversationView[]): SessionView => watched(views).view();

const ids = (messages: SessionView["messages"]) => messages.map((message) => message.id);

describe("the session view", () => {
  it("is empty before any view", () => {
    expect(new ConversationMirror(loader().load).view()).toEqual(EMPTY_VIEW);
  });

  it("streams an answer: thinking, then text, then the committed entry replaces the live message", () => {
    const run = { taskId: 1, inputs: [1], turns: 0 };
    const asked = conversationView({ entries: [user(1, "hi")], live: { run } });

    const streamed = conversationView({
      entries: [user(1, "hi")],
      live: {
        run,
        generation: {
          attempt: 1,
          message: assistantMessage([
            { type: "thinking", thinking: "Let me think" },
            { type: "text", text: "Hello" },
          ]),
        },
      },
    });

    const answered = conversationView({
      entries: [
        user(1, "hi"),
        assistant(2, [
          { type: "thinking", thinking: "Let me think" },
          { type: "text", text: "Hello" },
        ]),
      ],
    });

    const streaming = shown(asked, streamed);

    expect(streaming.running).toBe(true);
    expect(streaming.live?.parts).toEqual([
      { type: "thinking", text: "Let me think" },
      { type: "text", text: "Hello" },
    ]);
    expect(streaming.messages.map((message) => message.role)).toEqual(["user"]);

    const done = shown(asked, streamed, answered);

    expect(done.live).toBeNull();
    expect(done.running).toBe(false);
    expect(ids(done.messages)).toEqual(["1", "2"]);
    expect(done.messages[1]?.parts).toEqual(streaming.live?.parts);
  });

  it("keeps the messages, the same array, while only the live message changes", () => {
    const idle = conversationView({ entries: [user(1, "hi")] });

    const streaming = conversationView({
      entries: [user(1, "hi")],
      live: { generation: { attempt: 1, message: assistantMessage([]) } },
    });

    const mirror = watched([idle]);
    const before = mirror.view();

    // SAFETY: a fixture view is JSON.
    mirror.receive({ type: "ops", ops: diffRevisions(idle as never, streaming as never) });

    const after = mirror.view();

    expect(after).not.toBe(before);
    expect(after.messages).toBe(before.messages);
    expect(mirror.view()).toBe(after);
  });

  it("keeps the live arguments of an App tool's call, and none of any other tool's", () => {
    const streaming = (name: string) =>
      conversationView({
        live: {
          generation: {
            attempt: 1,
            message: assistantMessage([
              {
                type: "toolCall",
                id: "c1",
                name,
                arguments: { title: "Hello", rows: ["abc"] },
              },
            ]),
          },
        },
      });

    const apps = new Set(["mcp__docs__page"]);

    const view = (name: string, streamed?: ReadonlySet<string>) =>
      watched([streaming(name)]).view(streamed).live?.parts;

    expect(view("mcp__docs__page", apps)).toEqual([
      {
        type: "tool-call",
        id: "c1",
        name: "mcp__docs__page",
        arguments: { title: "Hello", rows: ["abc"] },
      },
    ]);

    // Another tool's, and every tool's before the page knows the App tools, show none until the message is committed.
    expect(view("mcp__docs__other", apps)?.[0]).toMatchObject({ arguments: {} });
    expect(view("mcp__docs__page")?.[0]).toMatchObject({ arguments: {} });
  });

  it("tracks a running tool's output until it is done, and leaves out a call that has not started", () => {
    const round = (tools: Fixture[]) => conversationView({ live: { tools } });

    const running = shown(
      round([{ callId: "c1", name: "roll_dice", status: "pending" }]),
      round([{ callId: "c1", name: "roll_dice", status: "running", output: "abcdef" }]),
      round([{ callId: "c1", name: "roll_dice", status: "running", output: "cdefgh" }]),
    );

    expect(running.tools).toEqual([{ callId: "c1", name: "roll_dice", output: "cdefgh" }]);
    expect(shown(round([{ callId: "c1", name: "roll_dice", status: "pending" }])).tools).toEqual(
      [],
    );

    expect(
      shown(
        round([{ callId: "c1", name: "roll_dice", status: "running", output: "x" }]),
        round([{ callId: "c1", name: "roll_dice", status: "done", entry: 3 }]),
      ).tools,
    ).toEqual([]);

    // A call to a tool its request did not offer never runs: it is pending, then done with its error result.
    expect(
      shown(round([{ callId: "c2", name: "nope", status: "pending", unoffered: true }])).tools,
    ).toEqual([]);
  });

  it("shows the nested calls of the running tools, running and done, and not those not started", () => {
    const slot = (extra: Fixture) => ({
      parentCallId: "c1",
      parentTaskId: 1,
      taskId: 2,
      ...extra,
    });

    const view = shown(
      conversationView({
        live: {
          tools: [{ callId: "c1", name: "codemode", status: "running" }],
          nestedTools: [
            slot({
              callId: "c1/c1",
              name: "read",
              status: "done",
              output: "left over",
              arguments: { path: "a.txt" },
              summary: { isError: false, durationMs: 12 },
            }),
            slot({
              callId: "c1/c2",
              name: "bash",
              status: "running",
              output: "partial",
              arguments: { command: "ls" },
            }),
            slot({
              callId: "c1/c3",
              name: "grep",
              status: "done",
              arguments: { pattern: "x" },
              summary: { isError: true, error: "no such file" },
            }),
            // A call that faulted or was orphaned is done without a summary: it did not succeed.
            slot({ callId: "c1/c4", name: "bash", status: "done", arguments: {} }),
            slot({ callId: "c1/c5", name: "bash", status: "pending", arguments: {} }),
          ],
        },
      }),
    );

    // A nested call belongs to the call that made it, not to the running tools.
    expect(view.tools.map((tool) => tool.callId)).toEqual(["c1"]);
    expect(view.nestedTools).toEqual([
      {
        callId: "c1/c1",
        parentCallId: "c1",
        name: "read",
        args: { path: "a.txt" },
        output: "",
        status: "done",
        isError: false,
        durationMs: 12,
      },
      {
        callId: "c1/c2",
        parentCallId: "c1",
        name: "bash",
        args: { command: "ls" },
        output: "partial",
        status: "running",
        isError: false,
      },
      {
        callId: "c1/c3",
        parentCallId: "c1",
        name: "grep",
        args: { pattern: "x" },
        output: "",
        status: "done",
        isError: true,
        error: "no such file",
      },
      {
        callId: "c1/c4",
        parentCallId: "c1",
        name: "bash",
        args: {},
        output: "",
        status: "done",
        isError: true,
      },
    ]);
  });

  it("keeps the inbox's items, so a steer and a follow-up can be told apart, and places a steer's entry", () => {
    const queued = [
      { id: 1, mode: "steer", content: "actually, make it 20" },
      { id: 2, mode: "followUp", content: "then 30" },
    ];

    const waiting = conversationView({ inbox: { items: queued } });

    expect(shown(waiting).inbox).toEqual(queued);

    const placed = shown(
      waiting,
      conversationView({
        entries: [user(3, "actually, make it 20")],
        inbox: { items: [queued[1] ?? {}] },
      }),
    );

    expect(placed.inbox.map((item) => item.mode)).toEqual(["followUp"]);
    expect(placed.messages.map((message) => message.parts)).toEqual([
      [{ type: "text", text: "actually, make it 20" }],
    ]);
  });

  it("shows a retry until it ends", () => {
    const retrying = conversationView({
      live: { generation: { attempt: 2, retry: { at: 5, error: "overloaded" } } },
    });

    expect(shown(retrying).retry).toEqual({ at: 5, error: "overloaded" });
    expect(shown(retrying, conversationView({ live: { generation: { attempt: 2 } } })).retry).toBe(
      null,
    );
  });

  it("reports why a run ended without an answer, but not an abort the owner asked for", () => {
    const failed = (runFailure: Fixture) => conversationView({ live: { runFailure } });

    expect(
      shown(failed({ taskId: 1, inputs: [1], reason: "model_error", detail: "boom" })).error,
    ).toBe("Not answered: model_error: boom");
    expect(shown(failed({ taskId: 1, inputs: [1], reason: "no_model" })).error).toBe(
      "Not answered: no_model",
    );
    expect(shown(failed({ taskId: 1, inputs: [1], reason: "aborted" })).error).toBeNull();

    // A later run removes it.
    expect(
      shown(
        failed({ taskId: 1, inputs: [1], reason: "faulted", detail: "x" }),
        conversationView({ live: { run: { taskId: 2, inputs: [2], turns: 0 } } }),
      ).error,
    ).toBeNull();
  });

  it("follows the agent's model and thinking level", () => {
    const model = { provider: "p", modelId: "m" };

    expect(shown(conversationView({ agent: { model } })).model).toEqual(model);
    expect(EMPTY_VIEW.thinkingLevel).toBeNull();
    expect(shown(conversationView({ agent: { thinkingLevel: "low" } })).thinkingLevel).toBe("low");
    expect(
      shown(conversationView({ agent: { thinkingLevel: "low" } }), conversationView({ agent: {} }))
        .thinkingLevel,
    ).toBeNull();
  });

  it("gives a client that reloads mid-run the view a client that watched the whole run has", () => {
    const run = { taskId: 1, inputs: [1], turns: 0 };
    const call = { type: "toolCall", id: "c1", name: "roll_dice", arguments: { sides: 6 } };

    const steps = [
      conversationView({}),
      conversationView({ entries: [user(1, "roll")], live: { run } }),
      conversationView({
        entries: [user(1, "roll")],
        live: { run, generation: { attempt: 1, message: assistantMessage([call]) } },
      }),
      conversationView({
        entries: [user(1, "roll"), assistant(2, [call])],
        live: { run, tools: [{ callId: "c1", name: "roll_dice", status: "running" }] },
      }),
      conversationView({
        entries: [user(1, "roll"), assistant(2, [call])],
        live: {
          run,
          tools: [{ callId: "c1", name: "roll_dice", status: "running", output: "rolling" }],
        },
      }),
    ];

    const reloaded = shown(steps.at(-1) ?? conversationView({}));

    expect(reloaded).toEqual(shown(...steps));
    expect(reloaded.tools).toEqual([{ callId: "c1", name: "roll_dice", output: "rolling" }]);
  });

  it("leaves out system prompts and bookkeeping entries", () => {
    const view = shown(
      conversationView({
        entries: [
          user(1, "roll"),
          assistant(2, [
            { type: "toolCall", id: "c1", name: "roll_dice", arguments: { sides: 6 } },
          ]),
          toolResult(3, "c1", "4"),
          asEntry({ id: 4, conversationId: 1, kind: "pi.system", model: [{ role: "system" }] }),
          asEntry({ id: 5, conversationId: 1, kind: "other.bookkeeping" }),
        ],
      }),
    );

    expect(view.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
  });

  describe("earlier Context Windows", () => {
    const reset = (id: number) =>
      asEntry({
        id,
        conversationId: 1,
        kind: "pi.reset",
        head: id,
        model: [{ role: "user", content: "handoff", timestamp: id }],
      });

    const compaction = (id: number, head: number) =>
      asEntry({
        id,
        conversationId: 1,
        kind: "pi.compaction",
        head,
        model: [{ role: "user", content: "summary", timestamp: id }],
      });

    it("shows the messages before a Handoff and a compaction, with each marker where it was written", () => {
      const view = shown(
        conversationView({
          entries: [
            user(1, "old"),
            reset(2),
            user(3, "a"),
            user(4, "b"),
            compaction(5, 4),
            user(6, "new"),
          ],
        }),
      );

      expect(ids(view.messages)).toEqual(["1", "2", "3", "4", "5", "6"]);
      expect(view.messages.map((message) => message.title)).toEqual([
        undefined,
        "Handoff",
        undefined,
        undefined,
        "Context compacted",
        undefined,
      ]);
      expect(view.earlier).toBe(false);
    });

    it("keeps the entries the window drops as it moves on", () => {
      const view = shown(
        conversationView({ entries: [user(1, "a"), user(2, "b")] }),
        conversationView({ entries: [user(2, "b"), user(3, "c")], before: 1 }),
        conversationView({ entries: [user(3, "c"), user(4, "d")], before: 2 }),
      );

      expect(ids(view.messages)).toEqual(["1", "2", "3", "4"]);
      expect(view.earlier).toBe(false);
    });

    it("offers the entries before its window, and loads them a page at a time in front", async () => {
      const pages = loader(
        { items: [user(4, "four"), reset(3)], next: {} },
        { items: [user(1, "one")] },
      );

      const mirror = watched(
        [conversationView({ entries: [reset(5), user(6, "new")], before: 4 })],
        pages.load,
      );

      expect(mirror.view().earlier).toBe(true);

      await mirror.loadEarlier();

      expect(pages.asked).toEqual([{ query: { maxEntryId: 4, order: "descending" }, limit: 50 }]);
      expect(ids(mirror.view().messages)).toEqual(["3", "4", "5", "6"]);
      expect(mirror.view().earlier).toBe(true);

      await mirror.loadEarlier();

      expect(pages.asked[1]?.query).toEqual({ maxEntryId: 2, order: "descending" });
      expect(ids(mirror.view().messages)).toEqual(["1", "3", "4", "5", "6"]);
      expect(mirror.view().earlier).toBe(false);

      // Nothing is left to load.
      await mirror.loadEarlier();

      expect(pages.asked).toHaveLength(2);
    });
  });

  describe("a watch that starts again", () => {
    it("continues the transcript from right after its newest entry", () => {
      const mirror = watched([conversationView({ entries: [user(1, "a"), user(2, "b")] })]);

      expect(mirror.from).toBe(3);

      // The new watch's window starts where the transcript ends: nothing is missing.
      mirror.receive({
        type: "view",
        view: conversationView({ entries: [user(3, "c")], before: 2 }),
      });

      expect(ids(mirror.view().messages)).toEqual(["1", "2", "3"]);
      expect(mirror.gapped).toBe(false);
    });

    it("fills the entries a reconnect skipped, a page at a time", async () => {
      const pages = loader(
        { items: [user(3, "c"), user(4, "d")], next: {} },
        { items: [user(5, "e")] },
      );

      const mirror = watched(
        [conversationView({ entries: [user(1, "a"), user(2, "b")] })],
        pages.load,
      );

      mirror.receive({
        type: "view",
        view: conversationView({ entries: [user(9, "i")], before: 8 }),
      });

      expect(mirror.gapped).toBe(true);
      expect(ids(mirror.view().messages)).toEqual(["1", "2", "9"]);

      await mirror.fillGap();

      expect(pages.asked[0]).toEqual({
        query: { minEntryId: 3, maxEntryId: 8, order: "ascending" },
        limit: 50,
      });
      expect(mirror.gapped).toBe(true);

      await mirror.fillGap();

      expect(pages.asked[1]?.query).toEqual({ minEntryId: 5, maxEntryId: 8, order: "ascending" });
      expect(ids(mirror.view().messages)).toEqual(["1", "2", "3", "4", "5", "9"]);
      expect(mirror.gapped).toBe(false);
    });

    it("says when operations do not apply, and drops the rest until the next view", () => {
      const mirror = watched([conversationView({ entries: [user(1, "a")] })]);
      const before = mirror.view();

      expect(mirror.receive({ type: "ops", ops: [["d", ["docs", "nowhere", "deeper"]]] })).toBe(
        false,
      );
      expect(
        mirror.receive({
          type: "ops",
          ops: [["s", ["docs", "pi.agent"], { thinkingLevel: "low" }]],
        }),
      ).toBe(true);
      expect(mirror.view()).toBe(before);

      mirror.receive({
        type: "view",
        view: conversationView({ entries: [user(1, "a")], agent: {} }),
      });

      expect(ids(mirror.view().messages)).toEqual(["1"]);
    });
  });
});

describe("the transcript projection", () => {
  it("shows an owner's message that got an MCP prompt as typed, with the block and its inline images beside it", () => {
    const [projected] = projectEntries([
      asEntry({
        id: 1,
        conversationId: 1,
        kind: "cloudpid.user",
        data: {
          display: "focus on tests",
          skills: [],
          mcpPrompt: {
            server: "github",
            command: "/mcp__github__review",
            name: "review",
            arguments: { pr: "1" },
            parts: [
              { role: "user", type: "text" },
              { role: "user", type: "image", mimeType: "image/png" },
              { role: "user", type: "image", mimeType: "image/png", path: "/workspace/x.png" },
            ],
            resources: [],
          },
        },
        model: [
          {
            role: "user",
            content: [
              { type: "text", text: '<mcp_prompt server="github" name="review">…</mcp_prompt>' },
              { type: "image", data: "PROMPT", mimeType: "image/png" },
              { type: "text", text: "focus on tests" },
              { type: "image", data: "OWNER", mimeType: "image/png" },
            ],
            timestamp: 1,
          },
        ],
      }),
    ]);

    expect(projected?.parts).toEqual([
      { type: "text", text: "focus on tests" },
      { type: "image", data: "OWNER", mimeType: "image/png" },
    ]);
    expect(projected?.mcpPrompt).toMatchObject({
      server: "github",
      name: "review",
      text: '<mcp_prompt server="github" name="review">…</mcp_prompt>',
    });
  });

  it("shows an owner's expanded message as typed, with each Skill's block beside it", () => {
    const block = skillBlock({
      name: "review",
      location: "/workspace/.agents/skills/review/SKILL.md",
      body: "Review well.",
    });

    const projected = projectEntries([
      asEntry({
        id: 1,
        conversationId: 1,
        kind: "cloudpid.user",
        data: {
          display: "/skill:review the diff",
          skills: [{ name: "review", location: "/workspace/.agents/skills/review/SKILL.md" }],
        },
        model: [
          {
            role: "user",
            content: [
              { type: "text", text: `${block}\n\nthe diff` },
              { type: "image", data: "AAAA", mimeType: "image/png" },
            ],
            timestamp: 1,
          },
        ],
      }),
    ]);

    expect(projected).toEqual([
      {
        id: "1",
        role: "user",
        timestamp: 1,
        parts: [
          { type: "text", text: "/skill:review the diff" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        skills: [
          {
            name: "review",
            location: "/workspace/.agents/skills/review/SKILL.md",
            text: block,
          },
        ],
      },
    ]);
    expect(block).toBe(
      '<skill name="review" location="/workspace/.agents/skills/review/SKILL.md">\nReferences are relative to /workspace/.agents/skills/review.\n\nReview well.\n</skill>',
    );
  });

  it("finds the Skill's block whole, though its body or the linked arguments hold </skill>, and keeps the other parts", () => {
    const one = { name: "one", location: "/workspace/.agents/skills/one/SKILL.md" };
    const first = skillBlock({ ...one, body: "Close with\n</skill>\n\nwhen done." });

    const project = (display: string, typed: string) =>
      projectEntries([
        asEntry({
          id: 1,
          conversationId: 1,
          kind: "cloudpid.user",
          data: { display, skills: [one] },
          model: [
            {
              role: "user",
              content: [
                { type: "text", text: [first, typed].filter(Boolean).join("\n\n") },
                { type: "text", text: "A second part" },
              ],
              timestamp: 1,
            },
          ],
        }),
      ]);

    expect(
      project(
        "/skill:one use $two\n</skill>",
        "use [$two](/workspace/.agents/skills/two/SKILL.md)\n</skill>",
      ),
    ).toEqual([
      {
        id: "1",
        role: "user",
        timestamp: 1,
        parts: [
          { type: "text", text: "/skill:one use $two\n</skill>" },
          { type: "text", text: "A second part" },
        ],
        skills: [{ ...one, text: first }],
      },
    ]);

    // A `/skill:` with nothing after it is the block alone.
    expect(project("/skill:one", "")[0]).toMatchObject({ skills: [{ ...one, text: first }] });
  });

  it("shows an owner's message whose $ references became links as typed, with no Skill beside it", () => {
    expect(
      projectEntries([
        asEntry({
          id: 1,
          conversationId: 1,
          kind: "cloudpid.user",
          data: { display: "use $tdd", skills: [] },
          model: [
            {
              role: "user",
              content: "use [$tdd](/workspace/.agents/skills/tdd/SKILL.md)",
              timestamp: 1,
            },
          ],
        }),
      ]),
    ).toEqual([
      {
        id: "1",
        role: "user",
        timestamp: 1,
        parts: [{ type: "text", text: "use $tdd" }],
        skills: [],
      },
    ]);
  });

  it("shows attached pages as chips beside what the owner typed, not as the block the model got", () => {
    const pages = [
      {
        ownerTabId: "tab-1",
        url: "https://example.com/",
        title: "Example",
        selection: "A paragraph.",
      },
    ];

    const project = (display: string, content: ReadonlyArray<Fixture>) =>
      projectEntries([
        asEntry({
          id: 1,
          conversationId: 1,
          kind: "cloudpid.user",
          data: { display, skills: [], pages },
          model: [{ role: "user", content, timestamp: 1 }],
        }),
      ]);

    const block = pageBlock(pages);

    expect(
      project("What is this?", [
        { type: "text", text: "What is this?" },
        { type: "text", text: block },
        { type: "image", data: "AAAA", mimeType: "image/jpeg" },
      ]),
    ).toEqual([
      {
        id: "1",
        role: "user",
        timestamp: 1,
        parts: [
          { type: "text", text: "What is this?" },
          { type: "image", data: "AAAA", mimeType: "image/jpeg" },
        ],
        skills: [],
        pages,
      },
    ]);

    // The owner typed nothing: the Attachment path stays the first text part, and only the block goes.
    expect(
      project("", [
        { type: "text", text: "@/workspace/.cloudpid/uploads/s/a.png" },
        { type: "text", text: block },
      ])[0]?.parts,
    ).toEqual([{ type: "text", text: "@/workspace/.cloudpid/uploads/s/a.png" }]);

    // Text the owner typed to look like a block is not mistaken for the Session's: the last one goes.
    expect(
      project(block, [
        { type: "text", text: block },
        { type: "text", text: block },
      ])[0]?.parts,
    ).toEqual([{ type: "text", text: block }]);
  });

  it("shows a cloudpid.user entry whose data it cannot read as the model's message", () => {
    expect(
      projectEntries([
        asEntry({
          id: 1,
          conversationId: 1,
          kind: "cloudpid.user",
          data: { display: 3 },
          model: [{ role: "user", content: "Expanded", timestamp: 1 }],
        }),
      ]),
    ).toEqual([
      { id: "1", role: "user", timestamp: 1, parts: [{ type: "text", text: "Expanded" }] },
    ]);
  });

  it("projects messages, tool calls and their results, and leaves out system and bookkeeping entries", () => {
    const projected = projectEntries([
      asEntry({
        id: 1,
        conversationId: 1,
        kind: "pi.user",
        model: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image", data: "AAAA", mimeType: "image/png" },
            ],
            timestamp: 1,
          },
        ],
      }),
      assistant(
        2,
        [
          { type: "thinking", thinking: "hm" },
          { type: "toolCall", id: "c1", name: "roll_dice", arguments: { sides: 6 } },
        ],
        { stopReason: "toolUse" },
      ),
      assistant(3, [], { stopReason: "error", errorMessage: "upstream failed" }),
      toolResult(4, "c1", "4", true),
      asEntry({ id: 5, conversationId: 1, kind: "pi.system", model: [{ role: "system" }] }),
    ]);

    expect(projected).toEqual([
      {
        id: "1",
        role: "user",
        timestamp: 1,
        parts: [
          { type: "text", text: "look" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      },
      {
        id: "2",
        role: "assistant",
        timestamp: 2,
        stopReason: "toolUse",
        parts: [
          { type: "thinking", text: "hm" },
          { type: "tool-call", id: "c1", name: "roll_dice", arguments: { sides: 6 } },
        ],
      },
      {
        id: "3",
        role: "assistant",
        timestamp: 2,
        stopReason: "error",
        error: "upstream failed",
        parts: [],
      },
      {
        id: "4",
        role: "tool",
        timestamp: 4,
        parts: [
          {
            type: "tool-result",
            id: "c1",
            name: "roll_dice",
            content: [{ type: "text", text: "4" }],
            error: true,
          },
        ],
      },
    ]);
  });

  it("projects Handoffs, compaction summaries, and extension entries with a notice title as notices, other inputs as user messages", () => {
    const projected = projectEntries([
      asEntry({ id: 1, conversationId: 1, kind: "pi.reset", head: 1 }),
      asEntry({
        id: 2,
        conversationId: 1,
        kind: "pi.reset",
        head: 2,
        model: [{ role: "user", content: "Context Window Handoff\n\nGo on.", timestamp: 2 }],
      }),
      asEntry({
        id: 3,
        conversationId: 1,
        kind: "pi.compaction",
        head: 1,
        data: { reason: "overflow" },
        model: [{ role: "user", content: [{ type: "text", text: "<summary>" }], timestamp: 3 }],
      }),
      asEntry({
        id: 4,
        conversationId: 1,
        kind: "cloudpid.context-prepare",
        data: { notice: "Rollover requested" },
        model: [{ role: "user", content: "Prepare a Context Rollover", timestamp: 4 }],
      }),
      asEntry({
        id: 5,
        conversationId: 1,
        kind: "cloudpid.context-continue",
        data: { notice: "Continued after the Handoff" },
        model: [{ role: "user", content: "Continue", timestamp: 5 }],
      }),
      asEntry({
        id: 6,
        conversationId: 1,
        kind: "cloudpid.agent-input",
        data: { from: "agent-1" },
        model: [{ role: "user", content: "A report", timestamp: 6 }],
      }),
    ]);

    expect(projected).toEqual([
      { id: "1", role: "notice", title: "Context reset", timestamp: 0, parts: [] },
      {
        id: "2",
        role: "notice",
        title: "Handoff",
        timestamp: 2,
        parts: [{ type: "text", text: "Context Window Handoff\n\nGo on." }],
      },
      {
        id: "3",
        role: "notice",
        title: "Context compacted (overflow)",
        timestamp: 3,
        parts: [{ type: "text", text: "<summary>" }],
      },
      {
        id: "4",
        role: "notice",
        title: "Rollover requested",
        timestamp: 4,
        parts: [{ type: "text", text: "Prepare a Context Rollover" }],
      },
      {
        id: "5",
        role: "notice",
        title: "Continued after the Handoff",
        timestamp: 5,
        parts: [{ type: "text", text: "Continue" }],
      },
      { id: "6", role: "user", timestamp: 6, parts: [{ type: "text", text: "A report" }] },
    ]);
  });
});
