// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain TypeScript over pi's arrays, as the example is.

import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { projectEntries } from "./transcript.ts";
import { EMPTY_VIEW, reduceEvents, reduceView, type SessionView } from "./view.ts";

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

  it("leaves a nested call to the tool call that made it", () => {
    const view = fold(
      asEvent({
        type: "tool_execution_start",
        args: {},
        toolCallId: "c1/a",
        toolName: "inner",
        parentToolCallId: "c1",
      }),
    );

    expect(view.tools).toEqual([]);
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
          agent: { model: { provider: "p", modelId: "m" } },
        }),
      );

      expect(view.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
      expect(view.running).toBe(true);
      expect(view.live?.parts).toEqual([{ type: "text", text: "Thinking…" }]);
      expect(view.tools).toEqual([{ callId: "c2", name: "roll_dice", output: "so far" }]);
      expect(view.inbox).toEqual([{ id: "s1", mode: "followUp" }]);
      expect(view.retry).toEqual({ at: 9, error: "slow" });
      expect(view.model).toEqual({ provider: "p", modelId: "m" });
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
    });
  });
});

describe("the transcript projection", () => {
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
});
