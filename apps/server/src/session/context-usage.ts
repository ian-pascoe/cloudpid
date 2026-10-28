// @effect-diagnostics missingPipeableSignature:off -- plain functions over a context view.
// How full the active branch's Context Window is, for the Session header (`docs/architecture/operations.md` → Usage): the
// size of its next request as pi-durable reckons it before compacting (the newest answer's usage, plus estimates of
// what came after it), against the model's context window, with where automatic compaction starts and what the
// context is made of.
import type { ContextUsage } from "@cloudpid/protocol";
import type { Message } from "@earendil-works/pi-ai";
import { estimateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { CompactionPolicy, ContextView } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";

/** What a context is made of, in estimated tokens, by the kind of message. */
type Parts = { system: number; user: number; assistant: number; tools: number };

const NO_PARTS: Parts = { system: 0, user: 0, assistant: 0, tools: 0 };

/** The part of the context `message` counts in: the prompt and tools, the owner's, the model's, or a tool's result. */
const partOf = (message: Message): keyof Parts => {
  switch (message.role) {
    case "system":
      return "system";
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "toolResult":
      return "tools";
  }
};

/**
 * The parts of `messages`, scaled to add up to `tokens`: a provider reports one figure for a request, so the split is
 * the estimates' proportions of it.
 */
const partsOf = (messages: readonly Message[], tokens: number): Parts => {
  const estimated = Arr.reduce(messages, { ...NO_PARTS }, (parts, message) => {
    parts[partOf(message)] += estimateMessageTokens(message);

    return parts;
  });

  const sum = estimated.system + estimated.user + estimated.assistant + estimated.tools;

  if (sum === 0) return NO_PARTS;

  const scale = (part: number) => Math.round((part * tokens) / sum);

  return {
    system: scale(estimated.system),
    user: scale(estimated.user),
    assistant: scale(estimated.assistant),
    tools: scale(estimated.tools),
  };
};

/**
 * Where automatic compaction starts, in tokens: the background threshold when background compaction is on, else the
 * blocking one (`contextWindow - reserveTokens`). Null when automatic compaction is off.
 */
export const compactionThreshold = (
  contextWindow: number,
  policy: CompactionPolicy,
): number | null => {
  if (!policy.enabled || contextWindow <= 0) return null;

  const blocking = contextWindow - policy.reserveTokens;

  return Math.max(0, policy.backgroundTokens > 0 ? blocking - policy.backgroundTokens : blocking);
};

/** How full `view` is against a model of `contextWindow` tokens, compacting by `policy`. */
export const contextUsageOf = (
  view: ContextView,
  contextWindow: number,
  policy: CompactionPolicy,
): ContextUsage => {
  const { tokens } = estimateContextTokens(view.messages);

  return {
    tokens,
    contextWindow,
    compactAt: compactionThreshold(contextWindow, policy),
    parts: partsOf(view.messages, tokens),
  };
};
