// @effect-diagnostics missingPipeableSignature:off -- plain functions over a model and a few strings.
// The model and thinking level a Session import runs with (`docs/architecture/mcp-endpoint.md` → Session import → The import
// channel): the Local agent's own if the owner has it, else the Environment's default with a warning, and the thinking
// level clamped to what the model supports. The import never fails over either.
import { formatModelId, isModelId, parseModelId, ThinkingLevel } from "@cloudpid/config";
import { clampThinkingLevel, type Models, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentState, ModelRef } from "@earendil-works/pi-durable";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import type { AgentPick } from "./pick.ts";

/** What an import's model is chosen against: the models of the catalog, and the Environment's default agent. */
export type ImportDefaults = {
  readonly catalog: Pick<Models, "getModel">;
  /** The agent a new Session of the Environment starts with: what the import falls back to. */
  readonly agent: { readonly model: ModelRef; readonly thinkingLevel: ModelThinkingLevel };
};

/** The agent an import's root conversation starts with, what the Session keeps picked, and what the Local agent is told. */
export type ImportAgent = {
  readonly agent: AgentState;
  readonly pick: AgentPick;
  /** One sentence for the Local agent (redacted by the caller) and the import notice: the model that was replaced. */
  readonly warnings: ReadonlyArray<string>;
};

const isThinkingLevel = Schema.is(ThinkingLevel);

/**
 * The agent for an import that asked for `model` (`provider/id`) and `thinking`. A model the owner has (one the Model
 * catalog lists, as the Session's models do: the check `session_start` makes) is used and stays picked; any other is replaced by the
 * default, which the Session keeps following, and the replacement is a warning. A thinking level is clamped to the
 * model's (`clampThinkingLevel`) and stays picked; one that is not a level is left out.
 */
export const resolveImportAgent = (
  requested: { readonly model?: string | undefined; readonly thinking?: string | undefined },
  defaults: ImportDefaults,
): ImportAgent => {
  const warnings: string[] = [];
  const pick: Types.Mutable<AgentPick> = {};
  let ref = defaults.agent.model;

  if (requested.model !== undefined) {
    const own = isModelId(requested.model) ? parseModelId(requested.model) : undefined;

    if (own !== undefined && defaults.catalog.getModel(own.provider, own.modelId) !== undefined) {
      ref = own;
      pick.model = own;
    } else {
      warnings.push(
        `The local model ${requested.model} is not one of the owner's models: the Environment's default, ${formatModelId(defaults.agent.model)}, is used.`,
      );
    }
  }

  let thinkingLevel = defaults.agent.thinkingLevel;

  if (requested.thinking !== undefined && isThinkingLevel(requested.thinking)) {
    const model = defaults.catalog.getModel(ref.provider, ref.modelId);

    thinkingLevel =
      model === undefined ? requested.thinking : clampThinkingLevel(model, requested.thinking);
    pick.thinkingLevel = thinkingLevel;
  }

  return { agent: { model: ref, thinkingLevel }, pick, warnings };
};

/**
 * Where an imported context counts as over the model's window: this share of it. The estimate (the last answer's usage
 * plus about 4 characters per token after it) is rough, so the warning comes before the window is passed: a context
 * this full leaves the first request no room, and takes cloudpid's own path (an Emergency Rollover, or a Rollover
 * request).
 */
export const CONTEXT_OVER_WINDOW_RATIO = 0.9;

/** The warning for a context of `tokens` in a window of `contextWindow`, or none when it fits comfortably. */
export const contextOverWindow = (tokens: number, contextWindow: number): string | undefined =>
  contextWindow > 0 && tokens >= contextWindow * CONTEXT_OVER_WINDOW_RATIO
    ? `context_over_window: the imported conversation is about ${String(Math.round(tokens))} tokens, ${tokens >= contextWindow ? "over" : "close to"} the model's window of ${String(contextWindow)}: the first request starts with a Rollover or a compaction.`
    : undefined;
