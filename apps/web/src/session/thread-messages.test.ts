import { EMPTY_VIEW, type SessionView, type TranscriptMessage } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import { describe, expect, it } from "vitest";
import { answerOf, entriesOf, shownSkills, toThreadMessages } from "./thread-messages.ts";

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

  it("shows the earlier Context Windows first, a turn split across them made whole", () => {
    const messages = toThreadMessages(
      view({
        earlier: [
          user("1", "roll"),
          assistant("2", [{ type: "tool-call", id: "c1", name: "roll_dice", arguments: {} }]),
        ],
        messages: [
          result("c1", "4"),
          { id: "4", role: "notice", title: "Handoff", parts: [], timestamp: 4 },
          user("5", "again"),
        ],
      }),
    );

    expect(Arr.map(messages, (message) => message.id)).toEqual(["1", "1:reply", "4", "5"]);
    expect(messages[1]?.content).toMatchObject([{ type: "tool-call", result: "4" }]);
  });

  it("keeps the Skills the Session expanded into a user message, for its disclosures", () => {
    const [message] = toThreadMessages(
      view({
        messages: [
          {
            ...user("1", "/skill:deploy now"),
            skills: [{ name: "deploy", location: "/s/SKILL.md", text: "<skill>…</skill>" }],
          },
        ],
      }),
    );

    expect(message?.content).toEqual([{ type: "text", text: "/skill:deploy now" }]);
    expect(shownSkills(message?.metadata?.custom)).toEqual([
      { name: "deploy", text: "<skill>…</skill>" },
    ]);
    expect(toThreadMessages(view({ messages: [user("1", "hi")] }))[0]).not.toHaveProperty(
      "metadata",
    );
    expect(shownSkills(undefined)).toEqual([]);
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

  it("shows a user message's text parts (the typed text, its Attachments' paths) as one text, its images after", () => {
    const [message] = toThreadMessages(
      view({
        messages: [
          {
            id: "1",
            role: "user",
            timestamp: 1,
            parts: [
              { type: "text", text: "look" },
              { type: "text", text: "@/workspace/.cloudpid/uploads/s/a.png" },
              { type: "image", data: "AAAA", mimeType: "image/png" },
            ],
          },
        ],
      }),
    );

    expect(message?.content).toEqual([
      { type: "text", text: "look\n\n@/workspace/.cloudpid/uploads/s/a.png" },
      { type: "image", image: "data:image/png;base64,AAAA" },
    ]);
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

  it("keeps the entries a turn holds, where a Session branch may start in it, and the answer it ends with", () => {
    const messages = toThreadMessages(
      view({
        messages: [
          user("1", "roll"),
          assistant("2", [{ type: "tool-call", id: "c1", name: "roll_dice", arguments: {} }], {
            stopReason: "toolUse",
          }),
          { ...result("c1", "4"), id: "3" },
          assistant("4", [{ type: "text", text: "You rolled a 4" }]),
        ],
      }),
    );

    expect(entriesOf(messages[1]?.metadata?.custom)).toEqual([2, 3, 4]);
    expect(answerOf(messages[1]?.metadata?.custom)).toBe(4);
    expect(entriesOf(undefined)).toEqual([]);
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

  it("names the subagent a finished subagent call started, from the details of its result", () => {
    const spawned = {
      type: "tool-result",
      id: "c1",
      name: "subagent",
      content: [{ type: "text", text: "Spawned agent-1 (turn turn-1)" }],
      error: false,
    } as const;

    const subagent = (
      details: Extract<TranscriptMessage["parts"][number], { type: "tool-result" }>["details"],
    ) =>
      toThreadMessages(
        view({
          messages: [
            user("1", "delegate"),
            assistant("2", [
              { type: "tool-call", id: "c1", name: "subagent", arguments: { task: "look" } },
            ]),
            {
              id: "r",
              role: "tool",
              timestamp: 3,
              parts: [details === undefined ? spawned : { ...spawned, details }],
            },
          ],
        }),
      )[1]?.content[0];

    expect(subagent({ agent_id: "agent-1", conversation_id: 4 })).toMatchObject({
      result: "Spawned agent-1 (turn turn-1)",
      artifact: { subagent: { agentId: "agent-1", conversationId: 4 } },
    });
    // A result without them (a refused spawn) names none.
    expect(subagent({ error: "refused" })).not.toHaveProperty("artifact");
    expect(subagent(undefined)).not.toHaveProperty("artifact");
  });

  it("puts the Agent change a call made on its card: the field, and its values before and after", () => {
    const changed = (
      details: NonNullable<
        Extract<TranscriptMessage["parts"][number], { type: "tool-result" }>["details"]
      >,
    ) =>
      toThreadMessages(
        view({
          messages: [
            user("1", "set it"),
            assistant("2", [
              {
                type: "tool-call",
                id: "c1",
                name: "environment_variable_set",
                arguments: { name: "API_URL", value: "https://api.test", reason: "r" },
              },
            ]),
            {
              id: "r",
              role: "tool",
              timestamp: 3,
              parts: [
                {
                  type: "tool-result",
                  id: "c1",
                  name: "environment_variable_set",
                  content: [{ type: "text", text: "Set API_URL" }],
                  error: false,
                  details,
                },
              ],
            },
          ],
        }),
      )[1]?.content[0];

    const change = {
      environment: { id: "default", name: "Default" },
      field: "variables.API_URL",
      before: null,
      after: "https://api.test",
    };

    expect(changed({ agentChange: { id: 3, ...change }, own: true })).toMatchObject({
      artifact: { changes: [change] },
    });
    // A call that changed nothing has none.
    expect(changed({ unchanged: { field: "variables.API_URL" } })).not.toHaveProperty("artifact");

    // A `settings_*` call puts each setting it changed on its card, with no Environment.
    expect(
      changed({
        agentChanges: [
          { id: 1, field: "model", before: "a/b", after: "c/d" },
          { id: 2, field: "thinkingLevel", before: "high", after: "low" },
        ],
      }),
    ).toMatchObject({
      artifact: {
        changes: [
          { field: "model", before: "a/b", after: "c/d" },
          { field: "thinkingLevel", before: "high", after: "low" },
        ],
      },
    });
    expect(changed({ unchanged: ["model"], agentChanges: [] })).not.toHaveProperty("artifact");
  });

  it("puts the screenshots of a finished tool call on its card, besides its text", () => {
    const [, message] = toThreadMessages(
      view({
        messages: [
          user("1", "look"),
          assistant("2", [
            { type: "tool-call", id: "c1", name: "browser", arguments: { code: "x" } },
          ]),
          {
            id: "r",
            role: "tool",
            timestamp: 3,
            parts: [
              {
                type: "tool-result",
                id: "c1",
                name: "browser",
                content: [
                  { type: "text", text: "Screenshot attached." },
                  { type: "image", data: "AAAA", mimeType: "image/png" },
                  { type: "image", data: "PHN2Zz4=", mimeType: "image/svg+xml" },
                ],
                error: false,
              },
            ],
          },
        ],
      }),
    );

    expect(message?.content[0]).toMatchObject({
      result: "Screenshot attached.\n[image]\n[image]",
      artifact: { images: [{ mimeType: "image/png", data: "AAAA" }] },
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
