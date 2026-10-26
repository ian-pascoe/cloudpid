// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain TypeScript over pi's arrays, as the example is.

import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { pageBlock } from "./attached-pages.ts";
import { projectEntries } from "./transcript.ts";
import { skillBlock } from "./user-entry.ts";
import { EMPTY_VIEW, reduceEvents, reduceView, type SessionView, withEarlier } from "./view.ts";

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

// The events and entries below are the parts of pi's shapes the reducer reads.
// SAFETY: a fixture holds only the fields the reducer reads; the other fields of pi's types are never looked at.
const asEvent = (event: Fixture): AgentEvent => event as AgentEvent;

// SAFETY: a fixture holds only the fields the reducer reads; the other fields of pi's types are never looked at.
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

const snapshot = (extra: Fixture = {}) =>
  asEvent({
    type: "snapshot",
    entries: [],
    tools: [],
    nestedTools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: {},
    ...extra,
  });

const fold = (...events: AgentEvent[]): SessionView => reduceEvents(EMPTY_VIEW, events);

describe("the session view", () => {
  it("is empty before any event", () => {
    expect(fold()).toEqual(EMPTY_VIEW);
  });

  it("streams an answer: thinking, then text, then the committed entry replaces the live message", () => {
    const streaming = fold(
      asEvent({ type: "run_start", inputs: [1] }),
      asEvent({ type: "entry_appended", entry: user(1, "hi") }),
      asEvent({ type: "message_start", message: assistantMessage([]) }),
      asEvent({
        type: "message_update",
        usage,
        changes: [
          { type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "" } },
          { type: "thinking_delta", contentIndex: 0, delta: "Let me " },
          { type: "thinking_delta", contentIndex: 0, delta: "think" },
          { type: "text_start", contentIndex: 1, block: { type: "text", text: "" } },
          { type: "text_delta", contentIndex: 1, delta: "Hel" },
          { type: "text_delta", contentIndex: 1, delta: "lo" },
        ],
      }),
    );

    expect(streaming.running).toBe(true);
    expect(streaming.live?.parts).toEqual([
      { type: "thinking", text: "Let me think" },
      { type: "text", text: "Hello" },
    ]);
    expect(streaming.messages.map((message) => message.role)).toEqual(["user"]);

    const done = reduceView(
      streaming,
      asEvent({
        type: "message_end",
        entry: assistant(2, [
          { type: "thinking", thinking: "Let me think" },
          { type: "text", text: "Hello" },
        ]),
      }),
    );

    expect(done.live).toBeNull();
    expect(done.messages.map((message) => message.id)).toEqual(["1", "2"]);
    expect(done.messages[1]?.parts).toEqual(streaming.live?.parts);
  });

  it("replaces the live message with a whole one, and starts a block from a complete block", () => {
    const view = fold(
      asEvent({ type: "message_start", message: assistantMessage([]) }),
      asEvent({
        type: "message_update",
        usage,
        changes: [
          { type: "message", message: assistantMessage([{ type: "text", text: "so far" }]) },
          {
            type: "block",
            contentIndex: 1,
            block: { type: "toolCall", id: "c1", name: "roll_dice", arguments: { sides: 6 } },
          },
          { type: "toolcall_delta", contentIndex: 1, path: ["sides"], delta: "6" },
        ],
      }),
    );

    expect(view.live?.parts).toEqual([
      { type: "text", text: "so far" },
      { type: "tool-call", id: "c1", name: "roll_dice", arguments: { sides: 6 } },
    ]);
  });

  it("ignores updates when no message is live, and does not commit a user message as live", () => {
    expect(
      fold(
        asEvent({
          type: "message_update",
          usage,
          changes: [{ type: "text_delta", contentIndex: 0, delta: "x" }],
        }),
        asEvent({ type: "message_start", message: { role: "user", content: "x", timestamp: 1 } }),
      ).live,
    ).toBeNull();
  });

  it("tracks a running tool's output, trimming and replacing it, until it ends", () => {
    const call = { toolCallId: "c1", toolName: "roll_dice" };

    const running = fold(
      asEvent({ type: "tool_execution_start", args: {}, ...call }),
      asEvent({ type: "tool_execution_update", output: { append: "abcdef" }, ...call }),
      asEvent({ type: "tool_execution_update", output: { trimStart: 2, append: "gh" }, ...call }),
    );

    expect(running.tools).toEqual([{ callId: "c1", name: "roll_dice", output: "cdefgh" }]);

    expect(
      reduceView(
        running,
        asEvent({ type: "tool_execution_update", output: { set: "fresh" }, ...call }),
      ).tools[0]?.output,
    ).toBe("fresh");

    expect(reduceView(running, asEvent({ type: "tool_execution_end", ...call })).tools).toEqual([]);
  });

  it("leaves a nested call out of the running tools, and keeps it with the call that made it", () => {
    const view = fold(
      asEvent({
        type: "tool_execution_start",
        args: { path: "a.txt" },
        toolCallId: "c1/c1",
        toolName: "read",
        parentToolCallId: "c1",
      }),
    );

    expect(view.tools).toEqual([]);
    expect(view.nestedTools).toEqual([
      {
        callId: "c1/c1",
        parentCallId: "c1",
        name: "read",
        args: { path: "a.txt" },
        output: "",
        status: "running",
        isError: false,
      },
    ]);
  });

  it("shows the nested calls of a snapshot, running and done", () => {
    const view = fold(
      snapshot({
        nestedTools: [
          {
            callId: "c1/c1",
            parentCallId: "c1",
            name: "read",
            status: "done",
            arguments: { path: "a.txt" },
            summary: { isError: false, durationMs: 12 },
          },
          {
            callId: "c1/c2",
            parentCallId: "c1",
            name: "bash",
            status: "running",
            output: "partial",
            arguments: { command: "ls" },
          },
          {
            callId: "c1/c3",
            parentCallId: "c1",
            name: "grep",
            status: "done",
            arguments: { pattern: "x" },
            summary: { isError: true, error: "no such file" },
          },
        ],
      }),
    );

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
    ]);
  });

  it("follows a nested call's output and how it ended, until the call that made it ends", () => {
    const nested = { toolCallId: "c1/c1", toolName: "bash", parentToolCallId: "c1" };

    const running = fold(
      asEvent({ type: "tool_execution_start", args: {}, toolCallId: "c1", toolName: "codemode" }),
      asEvent({ type: "tool_execution_start", args: { command: "ls" }, ...nested }),
      asEvent({ type: "tool_execution_update", output: { append: "abc" }, ...nested }),
      asEvent({ type: "tool_execution_update", output: { append: "def" }, ...nested }),
    );

    expect(running.nestedTools[0]).toMatchObject({ output: "abcdef", status: "running" });

    const done = reduceView(
      running,
      asEvent({
        type: "tool_execution_end",
        result: { isError: true, durationMs: 40, diagnostics: [] },
        ...nested,
      }),
    );

    expect(done.nestedTools).toMatchObject([{ status: "done", isError: true, durationMs: 40 }]);
    // A finished nested call stays beside its siblings, and is not a running tool.
    expect(done.tools.map((tool) => tool.callId)).toEqual(["c1"]);

    // The call that made them settles with its own result, which lists them.
    const settled = reduceView(
      done,
      asEvent({ type: "tool_execution_end", toolCallId: "c1", toolName: "codemode" }),
    );

    expect(settled.nestedTools).toEqual([]);
    expect(settled.tools).toEqual([]);
  });

  describe("a nested call that ended live and in a snapshot", () => {
    const nested = { toolCallId: "c1/c1", toolName: "bash", parentToolCallId: "c1" };

    const slot = {
      callId: "c1/c1",
      parentCallId: "c1",
      name: "bash",
      arguments: { command: "ls" },
    };

    const live = (...events: Fixture[]) =>
      fold(
        asEvent({ type: "tool_execution_start", args: { command: "ls" }, ...nested }),
        asEvent({ type: "tool_execution_update", output: { append: "partial" }, ...nested }),
        ...events.map(asEvent),
      ).nestedTools;

    it("is the same call: no output, its duration, and its error text", () => {
      const ended = live({
        type: "tool_execution_end",
        result: {
          isError: true,
          durationMs: 40,
          diagnostics: [
            { severity: "info", message: "fyi" },
            { severity: "error", message: "boom" },
            { severity: "error", message: "bang" },
          ],
        },
        ...nested,
      });

      const listed = fold(
        snapshot({
          nestedTools: [
            {
              ...slot,
              status: "done",
              summary: { isError: true, durationMs: 40, error: "boom\nbang" },
            },
          ],
        }),
      ).nestedTools;

      expect(ended).toEqual(listed);
    });

    it("is a failure when it faulted or was orphaned, with no result and no summary", () => {
      const ended = live({ type: "tool_execution_end", ...nested });
      const listed = fold(snapshot({ nestedTools: [{ ...slot, status: "done" }] })).nestedTools;

      expect(ended).toEqual(listed);
      expect(ended[0]).toMatchObject({ status: "done", isError: true, output: "" });
    });

    it("has no error text when it succeeded, whatever its diagnostics say", () => {
      const [ended] = live({
        type: "tool_execution_end",
        result: { isError: false, diagnostics: [{ severity: "error", message: "late" }] },
        ...nested,
      });

      expect(ended).toMatchObject({ isError: false });
      expect(ended).not.toHaveProperty("error");
    });

    it("is not shown while a snapshot lists it as pending, as live shows nothing before it starts", () => {
      expect(fold(snapshot({ nestedTools: [{ ...slot, status: "pending" }] })).nestedTools).toEqual(
        [],
      );
    });
  });

  it("drops the nested calls of nested calls with their call, and the others at the end of the run", () => {
    const start = (toolCallId: string, parentToolCallId: string) =>
      asEvent({
        type: "tool_execution_start",
        args: {},
        toolCallId,
        toolName: "t",
        parentToolCallId,
      });

    const view = fold(start("c1/c1", "c1"), start("c1/c1/c1", "c1/c1"), start("c2/c1", "c2"));

    const ended = reduceView(
      view,
      asEvent({ type: "tool_execution_end", toolCallId: "c1", toolName: "t" }),
    );

    expect(ended.nestedTools.map((tool) => tool.callId)).toEqual(["c2/c1"]);
    expect(reduceView(view, asEvent({ type: "run_end", inputs: [1] })).nestedTools).toEqual([]);
  });

  it("keeps the inbox's items, so a steer and a follow-up can be told apart", () => {
    const queued = [
      { id: "s1", mode: "steer" },
      { id: "s2", mode: "followUp" },
    ];

    const view = fold(asEvent({ type: "inbox_update", items: queued }));

    expect(view.inbox).toEqual(queued);
    expect(reduceView(view, asEvent({ type: "inbox_update", items: [] })).inbox).toEqual([]);
  });

  it("places a queued steer in the transcript when pi appends its entry", () => {
    const view = fold(
      asEvent({ type: "inbox_update", items: [{ id: "s1", mode: "steer" }] }),
      asEvent({ type: "entry_appended", entry: user(3, "actually, make it 20") }),
      asEvent({ type: "inbox_update", items: [] }),
    );

    expect(view.inbox).toEqual([]);
    expect(view.messages.map((message) => message.parts)).toEqual([
      [{ type: "text", text: "actually, make it 20" }],
    ]);
  });

  it("does not append an entry twice", () => {
    const view = fold(
      asEvent({ type: "entry_appended", entry: user(1, "hi") }),
      asEvent({ type: "entry_appended", entry: user(1, "hi") }),
    );

    expect(view.messages).toHaveLength(1);
  });

  it("clears the run's progress at its end, and keeps the transcript", () => {
    const view = fold(
      asEvent({ type: "run_start", inputs: [1] }),
      asEvent({ type: "entry_appended", entry: user(1, "hi") }),
      asEvent({ type: "message_start", message: assistantMessage([]) }),
      asEvent({ type: "tool_execution_start", args: {}, toolCallId: "c1", toolName: "t" }),
      asEvent({ type: "auto_retry_start", attempt: 1, at: 5, errorMessage: "overloaded" }),
      asEvent({ type: "run_end", inputs: [1] }),
    );

    expect(view).toMatchObject({ running: false, live: null, tools: [], retry: null });
    expect(view.messages).toHaveLength(1);
  });

  it("shows a retry until it ends", () => {
    const retrying = fold(
      asEvent({ type: "auto_retry_start", attempt: 1, at: 5, errorMessage: "overloaded" }),
    );

    expect(retrying.retry).toEqual({ at: 5, error: "overloaded" });
    expect(reduceView(retrying, asEvent({ type: "auto_retry_end", attempt: 1 })).retry).toBeNull();
  });

  it("reports a failed task and an unanswered input, but not an abort the user asked for", () => {
    expect(
      fold(asEvent({ type: "task_failed", taskId: 1, kind: "run", message: "boom" })).error,
    ).toBe("boom");

    const record = (reason: string) =>
      asEvent({ type: "submission", record: { status: "unanswered", reason } });

    expect(fold(record("error")).error).toBe("Not answered: error");
    expect(fold(record("aborted")).error).toBeNull();
    expect(fold(record("withdrawn")).error).toBeNull();
    expect(
      reduceView(
        fold(asEvent({ type: "task_failed", taskId: 1, kind: "run", message: "boom" })),
        asEvent({ type: "run_start", inputs: [2] }),
      ).error,
    ).toBeNull();
  });

  it("follows the agent's model", () => {
    const model = { provider: "p", modelId: "m" };

    expect(fold(asEvent({ type: "agent_changed", agent: { model } })).model).toEqual(model);
  });

  it("follows the agent's thinking level", () => {
    expect(EMPTY_VIEW.thinkingLevel).toBeNull();
    expect(
      fold(asEvent({ type: "agent_changed", agent: { thinkingLevel: "low" } })).thinkingLevel,
    ).toBe("low");
    expect(fold(asEvent({ type: "agent_changed", agent: {} })).thinkingLevel).toBeNull();
  });

  describe("a snapshot", () => {
    const entries = [
      user(1, "roll"),
      assistant(2, [{ type: "toolCall", id: "c1", name: "roll_dice", arguments: { sides: 6 } }]),
      toolResult(3, "c1", "4"),
      asEntry({ id: 4, conversationId: 1, kind: "pi.system", model: [{ role: "system" }] }),
      asEntry({ id: 5, conversationId: 1, kind: "other.bookkeeping" }),
    ];

    it("replaces the view with the transcript, the live partial, the running tools, and the inbox", () => {
      const stale = fold(asEvent({ type: "task_failed", taskId: 1, kind: "run", message: "x" }));

      const view = reduceView(
        stale,
        snapshot({
          entries,
          run: { inputs: [1] },
          generation: {
            attempt: 1,
            message: assistantMessage([{ type: "text", text: "Thinking…" }]),
            retry: { at: 9, error: "slow" },
          },
          tools: [
            { callId: "c2", name: "roll_dice", status: "running", output: "so far" },
            { callId: "c1", name: "roll_dice", status: "done" },
          ],
          inbox: [{ id: "s1", mode: "followUp" }],
          agent: { model: { provider: "p", modelId: "m" }, thinkingLevel: "high" },
        }),
      );

      expect(view.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
      expect(view.running).toBe(true);
      expect(view.live?.parts).toEqual([{ type: "text", text: "Thinking…" }]);
      expect(view.tools).toEqual([{ callId: "c2", name: "roll_dice", output: "so far" }]);
      expect(view.inbox).toEqual([{ id: "s1", mode: "followUp" }]);
      expect(view.retry).toEqual({ at: 9, error: "slow" });
      expect(view.model).toEqual({ provider: "p", modelId: "m" });
      expect(view.thinkingLevel).toBe("high");
      expect(view.error).toBeNull();
    });

    it("gives a client that reloads mid-run the view a client that watched the whole run has", () => {
      const watched = fold(
        snapshot(),
        asEvent({ type: "run_start", inputs: [1] }),
        asEvent({ type: "entry_appended", entry: user(1, "roll") }),
        asEvent({
          type: "message_end",
          entry: assistant(2, [
            { type: "toolCall", id: "c1", name: "roll_dice", arguments: { sides: 6 } },
          ]),
        }),
        asEvent({
          type: "tool_execution_start",
          args: { sides: 6 },
          toolCallId: "c1",
          toolName: "roll_dice",
        }),
        asEvent({
          type: "tool_execution_update",
          output: { append: "rolling" },
          toolCallId: "c1",
          toolName: "roll_dice",
        }),
      );

      const reloaded = fold(
        snapshot({
          entries: [
            user(1, "roll"),
            assistant(2, [
              { type: "toolCall", id: "c1", name: "roll_dice", arguments: { sides: 6 } },
            ]),
          ],
          run: { inputs: [1] },
          tools: [{ callId: "c1", name: "roll_dice", status: "running", output: "rolling" }],
        }),
      );

      expect(reloaded).toEqual(watched);
    });

    it("shows only the active context after a reset", () => {
      const view = fold(
        asEvent({ type: "entry_appended", entry: user(1, "old") }),
        asEvent({
          type: "entry_appended",
          entry: asEntry({ id: 2, conversationId: 1, kind: "pi.reset", head: 2 }),
        }),
        asEvent({ type: "entry_appended", entry: user(3, "new") }),
      );

      expect(view.messages.map((message) => message.role)).toEqual(["notice", "user"]);
      expect(view.earlier.map((message) => message.id)).toEqual(["1"]);
      expect(view.before).toBeNull();
    });
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

    const ids = (messages: SessionView["messages"]) => messages.map((message) => message.id);

    it("moves what a compaction leaves out to earlier, and shows it as a snapshot would", () => {
      const live = fold(
        snapshot({ entries: [user(1, "a"), user(2, "b"), user(3, "c")] }),
        asEvent({ type: "entry_appended", entry: compaction(4, 3) }),
      );

      expect(ids(live.earlier)).toEqual(["1", "2"]);
      expect(ids(live.messages)).toEqual(["4", "3"]);
      expect(live.before).toBeNull();

      const reloaded = fold(snapshot({ entries: [compaction(4, 3), user(3, "c")] }));

      expect(reloaded.messages).toEqual(live.messages);
      expect(reloaded.earlier).toEqual([]);
      expect(reloaded.before).toBe(3);
    });

    it("keeps the earlier messages through a snapshot of a Context Window it saw start", () => {
      const live = fold(
        snapshot({ entries: [user(1, "old")] }),
        asEvent({ type: "entry_appended", entry: reset(2) }),
        asEvent({ type: "entry_appended", entry: user(3, "new") }),
      );

      const rewatched = reduceView(live, snapshot({ entries: [reset(2), user(3, "new")] }));

      expect(ids(rewatched.earlier)).toEqual(["1"]);
      expect(ids(rewatched.messages)).toEqual(["2", "3"]);
      expect(rewatched.before).toBeNull();
    });

    it("starts over from the marker's head when a snapshot's Context Window began out of sight", () => {
      const live = fold(snapshot({ entries: [user(1, "old")] }));
      const rewatched = reduceView(live, snapshot({ entries: [reset(5), user(6, "new")] }));

      expect(rewatched.earlier).toEqual([]);
      expect(rewatched.before).toBe(5);
    });

    it("adds a page of History in front, and only for the entries it was asked for", () => {
      const view = fold(snapshot({ entries: [reset(5), user(6, "new")] }));
      const page = { entries: [user(3, "three"), reset(4)], before: 3 };
      const loaded = withEarlier(view, 5, page);

      expect(ids(loaded.earlier)).toEqual(["3", "4"]);
      expect(loaded.before).toBe(3);
      // The same page again, or one for another `before`, is not added twice.
      expect(withEarlier(loaded, 5, page)).toBe(loaded);

      const rest = withEarlier(loaded, 3, { entries: [user(1, "one")], before: null });

      expect(ids(rest.earlier)).toEqual(["1", "3", "4"]);
      expect(rest.before).toBeNull();
    });
  });
});

describe("the transcript projection", () => {
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
