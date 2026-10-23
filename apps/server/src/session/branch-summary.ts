// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off preferEffectRecord:off -- data-first functions over pi-ai's messages, called directly.
// Branch summaries (GLOSSARY.md → Session branch): leaving a branch for another point of the Session tree, the owner may
// carry a summary of what the branch they leave did, as local pi's `/tree` offers. The prompt and the summary's framing
// are pi's (`packages/coding-agent/src/core/compaction/branch-summarization.ts` and `messages.ts`), and so is the way the
// branch is shown to the model: serialized as text, so it summarizes it rather than continuing it.
import type { Message, Models, Usage, UserMessage } from "@earendil-works/pi-ai";
import type { EntryRecord, ModelRef } from "@earendil-works/pi-durable";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { contentText, textsOf } from "./text.ts";

/** pi's framing of a branch summary in the context. */
export const BRANCH_SUMMARY_PREFIX =
  "The following is a summary of a branch that this conversation came back from:\n\n<summary>\n";

export const BRANCH_SUMMARY_SUFFIX = "</summary>";

const BRANCH_SUMMARY_PREAMBLE =
  "The user explored a different conversation branch before returning here.\nSummary of that exploration:\n\n";

const SYSTEM_PROMPT =
  "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";

const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** How much of one tool result the summarizer is shown, as pi's. */
const TOOL_RESULT_MAX_CHARS = 2_000;

/** How much of the branch the summarizer is shown at most, newest kept: about 100k tokens. */
export const MAX_BRANCH_TEXT = 400_000;

/** How long the summary may take. */
const SUMMARY_TIMEOUT = "3 minutes";

/** The model's output allowance. */
const SUMMARY_MAX_TOKENS = 4_096;

const truncate = (text: string, limit: number): string =>
  text.length <= limit
    ? text
    : `${text.slice(0, limit)}\n\n[... ${text.length - limit} more characters truncated]`;

/** One message as the summarizer reads it, or nothing for one it does not need (system prompts). */
const serialize = (message: Message): string[] => {
  switch (message.role) {
    case "user": {
      const text = contentText(message.content);

      return text === "" ? [] : [`[User]: ${text}`];
    }

    case "assistant": {
      const parts: string[] = [];
      const text = textsOf(message.content);

      const calls = message.content.flatMap((part) =>
        part.type === "toolCall"
          ? [
              `${part.name}(${Object.entries(part.arguments)
                .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
                .join(", ")})`,
            ]
          : [],
      );

      if (text.length > 0) parts.push(`[Assistant]: ${text.join("\n")}`);

      if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);

      return parts;
    }

    case "toolResult": {
      const text = contentText(message.content);

      return text === "" ? [] : [`[Tool result]: ${truncate(text, TOOL_RESULT_MAX_CHARS)}`];
    }

    case "system":
      return [];
  }
};

/**
 * The branch's entries as the text the summarizer reads, oldest first, within `MAX_BRANCH_TEXT`: what is cut is the
 * oldest, as pi keeps the newest within its budget.
 */
export const branchText = (entries: ReadonlyArray<EntryRecord>): string => {
  const parts = entries.flatMap((entry) => (entry.model ?? []).flatMap(serialize));
  const kept: string[] = [];
  let size = 0;

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index] ?? "";
    // Each part after the first is joined with a blank line.
    const cost = part.length + (kept.length === 0 ? 0 : 2);

    if (size + cost > MAX_BRANCH_TEXT) break;

    kept.unshift(part);
    size += cost;
  }

  return kept.join("\n\n");
};

/** The request that summarizes `text` with the owner's extra focus. */
export const summaryPrompt = (text: string, instructions: string | undefined): string => {
  const focus =
    instructions === undefined || instructions.trim() === ""
      ? BRANCH_SUMMARY_PROMPT
      : `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${instructions.trim()}`;

  return `<conversation>\n${text}\n</conversation>\n\n${focus}`;
};

/** The model message a summary is placed as: pi's framing around it. */
export const summaryMessage = (summary: string, timestamp: number): UserMessage => ({
  role: "user",
  content: [{ type: "text", text: `${BRANCH_SUMMARY_PREFIX}${summary}${BRANCH_SUMMARY_SUFFIX}` }],
  timestamp,
});

/** Summarizing a branch failed. */
export class BranchSummaryError extends Schema.TaggedError<
  BranchSummaryError,
  { readonly brand: unique symbol }
>()("BranchSummaryError", { message: Schema.String }) {}

/**
 * Ask `model` of `models` to summarize the branch `entries` were left on: the summary, with pi's preamble, or a failure.
 * `onUsage` is told what the call cost, as no conversation's ledger holds it.
 */
export const summarizeBranch = (
  models: Models,
  model: ModelRef,
  entries: ReadonlyArray<EntryRecord>,
  instructions: string | undefined,
  onUsage: (usage: Usage) => void,
): Effect.Effect<string, BranchSummaryError> =>
  Effect.gen(function* () {
    const text = branchText(entries);

    if (text === "") return `${BRANCH_SUMMARY_PREAMBLE}No content to summarize`;

    const found = models.getModel(model.provider, model.modelId);

    if (found === undefined) {
      return yield* BranchSummaryError.make({
        message: `Model ${model.provider}/${model.modelId} is not available to summarize with`,
      });
    }

    const now = yield* Clock.currentTimeMillis;

    const reply = yield* Effect.tryPromise({
      try: (signal) =>
        models.completeSimple(
          found,
          {
            systemPrompt: SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: [{ type: "text", text: summaryPrompt(text, instructions) }],
                timestamp: now,
              },
            ],
          },
          { signal, maxTokens: SUMMARY_MAX_TOKENS },
        ),
      catch: (cause) =>
        BranchSummaryError.make({ message: `The summary request failed: ${String(cause)}` }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: SUMMARY_TIMEOUT,
        orElse: () => BranchSummaryError.make({ message: "The summary took too long" }),
      }),
    );

    yield* Effect.sync(() => onUsage(reply.usage));

    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      return yield* BranchSummaryError.make({
        message: `The summary request failed: ${reply.errorMessage ?? reply.stopReason}`,
      });
    }

    const summary = textsOf(reply.content).join("\n").trim();

    return summary === ""
      ? yield* BranchSummaryError.make({ message: "The model gave no summary" })
      : `${BRANCH_SUMMARY_PREAMBLE}${summary}`;
  });
