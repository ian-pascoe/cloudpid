import type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
import type { CompactionPolicy, ContextView } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { compactionThreshold, contextUsageOf } from "./context-usage.ts";

const POLICY: CompactionPolicy = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
  backgroundTokens: 16_000,
};

const usage = (input: number, output: number): Usage => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + output,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const answer = (text: string, at: number, spent: Usage): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude",
  usage: spent,
  stopReason: "stop",
  timestamp: at,
});

/** A view of `messages` alone: the measure reads nothing else. */
const viewOf = (messages: readonly Message[]): ContextView => ({
  head: undefined,
  entries: [],
  contributions: [],
  messages,
});

describe("how full a Context Window is", () => {
  it("is the newest answer's usage plus estimates of what came after it, against the window", () => {
    const view = viewOf([
      { role: "system", content: "You are helpful.", timestamp: 1 },
      { role: "user", content: "Hello", timestamp: 2 },
      answer("Hi there", 3, usage(1_000, 200)),
      // 35 characters: 10 tokens at pi-ai's 3.5 characters a token.
      { role: "user", content: "x".repeat(35), timestamp: 4 },
    ]);

    const measured = contextUsageOf(view, 400_000, POLICY);

    expect(measured.tokens).toBe(1_210);
    expect(measured.contextWindow).toBe(400_000);
    expect(measured.compactAt).toBe(400_000 - 16_384 - 16_000);
  });

  it("splits the tokens by kind of message, in proportion to the estimates", () => {
    const view = viewOf([
      { role: "system", content: "s".repeat(350), timestamp: 1 },
      { role: "user", content: "u".repeat(350), timestamp: 2 },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        content: [{ type: "text", text: "t".repeat(700) }],
        isError: false,
        timestamp: 3,
      },
    ]);

    // No answer yet: every message is estimated, and the parts are those estimates.
    expect(contextUsageOf(view, 1_000, POLICY)).toMatchObject({
      tokens: 400,
      parts: { system: 100, user: 100, assistant: 0, tools: 200 },
    });
  });

  it("is empty for an empty context", () => {
    expect(contextUsageOf(viewOf([]), 1_000, POLICY)).toMatchObject({
      tokens: 0,
      parts: { system: 0, user: 0, assistant: 0, tools: 0 },
    });
  });
});

describe("where automatic compaction starts", () => {
  it("is the background threshold, or the blocking one without background compaction", () => {
    expect(compactionThreshold(200_000, POLICY)).toBe(200_000 - 16_384 - 16_000);
    expect(compactionThreshold(200_000, { ...POLICY, backgroundTokens: 0 })).toBe(200_000 - 16_384);
  });

  it("is none when automatic compaction is off", () => {
    expect(compactionThreshold(200_000, { ...POLICY, enabled: false })).toBeNull();
  });
});
