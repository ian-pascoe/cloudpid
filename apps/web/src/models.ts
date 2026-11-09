// @effect-diagnostics preferEffectArray:off missingPipeableSignature:off -- plain view helpers over native arrays.

// How the web app names and offers the models and thinking levels the settings accept: the models are the Model
// catalog's (`docs/architecture/overview.md` → Models, ADR-0051), the ones the model proxy serves, grouped by who serves
// each.
import {
  type CatalogModel,
  catalogModel,
  isModelId,
  type ModelCatalog,
  parseModelId,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "@cloudpid/config";
import type { ConfigureChange } from "./session/state.ts";

/** Whether `value` is one of pi-ai's thinking levels. */
export const isLevel = (value: string): value is ThinkingLevel =>
  THINKING_LEVELS.some((level) => level === value);

/** A model's name without its provider: `anthropic/claude-opus-5-5` shows as `claude-opus-5-5`. */
export const modelName = (id: string): string => id.slice(id.indexOf("/") + 1);

/** A model's display name in `catalog`, or its name without the provider when the catalog does not list it. */
export const modelLabel = (catalog: ModelCatalog, id: string): string =>
  catalogModel(catalog, id)?.name ?? modelName(id);

/** A group of models to offer: those one server serves behind the proxy (`ownedBy`), or the one the catalog lacks. */
export type ModelGroup = { readonly label: string; readonly models: readonly CatalogModel[] };

/** The group of a value the catalog does not list, which a select still shows. */
export const UNLISTED_GROUP = "Not listed by the model proxy";

const byName = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * The models to offer, grouped by who serves them (`anthropic` first, then the rest by name), each group by display
 * name; and `current` too, in a group of its own, when it is a model the catalog does not list (one saved before the
 * proxy stopped serving it, or under the fallback), so a select still shows the value it holds.
 */
export const modelGroups = (
  catalog: ModelCatalog,
  current: string | null,
): readonly ModelGroup[] => {
  const owners = [...new Set(catalog.models.map((model) => model.ownedBy))].toSorted((a, b) =>
    a === "anthropic" ? -1 : b === "anthropic" ? 1 : byName.compare(a, b),
  );

  const groups = owners.map((owner) => ({
    label: owner,
    models: catalog.models
      .filter((model) => model.ownedBy === owner)
      .toSorted((a, b) => byName.compare(a.name, b.name)),
  }));

  if (current === null || current === "" || catalogModel(catalog, current) !== undefined) {
    return groups;
  }

  const { provider, modelId } = isModelId(current)
    ? parseModelId(current)
    : { provider: "", modelId: current };

  return [
    ...groups,
    {
      label: UNLISTED_GROUP,
      models: [{ id: current, name: modelId, ownedBy: provider, contextWindow: 0, maxTokens: 0 }],
    },
  ];
};

/** The models to offer, as `provider/modelId`, in the order `modelGroups` shows them. */
export const modelChoices = (catalog: ModelCatalog, current: string | null): readonly string[] =>
  modelGroups(catalog, current).flatMap((group) => group.models.map((model) => model.id));

/** The select value that stands for "follow the default". */
export const FOLLOW_DEFAULT = "";

/**
 * What a model (an ID, or `FOLLOW_DEFAULT`) and a thinking level (or `FOLLOW_DEFAULT`) picked together ask of the
 * Session. A value that is not a model's id is left as it is; whether the proxy serves a model is the Session's to say.
 */
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
