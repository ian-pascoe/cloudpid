// @effect-diagnostics preferEffectArray:off -- browser code with no Effect runtime: native arrays are the platform here.
// How the web app names and offers the models and thinking levels the settings accept.
import { SUPPORTED_MODELS } from "@cloudpid/config";

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
