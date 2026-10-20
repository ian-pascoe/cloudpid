import { EMPTY_VIEW, type SessionView, type TranscriptMessage } from "@cloudpid/protocol";
import { describe, expect, it } from "vitest";
import { toThreadMessages } from "./thread-messages.ts";

const user = (id: string, text: string): TranscriptMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
  timestamp: 1,
});

const assistant = (
  id: string,
  parts: TranscriptMessage["parts"],
  extra: Partial<TranscriptMessage> = {},
): TranscriptMessage => ({ id, role: "assistant", parts, timestamp: 2, ...extra });

const result = (callId: string, text: string, error = false): TranscriptMessage => ({
  id: `r-${callId}`,
  role: "tool",
  timestamp: 3,
  parts: [
    {
      type: "tool-result",
      id: callId,
      name: "roll_dice",
      content: [{ type: "text", text }],
      error,
    },
  ],
});

const view = (change: Partial<SessionView>): SessionView => ({ ...EMPTY_VIEW, ...change });

describe("the thread messages of a view", () => {
  it("is empty for an empty view", () => {
    expect(toThreadMessages(EMPTY_VIEW)).toEqual([]);
  });

  it("maps a user message and an answer with thinking", () => {
    const messages = toThreadMessages(
      view({
        messages: [
          user("1", "hi"),
          assistant("2", [
            { type: "thinking", text: "hm" },
            { type: "text", text: "Hello" },
          ]),
        ],
      }),
    );

    expect(messages).toMatchObject([
      { id: "1", role: "user", content: [{ type: "text", text: "hi" }] },
      {
        id: "1:reply",
        role: "assistant",
        content: [
          { type: "reasoning", text: "hm" },
          { type: "text", text: "Hello" },
        ],
        status: { type: "complete", reason: "stop" },
      },
    ]);
  });

  it("maps an image in a user message to a data URL", () => {
    const [message] = toThreadMessages(
      view({
        messages: [
          {
            id: "1",
            role: "user",
            timestamp: 1,
            parts: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
          },
        ],
      }),
    );

    expect(message?.content).toEqual([{ type: "image", image: "data:image/png;base64,AAAA" }]);
  });

  it("merges a tool-calling answer, its results, and the answer that follows into one assistant message", () => {
    const messages = toThreadMessages(
      view({
        messages: [
          user("1", "roll"),
          assistant(
            "2",
            [{ type: "tool-call", id: "c1", name: "roll_dice", arguments: { sides: 6 } }],
            {
              stopReason: "toolUse",
            },
          ),
          result("c1", "4"),
          assistant("4", [{ type: "text", text: "You rolled a 4" }]),
        ],
      }),
    );

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      id: "1:reply",
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "c1",
          toolName: "roll_dice",
          args: { sides: 6 },
          result: "4",
        },
        { type: "text", text: "You rolled a 4" },
      ],
    });
  });

  it("marks a failed tool call", () => {
    const [, message] = toThreadMessages(
      view({
        messages: [
          user("1", "roll"),
          assistant("2", [{ type: "tool-call", id: "c1", name: "roll_dice", arguments: {} }]),
          result("c1", "no dice", true),
        ],
      }),
    );

    expect(message?.content).toMatchObject([
      { type: "tool-call", result: "no dice", isError: true },
    ]);
  });

  it("gives a running tool call its streamed output, and no result yet", () => {
    const [, message] = toThreadMessages(
      view({
        running: true,
        messages: [
          user("1", "run"),
          assistant("2", [{ type: "tool-call", id: "c1", name: "bash", arguments: { cmd: "ls" } }]),
        ],
        tools: [{ callId: "c1", name: "bash", output: "file-a\n" }],
      }),
    );

    const part = message?.content[0];

    expect(part).toMatchObject({
      type: "tool-call",
      toolCallId: "c1",
      artifact: { output: "file-a\n" },
    });
    expect(part).not.toHaveProperty("result");
  });

  it("shows the calls a running script made under its tool call, not under another's", () => {
    const [, message] = toThreadMessages(
      view({
        running: true,
        messages: [
          user("1", "run"),
          assistant("2", [
            { type: "tool-call", id: "c1", name: "codemode", arguments: { code: "x" } },
            { type: "tool-call", id: "c2", name: "bash", arguments: { command: "ls" } },
          ]),
        ],
        tools: [
          { callId: "c1", name: "codemode", output: "" },
          { callId: "c2", name: "bash", output: "" },
        ],
        nestedTools: [
          {
            callId: "c1/c1",
            parentCallId: "c1",
            name: "read",
            args: { path: "a.txt" },
            output: "",
            status: "done",
            isError: false,
            durationMs: 5,
          },
          {
            callId: "c1/c2",
            parentCallId: "c1",
            name: "grep",
            args: { pattern: "x" },
            output: "",
            status: "running",
            isError: false,
          },
        ],
      }),
    );

    expect(message?.content[0]).toMatchObject({
      artifact: {
        nested: [
          { id: "c1/c1", name: "read", args: { path: "a.txt" }, status: "ok", durationMs: 5 },
          { id: "c1/c2", name: "grep", args: { pattern: "x" }, status: "running" },
        ],
      },
    });
    expect(message?.content[1]).toMatchObject({ artifact: { nested: [] } });
  });

  it("lists the calls a finished script made, from the details of its result", () => {
    const [, message] = toThreadMessages(
      view({
        messages: [
          user("1", "run"),
          assistant("2", [{ type: "tool-call", id: "c1", name: "codemode", arguments: {} }]),
          {
            id: "r",
            role: "tool",
            timestamp: 3,
            parts: [
              {
                type: "tool-result",
                id: "c1",
                name: "codemode",
                content: [{ type: "text", text: "Script completed" }],
                error: false,
                details: {
                  calls: [
                    { id: 1, name: "read", args: '{"path":"a.txt"}', status: "ok", durationMs: 3 },
                    {
                      id: 2,
                      name: "bash",
                      args: '{"command":"ls"}',
                      status: "error",
                      error: "boom",
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );

    expect(message?.content[0]).toMatchObject({
      result: "Script completed",
      artifact: {
        nested: [
          { id: "1", name: "read", args: { path: "a.txt" }, status: "ok", durationMs: 3 },
          { id: "2", name: "bash", args: { command: "ls" }, status: "error", error: "boom" },
        ],
      },
    });
  });

  it("appends the live message to the answer in progress, or starts one", () => {
    const live = assistant("live", [{ type: "text", text: "Hel" }]);

    const started = toThreadMessages(view({ running: true, messages: [user("1", "hi")], live }));

    expect(started).toHaveLength(2);
    expect(started[1]).toMatchObject({
      id: "1:reply",
      content: [{ type: "text", text: "Hel" }],
      status: { type: "running" },
    });

    const continued = toThreadMessages(
      view({
        running: true,
        messages: [
          user("1", "roll"),
          assistant("2", [{ type: "tool-call", id: "c1", name: "roll_dice", arguments: {} }]),
          result("c1", "4"),
        ],
        live,
      }),
    );

    expect(continued).toHaveLength(2);
    expect(continued[1]).toMatchObject({ id: "1:reply", status: { type: "running" } });
    expect(continued[1]?.content).toMatchObject([
      { type: "tool-call" },
      { type: "text", text: "Hel" },
    ]);
  });

  it("marks the last assistant message running while a run is in progress, even between messages", () => {
    const [, message] = toThreadMessages(
      view({
        running: true,
        messages: [user("1", "hi"), assistant("2", [{ type: "text", text: "a" }])],
      }),
    );

    expect(message?.status).toEqual({ type: "running" });
  });

  it("shows a failed answer as incomplete with its error, and an aborted one as cancelled", () => {
    const messages = toThreadMessages(
      view({
        messages: [
          user("1", "hi"),
          assistant("2", [], { stopReason: "error", error: "upstream failed" }),
          user("3", "again"),
          assistant("4", [{ type: "text", text: "partial" }], { stopReason: "aborted" }),
        ],
      }),
    );

    expect(messages[1]?.status).toEqual({
      type: "incomplete",
      reason: "error",
      error: "upstream failed",
    });
    expect(messages[3]?.status).toEqual({ type: "incomplete", reason: "cancelled" });
  });

  it("gives a turn the same id while it streams and after it is committed, so assistant-ui keeps its message", () => {
    const streaming = toThreadMessages(
      view({
        running: true,
        messages: [user("1", "hi")],
        live: assistant("live", [{ type: "text", text: "Hel" }]),
      }),
    );

    const committed = toThreadMessages(
      view({
        running: true,
        messages: [user("1", "hi"), assistant("2", [{ type: "text", text: "Hello" }])],
      }),
    );

    expect(streaming[1]?.id).toBe("1:reply");
    expect(committed[1]?.id).toBe(streaming[1]?.id);
  });

  it("names a turn with no user message before it", () => {
    const [message] = toThreadMessages(
      view({ messages: [assistant("2", [{ type: "text", text: "Hello" }])] }),
    );

    expect(message?.id).toBe("start:reply");
  });

  it("hands out the same messages for the finished turns of the next view, and rebuilds only the last", () => {
    const messages = [
      user("1", "a"),
      assistant("2", [{ type: "text", text: "A" }]),
      user("3", "b"),
      assistant("4", [{ type: "text", text: "B" }]),
    ];

    const before = toThreadMessages(view({ running: true, messages }));

    const after = toThreadMessages(
      view({
        running: true,
        messages: [...messages, assistant("5", [{ type: "text", text: "more" }])],
      }),
    );

    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
    expect(after[3]).not.toBe(before[3]);
    expect(after[3]?.content).toHaveLength(2);
  });

  it("rebuilds a finished turn when its messages are not the same ones", () => {
    const first = toThreadMessages(
      view({
        messages: [user("1", "a"), assistant("2", [{ type: "text", text: "A" }]), user("3", "b")],
      }),
    );

    const second = toThreadMessages(
      view({
        messages: [user("1", "a"), assistant("2", [{ type: "text", text: "A" }]), user("3", "b")],
      }),
    );

    expect(second[1]).not.toBe(first[1]);
    expect(second[1]).toEqual(first[1]);
  });

  it("shows a notice as a system message between turns, titled by what happened", () => {
    const messages = toThreadMessages(
      view({
        messages: [
          user("1", "go"),
          assistant("2", [{ type: "text", text: "Working." }]),
          {
            id: "3",
            role: "notice",
            title: "Rollover requested",
            timestamp: 3,
            parts: [{ type: "text", text: "Prepare a Context Rollover" }],
          },
          assistant("4", [{ type: "text", text: "Saving Notes." }]),
          { id: "5", role: "notice", title: "Context reset", timestamp: 0, parts: [] },
        ],
      }),
    );

    expect(messages).toMatchObject([
      { id: "1", role: "user" },
      { id: "1:reply", role: "assistant", content: [{ type: "text", text: "Working." }] },
      {
        id: "3",
        role: "system",
        content: [{ type: "text", text: "Prepare a Context Rollover" }],
        metadata: { custom: { title: "Rollover requested" } },
      },
      { id: "3:reply", role: "assistant", content: [{ type: "text", text: "Saving Notes." }] },
      {
        id: "5",
        role: "system",
        content: [{ type: "text", text: "" }],
        metadata: { custom: { title: "Context reset" } },
      },
    ]);
  });
});
