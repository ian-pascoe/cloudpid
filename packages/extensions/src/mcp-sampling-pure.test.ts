// What a Sampling request is made of before and after the model (`docs/architecture/mcp-server-requests.md` → Sampling
// requests): the pairing rules, the content mapping, which Role answers, how `toolChoice` is spelled per API, and what the
// model's reply becomes. Goldens of #387 D4, D11, D14, D15.
// @effect-diagnostics preferEffectArray:off
import type { RoleName } from "@cloudpid/config";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  chooseRole,
  lowestAvailable,
  type RoleModel,
  toolChoiceFor,
} from "./mcp/sampling-model.ts";
import {
  decodeSamplingParams,
  type SamplingBlock,
  type SamplingMessage,
} from "./mcp/sampling-params.ts";
import {
  cutText,
  SAMPLING_RECORD_BYTES,
  SAMPLING_RECORDS_BYTES,
  type McpSamplingRecord,
  samplingRecords,
} from "./mcp/sampling-records.ts";
import { replyOf } from "./mcp/sampling-reply.ts";
import { SAMPLING_TEXT_MAX, pairingProblem, toPiMessages } from "./mcp/sampling-messages.ts";

const use = (id: string, name = "lookup"): SamplingMessage => ({
  role: "assistant",
  content: { type: "tool_use", id, name, input: { q: 1 } },
});

const result = (id: string): SamplingBlock => ({
  type: "tool_result",
  toolUseId: id,
  content: [{ type: "text", text: "found" }],
});

const user = (text: string): SamplingMessage => ({
  role: "user",
  content: { type: "text", text },
});

describe("pairingProblem", () => {
  it("accepts a plain conversation and a tool use answered in the next message", () => {
    expect(pairingProblem([user("hi")])).toBeUndefined();
    expect(
      pairingProblem([user("hi"), use("a"), { role: "user", content: result("a") }, user("ok")]),
    ).toBeUndefined();
    expect(
      pairingProblem([
        use("a"),
        { role: "user", content: [result("a")] },
        { role: "assistant", content: { type: "text", text: "done" } },
      ]),
    ).toBeUndefined();
  });

  it("refuses a tool_use from the user and a tool_result from the assistant", () => {
    expect(
      pairingProblem([
        { role: "user", content: { type: "tool_use", id: "a", name: "x", input: {} } },
      ]),
    ).toContain("tool_use belongs in an assistant message");
    expect(pairingProblem([{ role: "assistant", content: result("a") }])).toContain(
      "tool_result belongs in a user message",
    );
  });

  it("refuses a user message that mixes tool results with anything else", () => {
    expect(
      pairingProblem([
        use("a"),
        {
          role: "user",
          content: [result("a"), { type: "text", text: "and" }],
        },
      ]),
    ).toContain("holds only tool results");
  });

  it("refuses a tool_use not answered exactly once in the next message", () => {
    expect(pairingProblem([use("a")])).toContain('tool_use "a"');
    expect(pairingProblem([use("a"), user("hi")])).toContain('tool_use "a"');
    expect(
      pairingProblem([use("a"), { role: "user", content: [result("a"), result("a")] }]),
    ).toContain('tool_use "a"');
  });

  it("refuses a tool_result with no tool_use before it, or leaving one out", () => {
    expect(pairingProblem([{ role: "user", content: result("ghost") }])).toContain(
      'tool_result "ghost"',
    );
    expect(
      pairingProblem([
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "a", name: "x", input: {} },
            { type: "tool_use", id: "b", name: "x", input: {} },
          ],
        },
        { role: "user", content: result("a") },
      ]),
    ).toContain('tool_use "b"');
  });
});

const TEXT_MODEL: Pick<Model<Api>, "api" | "provider" | "id" | "input"> = {
  api: "faux",
  provider: "faux",
  id: "m",
  input: ["text"],
};

const IMAGE_MODEL: typeof TEXT_MODEL = { ...TEXT_MODEL, input: ["text", "image"] };

describe("toPiMessages", () => {
  it("maps text, tool_use and tool_result, naming a result's tool from the call it answers", () => {
    const converted = toPiMessages(
      [user("hi"), use("a", "lookup"), { role: "user", content: result("a") }],
      TEXT_MODEL,
      7,
    );

    expect(converted).toEqual({
      kind: "messages",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 7 },
        expect.objectContaining({
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "a", name: "lookup", arguments: { q: 1 } }],
        }),
        {
          role: "toolResult",
          toolCallId: "a",
          toolName: "lookup",
          content: [{ type: "text", text: "found" }],
          isError: false,
          timestamp: 7,
        },
      ],
    });
  });

  it("flattens what a tool result holds: audio and links to text, a binary resource to its facts", () => {
    const converted = toPiMessages(
      [
        use("a"),
        {
          role: "user",
          content: {
            type: "tool_result",
            toolUseId: "a",
            content: [
              { type: "audio", data: "AAAA", mimeType: "audio/wav" },
              { type: "resource_link", uri: "file:///x" },
              { type: "resource", resource: { uri: "file:///a", text: "inline" } },
              {
                type: "resource",
                resource: { uri: "file:///b", mimeType: "image/png", blob: "AAAAAAAA" },
              },
            ],
          },
        },
      ],
      TEXT_MODEL,
      1,
    );

    expect(converted.kind === "messages" && converted.messages[1]).toMatchObject({
      content: [
        { type: "text", text: "[audio omitted]" },
        { type: "text", text: "[resource: file:///x]" },
        { type: "text", text: "inline" },
        { type: "text", text: "[binary resource: file:///b, image/png, 6 bytes]" },
      ],
    });
  });

  it("gives a result's structuredContent as text when it has no text of its own", () => {
    const converted = toPiMessages(
      [
        use("a"),
        {
          role: "user",
          content: {
            type: "tool_result",
            toolUseId: "a",
            content: [],
            structuredContent: { n: 1 },
            isError: true,
          },
        },
      ],
      TEXT_MODEL,
      1,
    );

    expect(converted.kind === "messages" && converted.messages[1]).toMatchObject({
      content: [{ type: "text", text: '{"n":1}' }],
      isError: true,
    });
  });

  it("refuses audio, an image for a model with none, and a text over 1 MiB", () => {
    const image: SamplingMessage = {
      role: "user",
      content: { type: "image", data: "AAAA", mimeType: "image/png" },
    };

    expect(toPiMessages([image], TEXT_MODEL, 1)).toEqual({
      kind: "refused",
      reason: "the model takes no images",
    });
    expect(toPiMessages([image], IMAGE_MODEL, 1).kind).toBe("messages");
    expect(
      toPiMessages(
        [{ role: "user", content: { type: "audio", data: "AAAA", mimeType: "audio/wav" } }],
        IMAGE_MODEL,
        1,
      ),
    ).toEqual({ kind: "refused", reason: "audio is not supported" });
    expect(toPiMessages([user("x".repeat(SAMPLING_TEXT_MAX + 1))], TEXT_MODEL, 1)).toEqual({
      kind: "refused",
      reason: "a text block is over 1 MiB",
    });
  });
});

describe("decodeSamplingParams", () => {
  it("reads the spec's params and rejects ones without messages or maxTokens", () => {
    expect(
      decodeSamplingParams({
        messages: [{ role: "user", content: { type: "text", text: "a" } }],
        maxTokens: 5,
      })._tag,
    ).toBe("Some");
    expect(decodeSamplingParams({ messages: [] })._tag).toBe("None");
    expect(decodeSamplingParams({ maxTokens: 1 })._tag).toBe("None");
  });
});

const ROLES: ReadonlyArray<RoleModel> = [
  { role: "small", id: "claude-haiku-4" },
  { role: "medium", id: "claude-sonnet-4" },
  { role: "large", id: "claude-opus-4" },
  { role: "xlarge", id: "gpt-5-pro" },
];

describe("chooseRole", () => {
  it("is small with no preferences, and medium for one that asks for intelligence", () => {
    expect(chooseRole(undefined, ROLES)).toEqual({ role: "small", clamped: false });
    expect(chooseRole({ intelligencePriority: 0.9, costPriority: 0.2 }, ROLES)).toEqual({
      role: "medium",
      clamped: false,
    });
    expect(chooseRole({ intelligencePriority: 0.9, costPriority: 0.95 }, ROLES)).toEqual({
      role: "small",
      clamped: false,
    });
  });

  it("matches a hint as a case-insensitive substring, the first matching hint deciding", () => {
    expect(chooseRole({ hints: [{ name: "SONNET" }] }, ROLES)).toEqual({
      role: "medium",
      clamped: false,
    });
    expect(chooseRole({ hints: [{ name: "nothing" }, { name: "haiku" }] }, ROLES)).toEqual({
      role: "small",
      clamped: false,
    });
    expect(chooseRole({ hints: [{}, { name: " " }, { name: "sonnet" }] }, ROLES).role).toBe(
      "medium",
    );
  });

  it("lets the priorities pick among the Roles a hint matches: the lowest, or the most intelligent", () => {
    expect(chooseRole({ hints: [{ name: "claude" }] }, ROLES, "xlarge").role).toBe("small");
    expect(
      chooseRole({ hints: [{ name: "claude" }], intelligencePriority: 0.9 }, ROLES, "xlarge").role,
    ).toBe("large");
  });

  it("never goes above the ceiling unless the owner picked a higher one, and says it lowered", () => {
    expect(chooseRole({ hints: [{ name: "opus" }] }, ROLES)).toEqual({
      role: "medium",
      clamped: true,
    });
    expect(chooseRole({ hints: [{ name: "opus" }] }, ROLES, "large")).toEqual({
      role: "large",
      clamped: false,
    });
    expect(chooseRole({ hints: [{ name: "gpt" }] }, ROLES, "large")).toEqual({
      role: "large",
      clamped: true,
    });
  });
});

describe("lowestAvailable", () => {
  it("falls to the next lower Role with a model, and to nothing when none is left", () => {
    const has = (held: ReadonlyArray<RoleName>) => (role: RoleName) => held.includes(role);

    expect(lowestAvailable("medium", has(["small", "medium"]))).toBe("medium");
    expect(lowestAvailable("medium", has(["small", "large"]))).toBe("small");
    expect(lowestAvailable("small", has(["medium"]))).toBeUndefined();
  });
});

describe("toolChoiceFor", () => {
  it("leaves the default for auto and none given", () => {
    expect(toolChoiceFor("anthropic-messages", undefined)).toEqual({});
    expect(toolChoiceFor("openai-responses", "auto")).toEqual({});
  });

  it("spells none as none", () => {
    expect(toolChoiceFor("anthropic-messages", "none")).toEqual({ value: "none" });
    expect(toolChoiceFor("openai-completions", "none")).toEqual({ value: "none" });
  });

  it.each([
    ["anthropic-messages", "any"],
    ["bedrock-converse-stream", "any"],
    ["google-generative-ai", "any"],
    ["google-vertex", "any"],
    ["mistral-conversations", "any"],
    ["openai-completions", "required"],
    ["openai-responses", "required"],
    ["azure-openai-responses", "required"],
    ["openai-codex-responses", "required"],
  ] as const)("spells required for %s as %s", (api, value) => {
    expect(toolChoiceFor(api, "required")).toEqual({ value });
  });

  it("falls to auto with a note where the API has no way to require a tool", () => {
    expect(toolChoiceFor("faux", "required")).toEqual({
      note: "the model was not required to use a tool",
    });
  });
});

const message = (over: Partial<AssistantMessage>): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: "faux",
  provider: "faux",
  model: "faux-1",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 1,
  ...over,
});

describe("replyOf", () => {
  it("answers one joined text without tools and drops thinking", () => {
    expect(
      replyOf(
        message({
          content: [
            { type: "thinking", thinking: "hm" },
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
          responseModel: "real-model",
        }),
        false,
      ),
    ).toEqual({
      kind: "reply",
      stopReason: "endTurn",
      result: {
        role: "assistant",
        content: { type: "text", text: "ab" },
        model: "real-model",
        stopReason: "endTurn",
      },
    });
  });

  it("answers text and tool_use blocks when tools were offered", () => {
    expect(
      replyOf(
        message({
          stopReason: "toolUse",
          content: [
            { type: "text", text: "let me look" },
            { type: "toolCall", id: "t1", name: "lookup", arguments: { q: 2 } },
          ],
        }),
        true,
      ),
    ).toMatchObject({
      kind: "reply",
      stopReason: "toolUse",
      result: {
        content: [
          { type: "text", text: "let me look" },
          { type: "tool_use", id: "t1", name: "lookup", input: { q: 2 } },
        ],
        model: "faux-1",
      },
    });
  });

  it("words the stop reasons the spec's way, and fails on an error, an abort or an unreadable call", () => {
    expect(replyOf(message({ stopReason: "length" }), false)).toMatchObject({
      stopReason: "maxTokens",
    });
    expect(replyOf(message({ stopReason: "error", errorMessage: "boom" }), false)).toEqual({
      kind: "failed",
      reason: "boom",
    });
    expect(replyOf(message({ stopReason: "aborted" }), false)).toMatchObject({ kind: "failed" });
    expect(
      replyOf(
        message({
          content: [
            { type: "toolCall", id: "t", name: "x", arguments: {}, argumentsError: "bad json" },
          ],
        }),
        true,
      ),
    ).toMatchObject({ kind: "failed" });
  });
});

const record = (id: string, size: number): McpSamplingRecord => ({
  id,
  server: "demo",
  tool: "mcp__demo__t",
  origin: "agent",
  conversationId: 1,
  callId: "c",
  sequence: 1,
  status: "answered",
  by: "definition",
  notes: [],
  askedAt: 1,
  role: "small",
  tokens: 10,
  cost: 0.5,
  messages: [{ text: "x".repeat(size) }],
});

const memory = () => {
  const map = new Map<string, unknown>();

  return {
    // SAFETY: the records read back only what they wrote under each key.
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => {
      map.set(key, structuredClone(value));
    },
    delete: (key: string) => map.delete(key),
  };
};

describe("samplingRecords", () => {
  it("keeps a record whole and lists oldest first, a rewrite replacing it in place of a copy", () => {
    const records = samplingRecords(memory());

    records.put(record("a", 10), 1);
    records.put(record("b", 10), 2);
    records.put({ ...record("a", 10), status: "refused" }, 3);

    expect(records.list().map((each) => [each.id, each.status])).toEqual([
      ["b", "answered"],
      ["a", "refused"],
    ]);
  });

  it("reduces a record over 256 KiB to a stub that keeps its facts", () => {
    const records = samplingRecords(memory());

    records.put(record("big", SAMPLING_RECORD_BYTES + 1), 1);

    expect(records.get("big")).toMatchObject({ stub: true, role: "small", tokens: 10, cost: 0.5 });
    expect(records.get("big")?.messages).toBeUndefined();
  });

  it("reduces the least recently written to stubs past 16 MiB, never the one just written", () => {
    const records = samplingRecords(memory());
    const each = 200 * 1024;
    const count = Math.ceil(SAMPLING_RECORDS_BYTES / each) + 2;

    for (let index = 0; index < count; index += 1) records.put(record(`r${index}`, each), index);

    const all = records.list();

    expect(all).toHaveLength(count);
    expect(all[0]?.stub).toBe(true);
    expect(all.at(-1)?.stub).toBeUndefined();
    expect(all.at(-1)?.messages).toBeDefined();
  });
});

describe("cutText", () => {
  it("keeps the start and marks the cut", () => {
    expect(cutText("abcdef", 4)).toBe("abc…");
    expect(cutText("abc", 4)).toBe("abc");
  });
});
