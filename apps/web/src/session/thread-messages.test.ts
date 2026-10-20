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
        id: "2",
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
      id: "2",
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

  it("appends the live message to the answer in progress, or starts one", () => {
    const live = assistant("live", [{ type: "text", text: "Hel" }]);

    const started = toThreadMessages(view({ running: true, messages: [user("1", "hi")], live }));

    expect(started).toHaveLength(2);
    expect(started[1]).toMatchObject({
      id: "live",
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
    expect(continued[1]).toMatchObject({ id: "2", status: { type: "running" } });
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

  it("leaves notices out", () => {
    expect(
      toThreadMessages(
        view({
          messages: [
            {
              id: "n",
              role: "notice",
              timestamp: 0,
              parts: [{ type: "text", text: "Context reset" }],
            },
          ],
        }),
      ),
    ).toEqual([]);
  });
});
