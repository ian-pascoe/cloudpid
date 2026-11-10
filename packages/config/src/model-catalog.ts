// The Model catalog (`docs/architecture/overview.md` → Models, ADR-0052): the models the model proxy (Commissary) serves,
// as the Registry last read them from its `/v1/models`, or the built-in fallback before it ever has. A model is a
// `provider/modelId` string whose format the settings check; whether the proxy serves it is checked against the
// catalog where a model is written, and a saved model the catalog no longer lists is left out where it is read.
// @effect-diagnostics missingPipeableSignature:off -- plain functions over a catalog and a document, not combinators.
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { isJsonObject } from "./json.ts";

/** What a model's id looks like: `provider/modelId`, neither empty. */
export const MODEL_ID_PATTERN = /^[^/\s]+\/\S+$/;

/**
 * A model as `provider/modelId`. Only its format is checked: which models there are is the Model catalog's to say
 * (`catalogHas`), and it changes without a release.
 */
export const ModelId = Schema.String.check(Schema.isPattern(MODEL_ID_PATTERN)).annotate({
  description: "A model, as provider/id (anthropic/claude-opus-5-5)",
});

export type ModelId = typeof ModelId.Type;

/** Whether `value` is a model's id in the right format (`provider/modelId`). */
export const isModelId = Schema.is(ModelId);

/** Split `provider/modelId` into the pair pi-durable's `ModelRef` holds. */
export const parseModelId = (id: ModelId) => {
  const slash = id.indexOf("/");

  return { provider: id.slice(0, slash), modelId: id.slice(slash + 1) };
};

/** The `provider/modelId` of a pi-durable `ModelRef`. */
export const formatModelId = (ref: {
  readonly provider: string;
  readonly modelId: string;
}): string => `${ref.provider}/${ref.modelId}`;

/** One model of the catalog, as the model proxy lists it. */
export const CatalogModel = Schema.Struct({
  /** `provider/modelId`: every model the proxy lists is served through the Anthropic Messages API, as `anthropic/<id>`. */
  id: ModelId,
  /** Its display name (`Claude Fable 5.2`, `GPT-5`). */
  name: Schema.String,
  /** Who serves it behind the proxy (`anthropic`, `opencode`, …): what the pickers group it by. */
  ownedBy: Schema.String,
  /** Tokens of input it takes, as the proxy says. */
  contextWindow: Schema.Finite,
  /** Tokens it may answer with, as the proxy says. */
  maxTokens: Schema.Finite,
});

export type CatalogModel = typeof CatalogModel.Type;

/** The Model catalog: its models, and when the Registry read them from the proxy (null: never, the fallback). */
export const ModelCatalog = Schema.Struct({
  models: Schema.Array(CatalogModel),
  fetchedAt: Schema.NullOr(Schema.Finite),
});

export type ModelCatalog = typeof ModelCatalog.Type;

/** A model of the fallback: one of the Claude models pi-ai's catalog has, with `models.json`'s 400k window. */
const fallbackModel = (modelId: string, name: string): CatalogModel => ({
  id: `anthropic/${modelId}`,
  name,
  ownedBy: "anthropic",
  contextWindow: 400_000,
  maxTokens: 128_000,
});

/**
 * The catalog before the Registry has ever read the proxy's (ADR-0052): the four models cloudpid offered before the
 * catalog was read live. Its `fetchedAt` is null, so a saved model it lacks is still read (`keepsSavedModel`).
 */
export const FALLBACK_CATALOG: ModelCatalog = {
  models: [
    fallbackModel("claude-fable-5-1", "Claude Fable 5.1"),
    fallbackModel("claude-opus-5-5", "Claude Opus 5.5"),
    fallbackModel("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    fallbackModel("claude-haiku-5-5", "Claude Haiku 5.5"),
  ],
  fetchedAt: null,
};

/** Whether `catalog` was read from the proxy, rather than being the fallback. */
export const isCatalogKnown = (catalog: ModelCatalog): boolean => catalog.fetchedAt !== null;

/** `catalog`'s model `id`, if it lists it. */
export const catalogModel = (catalog: ModelCatalog, id: string): CatalogModel | undefined =>
  Option.getOrUndefined(Arr.findFirst(catalog.models, (model) => model.id === id));

/** Whether `catalog` lists model `id`: what a write of a model is checked against, the fallback included. */
export const catalogHas = (catalog: ModelCatalog, id: string): boolean =>
  catalogModel(catalog, id) !== undefined;

/**
 * Whether a saved model `id` is still read: one in the right format that `catalog` lists, or any in the right format
 * while `catalog` is the fallback, which says nothing of what the proxy serves (ADR-0052).
 */
export const keepsSavedModel = (catalog: ModelCatalog, id: string): boolean =>
  isModelId(id) && (!isCatalogKnown(catalog) || catalogHas(catalog, id));

/** The input and output limits of a model whose own the proxy does not say. */
export const UNKNOWN_MODEL_LIMITS = { contextWindow: 200_000, maxTokens: 32_000 } as const;

/**
 * `catalog` with the models `named` (those the resolved settings run: the default model, each Role's) that it lacks,
 * while it is the fallback: a saved model the fallback does not list is kept (`keepsSavedModel`), so it must be one the
 * Session can run too, with the limits of an unknown model. A catalog read from the proxy is answered as it is: a model
 * it does not list was already left out of the settings.
 */
export const withNamedModels = (
  catalog: ModelCatalog,
  named: ReadonlyArray<string>,
): ModelCatalog => {
  if (isCatalogKnown(catalog)) return catalog;

  const missing = Arr.dedupe(Arr.filter(named, (id) => isModelId(id) && !catalogHas(catalog, id)));

  return missing.length === 0
    ? catalog
    : {
        models: [
          ...catalog.models,
          ...Arr.map(missing, (id) => {
            const { provider, modelId } = parseModelId(id);

            return { id, name: modelId, ownedBy: provider, ...UNKNOWN_MODEL_LIMITS };
          }),
        ],
        fetchedAt: null,
      };
};

/** Why model `id` can't be written: the words every write's refusal uses. */
export const unservedModel = (id: string): string =>
  `${id} is not one of the models the model proxy serves (models_list lists them)`;

/** The keys of each model in a layer of the settings (overrides): the default model and each Role's. */
const modelKeysOf = (layer: Schema.Json): ReadonlyArray<ReadonlyArray<string>> => {
  if (!isJsonObject(layer)) return [];

  const roles = layer["roles"];

  const roleKeys =
    roles !== undefined && isJsonObject(roles)
      ? // @effect-diagnostics-next-line preferEffectRecord:off -- a JSON object's keys, which `Record.keys` does not take.
        Arr.map(Object.keys(roles), (role) => ["roles", role, "model"])
      : [];

  return [["model"], ...roleKeys];
};

/** The value at `keys` in `value`, if any. */
const valueAt = (value: Schema.Json, keys: ReadonlyArray<string>): Schema.Json | undefined => {
  let found: Schema.Json | undefined = value;

  for (const key of keys) {
    found = found !== undefined && isJsonObject(found) ? found[key] : undefined;
  }

  return found;
};

/** `value` without the leaf at `keys`. */
const withoutLeaf = (value: Schema.Json, keys: ReadonlyArray<string>): Schema.Json => {
  const [head, ...rest] = keys;

  if (head === undefined || !isJsonObject(value)) return value;

  if (rest.length === 0) return Record.filter(value, (_, key) => key !== head);

  return Record.map(value, (child, key) => (key === head ? withoutLeaf(child, rest) : child));
};

/** The models a Scope's settings run with: its default model and each Role's (the resolved `Settings` are one). */
export type ModelsInForce = {
  readonly model: string;
  readonly roles: Readonly<Record<string, { readonly model: string }>>;
};

/** The model `inForce` runs with at `keys` (`model`, or `roles.<name>.model`), if any. */
const modelInForceAt = (
  inForce: ModelsInForce | undefined,
  keys: ReadonlyArray<string>,
): string | undefined => {
  if (inForce === undefined) return undefined;

  const [head, role] = keys;

  return head === "model"
    ? inForce.model
    : role === undefined
      ? undefined
      : inForce.roles[role]?.model;
};

/** One model a write gives that the catalog does not list: the field, and the model. */
export type UnservedModel = { readonly field: string; readonly model: string };

/**
 * Each model of `layer` (a Scope's overrides as written: the default model, each Role's) that `catalog` does not list;
 * none when the proxy serves them all. A write is refused for them (ADR-0052). A model the Scope already runs with at
 * the same field (`inForce`, its settings as resolved before the write, inherited ones included) is not one the write
 * changes, and is not checked: it was checked when it was written, and a read decides whether it still applies
 * (`withServedModels`). So writing a Role's hint alone, which completes the Role with its model, is never refused.
 */
export const unservedModels = (
  layer: Schema.Json,
  catalog: ModelCatalog,
  inForce?: ModelsInForce,
): ReadonlyArray<UnservedModel> =>
  Arr.flatMap(modelKeysOf(layer), (keys) => {
    const value = valueAt(layer, keys);

    return Predicate.isString(value) &&
      isModelId(value) &&
      modelInForceAt(inForce, keys) !== value &&
      !catalogHas(catalog, value)
      ? [{ field: Arr.join(keys, "."), model: value }]
      : [];
  });

/** `unservedModels` as the lines a write's refusal shows, `field: why`. */
export const unservedModelLines = (
  layer: Schema.Json,
  catalog: ModelCatalog,
  inForce?: ModelsInForce,
): ReadonlyArray<string> =>
  Arr.map(
    unservedModels(layer, catalog, inForce),
    ({ field, model }) => `${field}: ${unservedModel(model)}`,
  );

/** A layer of the settings with the models the proxy no longer serves left out, and a line for each. */
export type ServedModels = {
  readonly document: Schema.Json;
  /** The models left out, each with its field. */
  readonly unserved: ReadonlyArray<UnservedModel>;
  /** A line for each, as a read's `problem` lists it. */
  readonly dropped: ReadonlyArray<string>;
};

/**
 * `layer` (a Scope's saved overrides) without the models `catalog` no longer lists (`keepsSavedModel`), and a line for
 * each left out: what a lenient read does before it resolves, so a model the proxy dropped costs only itself.
 */
export const withServedModels = (layer: Schema.Json, catalog: ModelCatalog): ServedModels => {
  const left = Arr.flatMap(modelKeysOf(layer), (keys) => {
    const value = valueAt(layer, keys);

    return Predicate.isString(value) && isModelId(value) && !keepsSavedModel(catalog, value)
      ? [{ keys, model: value }]
      : [];
  });

  const unserved = Arr.map(left, ({ keys, model }) => ({ field: Arr.join(keys, "."), model }));

  return {
    document: Arr.reduce(left, layer, (document, { keys }) => withoutLeaf(document, keys)),
    unserved,
    dropped: Arr.map(
      unserved,
      ({ field, model }) => `${field}: ${model} is no longer served by the model proxy`,
    ),
  };
};
