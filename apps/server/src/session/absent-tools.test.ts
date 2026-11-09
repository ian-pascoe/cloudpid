// @effect-diagnostics asyncFunction:off preferEffectArray:off preferEffectRecord:off -- plain arrays of fixtures, and a Promise-based model seam.
// Flattening calls to tools a request does not declare, for the providers that refuse them (`absent-tools.ts`).
import type {
  AssistantMessage,
  Context,
  Message,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { absentToolFlatteningModels, flattenAbsentToolCalls } from "./absent-tools.ts";
import { proxyModels } from "./models.ts";

const usage: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const user = (text: string): UserMessage => ({ role: "user", content: text, timestamp: 1 });

const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "m",
  usage,
  stopReason: "toolUse",
  timestamp: 2,
});

const result = (id: string, name: string, text: string, isError = false): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: name,
  content: [{ type: "text", text }],
  isError,
  timestamp: 3,
});

const history: Message[] = [
  user("go"),
  assistant([
    { type: "toolCall", id: "1", name: "bash", arguments: { command: "ls" } },
    { type: "toolCall", id: "2", name: "todo", arguments: {} },
  ]),
  result("1", "bash", "a.txt"),
  result("2", "todo", "no tasks"),
];

describe("flattening calls to absent tools", () => {
  it("turns a call to a tool the request does not declare, and its result, into text, and keeps the rest", () => {
    const flat = flattenAbsentToolCalls(history, new Set(["todo"]));

    expect(flat).toEqual([
      user("go"),
      assistant([
        { type: "text", text: '[Called bash {"command":"ls"}, which returned: a.txt]' },
        { type: "toolCall", id: "2", name: "todo", arguments: {} },
      ]),
      result("2", "todo", "no tasks"),
    ]);
  });

  it("says a call that failed failed, and returns the messages themselves when nothing is absent", () => {
    const failed = flattenAbsentToolCalls(
      [
        assistant([{ type: "toolCall", id: "1", name: "x", arguments: {} }]),
        result("1", "x", "no", true),
      ],
      new Set(),
    );

    expect(JSON.stringify(failed)).toContain("which failed: no");
    expect(flattenAbsentToolCalls(history, new Set(["bash", "todo"]))).toBe(history);
  });

  it("flattens at the request for a provider whose switch is on, and only for it", async () => {
    const models = proxyModels({ url: "http://localhost", apiKey: "unused" });
    const model = models.getModel("anthropic", "claude-haiku-5-5");
    const seen: Context[] = [];

    vi.spyOn(models, "completeSimple").mockImplementation((_model, context) => {
      seen.push(context);

      return Promise.resolve(assistant([]));
    });

    const context: Context = {
      messages: history,
      tools: [{ name: "todo", description: "", parameters: {} }],
    };

    if (model === undefined) throw new Error("The catalog has no such model.");

    await absentToolFlatteningModels(models, (provider) => provider === "anthropic").completeSimple(
      model,
      context,
    );
    await absentToolFlatteningModels(models, () => false).completeSimple(model, context);

    expect(JSON.stringify(seen[0]?.messages)).not.toContain('"name":"bash"');
    expect(seen[1]?.messages).toBe(history);
  });
});
