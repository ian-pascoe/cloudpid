// @effect-diagnostics preferEffectArray:off -- plain functions over native arrays.

// How the web app names and offers the models and thinking levels the settings accept.
import { isModelId, SUPPORTED_MODELS, THINKING_LEVELS, type ThinkingLevel } from "@cloudpid/config";
import type { ConfigureChange } from "./session/state.ts";

/** Whether `value` is one of pi-ai's thinking levels. */
export const isLevel = (value: string): value is ThinkingLevel =>
  THINKING_LEVELS.some((level) => level === value);

/** A model's name without its provider: `anthropic/claude-opus-5-5` shows as `claude-opus-5-5`. */
export const modelName = (id: string): string => id.slice(id.indexOf("/") + 1);

/**
 * The models to offer, as `provider/modelId`: the ones the settings accept, and `current` too when a Session runs one
 * they no longer list, so its select still shows what it runs.
 */
export const modelChoices = (current: string | null): readonly string[] =>
  current === null || SUPPORTED_MODELS.some((id) => id === current)
    ? SUPPORTED_MODELS
    : [...SUPPORTED_MODELS, current];

/** The select value that stands for "follow the default". */
export const FOLLOW_DEFAULT = "";

/**
 * What a model (an ID, or `FOLLOW_DEFAULT`) and a thinking level (or `FOLLOW_DEFAULT`) picked together ask of the
 * Session. A model the settings no longer accept (one the Session still runs) is left as it is.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a view helper, not a combinator.
export const pickedChange = (model: string, level: string): ConfigureChange => {
  const thinkingLevel = level === FOLLOW_DEFAULT ? null : isLevel(level) ? level : undefined;

  const change: ConfigureChange =
    model === FOLLOW_DEFAULT ? { model: null } : isModelId(model) ? { model } : {};

  return thinkingLevel === undefined ? change : { ...change, thinkingLevel };
};

/** What a select over a Session's model or thinking level shows. */
export type AgentSelect = { readonly value: string; readonly defaultLabel: string };

/**
 * The select for a Session's model or thinking level. `shown` is what the next request runs on, and `picked`
 * whether the Session chose it: a Session that follows the default shows the default option, named for what it
 * resolves to (`name`, which defaults to `shown`), so a concrete choice of the same value still differs from it
 * and can be picked.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a view helper, not a combinator.
export const agentSelect = (
  shown: string | null,
  picked: boolean,
  name: string | null = shown,
): AgentSelect => {
  if (shown === null) return { value: FOLLOW_DEFAULT, defaultLabel: "…" };

  return picked
    ? { value: shown, defaultLabel: "Use the default" }
    : { value: FOLLOW_DEFAULT, defaultLabel: `Default (${name})` };
};
