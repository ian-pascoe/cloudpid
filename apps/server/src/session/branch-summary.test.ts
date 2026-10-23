// @effect-diagnostics preferEffectArray:off asyncFunction:off missedPipeableOpportunity:off -- plain fixtures.
import type { AssistantMessage, Models, Usage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import {
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  branchText,
  MAX_BRANCH_TEXT,
  summarizeBranch,
  summaryMessage,
  summaryPrompt,
} from "./branch-summary.ts";

type FixtureValue =
  | string
  | number
  | boolean
  | readonly FixtureValue[]
  | { readonly [key: string]: FixtureValue };

type Fixture = { readonly [key: string]: FixtureValue };

// SAFETY: a fixture holds only the fields a summary reads; the other fields of pi's types are never looked at.
// oxlint-disable-next-line anti-slop/no-chained-type-assertions
const asEntry = (entry: Fixture): EntryRecord => entry as unknown as EntryRecord;

const piMessage = (id: number, model: Fixture): EntryRecord =>
  asEntry({ id, kind: "pi.message", model: [model] });

const BRANCH = [
  piMessage(1, { role: "user", content: "Fix the build", timestamp: 1 }),
  piMessage(2, {
    role: "assistant",
    content: [
      { type: "text", text: "Looking." },
      { type: "toolCall", id: "c1", name: "bash", arguments: { command: "pnpm build" } },
    ],
    timestamp: 2,
  }),
  piMessage(3, {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "bash",
    content: [{ type: "text", text: "x".repeat(3_000) }],
    timestamp: 3,
  }),
  piMessage(4, { role: "system", content: "You are pi", timestamp: 4 }),
];

describe("the branch as the summarizer reads it", () => {
  it("serializes each message, with tool calls and cut tool results, and leaves out system prompts", () => {
    const text = branchText(BRANCH);

    expect(text).toContain("[User]: Fix the build");
    expect(text).toContain("[Assistant]: Looking.");
    expect(text).toContain('[Assistant tool calls]: bash(command="pnpm build")');
    expect(text).toContain("[Tool result]: xxx");
    expect(text).toContain("[... 1000 more characters truncated]");
    expect(text).not.toContain("You are pi");
  });

  it("keeps the newest of a long branch", () => {
    const long = [
      piMessage(1, { role: "user", content: "oldest", timestamp: 1 }),
      piMessage(2, { role: "user", content: "y".repeat(MAX_BRANCH_TEXT - 30), timestamp: 2 }),
      piMessage(3, { role: "user", content: "newest", timestamp: 3 }),
    ];

    const text = branchText(long);

    expect(text).not.toContain("oldest");
    expect(text).toContain("yyy");
    expect(text.endsWith("[User]: newest")).toBe(true);
  });

  it("asks for the owner's extra focus when there is one", () => {
    expect(summaryPrompt("text", "the tests")).toContain("Additional focus: the tests");
    expect(summaryPrompt("text", "  ")).not.toContain("Additional focus");
  });

  it("frames the summary as pi does", () => {
    expect(summaryMessage("done", 5)).toEqual({
      role: "user",
      content: [{ type: "text", text: `${BRANCH_SUMMARY_PREFIX}done${BRANCH_SUMMARY_SUFFIX}` }],
      timestamp: 5,
    });
  });
});

describe("summarizing a branch", () => {
  const USAGE: Usage = {
    input: 10,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  /** Models that answer every request with `reply`, and the requests they got. */
  const models = (reply: Partial<AssistantMessage>, known = true) => {
    const asked: string[] = [];

    // SAFETY: a summary calls only these two methods.
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions
    const fake = {
      getModel: () => (known ? { id: "m" } : undefined),
      completeSimple: async (
        _model: { readonly id: string },
        context: { messages: Array<{ content: Array<{ text: string }> }> },
      ) => {
        asked.push(context.messages[0]?.content[0]?.text ?? "");

        return { content: [], usage: USAGE, stopReason: "stop", ...reply };
      },
    } as unknown as Models;

    return { fake, asked };
  };

  const summarize = (fake: Models, entries = BRANCH, used: Usage[] = []) =>
    summarizeBranch(fake, { provider: "p", modelId: "m" }, entries, "the tests", (usage) =>
      used.push(usage),
    );

  const run = (fake: Models, entries = BRANCH, used: Usage[] = []) =>
    Effect.runPromise(summarize(fake, entries, used));

  const fail = (fake: Models) => Effect.runPromise(Effect.flip(summarize(fake)));

  it("asks the model, with the branch and the focus, and reports what it cost", async () => {
    const { fake, asked } = models({ content: [{ type: "text", text: "## Goal\nFix it" }] });
    const used: Usage[] = [];

    const result = await run(fake, BRANCH, used);

    expect(result).toContain("## Goal\nFix it");
    expect(asked[0]).toContain("[User]: Fix the build");
    expect(asked[0]).toContain("Additional focus: the tests");
    expect(used).toEqual([USAGE]);
  });

  it("asks nothing for a branch with nothing to summarize", async () => {
    const { fake, asked } = models({});

    const result = await run(fake, []);

    expect(result).toContain("No content to summarize");
    expect(asked).toEqual([]);
  });

  it("fails when the model errs, gives nothing, or is not there", async () => {
    const errs = await fail(models({ stopReason: "error", errorMessage: "overloaded" }).fake);
    const empty = await fail(models({ content: [] }).fake);
    const missing = await fail(models({}, false).fake);

    expect(errs.message).toContain("overloaded");
    expect(empty.message).toBe("The model gave no summary");
    expect(missing.message).not.toBe("");
  });
});
