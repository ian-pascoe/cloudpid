// Model access through the model proxy (`docs/architecture/overview.md` → Models, ADR-0052). The models are the Model
// catalog's, as the Registry last read them from the proxy: each is served through the Anthropic Messages API, so all
// are pi-ai `anthropic` models, served from the proxy's base URL and authenticated with the proxy's API key. Their
// metadata (cost, reasoning, thinking levels) is pi-ai's for a model its catalog has, a family template's for a newer
// Claude model it does not, and a generic model's otherwise (`catalogModels`).
// @effect-diagnostics missingPipeableSignature:off -- plain functions over a catalog, not combinators.
import {
  type CatalogModel,
  FALLBACK_CATALOG,
  type ModelCatalog,
  parseModelId,
} from "@cloudpid/config";
import { createModels, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type { ModelProxy } from "../model-proxy.ts";

type AnthropicModel = Model<"anthropic-messages">;

/** `models.json` caps these Claude models' context window below their catalog value, and their family's newer ones. */
const CLAUDE_CONTEXT_WINDOW = 400_000;

const CLAUDE_CAPPED: ReadonlySet<string> = new Set([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
]);

/**
 * A Claude model's id a family template fits: the family and its version, nothing after it. The proxy's aliases of other
 * models (`claude-fable-5-dd-…`) start with a family's name too, which is why only an exact match is templated.
 */
const CLAUDE_FAMILY = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/;

/** The family and version of a Claude model's id, or none. */
const familyOf = (
  id: string,
): { readonly family: string; readonly version: readonly [number, number] } | undefined => {
  const match = CLAUDE_FAMILY.exec(id);

  if (match === null) return undefined;

  const [, family = "", major = "0", minor = "0"] = match;

  return { family, version: [Number(major), Number(minor)] };
};

/** The newest model of `id`'s family that `known` has, to take an uncatalogued Claude model's metadata from. */
const templateOf = (
  id: string,
  known: ReadonlyArray<AnthropicModel>,
): AnthropicModel | undefined => {
  const own = familyOf(id);

  if (own === undefined) return undefined;

  let newest:
    | { readonly model: AnthropicModel; readonly version: readonly [number, number] }
    | undefined;

  for (const model of known) {
    const found = familyOf(model.id);

    if (found === undefined || found.family !== own.family) continue;

    const [major, minor] = found.version;

    if (
      newest === undefined ||
      major > newest.version[0] ||
      (major === newest.version[0] && minor > newest.version[1])
    ) {
      newest = { model, version: found.version };
    }
  }

  return newest?.model;
};

/** A model's window: the proxy's, at most `models.json`'s cap where `capped`. */
const windowOf = (entry: CatalogModel, capped: boolean): number =>
  capped ? Math.min(entry.contextWindow, CLAUDE_CONTEXT_WINDOW) : entry.contextWindow;

/** pi-ai's model for one entry of the catalog, against pi-ai's own anthropic models `known`. */
const piAiModelOf = (
  entry: CatalogModel,
  known: ReadonlyArray<AnthropicModel>,
  baseUrl: string,
): AnthropicModel => {
  const { modelId } = parseModelId(entry.id);
  const own = Option.getOrUndefined(Arr.findFirst(known, (model) => model.id === modelId));

  if (own !== undefined) {
    return {
      ...own,
      name: entry.name,
      baseUrl,
      maxTokens: entry.maxTokens,
      contextWindow: windowOf(entry, CLAUDE_CAPPED.has(modelId)),
    };
  }

  const template = templateOf(modelId, known);

  if (template !== undefined) {
    return {
      ...template,
      id: modelId,
      name: entry.name,
      baseUrl,
      maxTokens: entry.maxTokens,
      contextWindow: windowOf(entry, CLAUDE_CAPPED.has(template.id)),
    };
  }

  // Nothing is known of it but what the proxy says: no price (the spend limit cannot count it), thinking assumed.
  return {
    id: modelId,
    name: entry.name,
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
  };
};

/** pi-ai's anthropic models. */
const ANTHROPIC_MODELS: ReadonlyArray<AnthropicModel> = anthropicProvider().getModels();

/**
 * pi-ai's models for `catalog`'s `anthropic` entries, served from `baseUrl`: pi-ai's own entry for a model it has (the
 * proxy's name, output limit and window, the window capped for the Claude models `models.json` caps); the newest model
 * of the family for a Claude model it does not (`claude-fable-5-2` takes `claude-fable-5-1`'s price, thinking levels and
 * cap); a generic Anthropic Messages model, unpriced, for any other.
 */
export const catalogModels = (
  catalog: ModelCatalog,
  baseUrl: string,
  known: ReadonlyArray<AnthropicModel> = ANTHROPIC_MODELS,
): ReadonlyArray<AnthropicModel> =>
  Arr.flatMap(catalog.models, (entry) =>
    parseModelId(entry.id).provider === "anthropic" ? [piAiModelOf(entry, known, baseUrl)] : [],
  );

/**
 * pi-ai `Models` whose providers all go through the model proxy, listing the models of the catalog `catalog` gives at
 * each lookup (the fallback when none is given): a catalog the Session reads again is in force from its next request.
 */
export const proxyModels = (
  proxy: ModelProxy,
  catalog: () => ModelCatalog = () => FALLBACK_CATALOG,
): MutableModels => {
  const models = createModels();
  const base = anthropicProvider();

  // The list is made again only when the catalog is another one.
  let listedFor: ModelCatalog | undefined;
  let listed: ReadonlyArray<AnthropicModel> = [];

  const current = (): ReadonlyArray<AnthropicModel> => {
    const now = catalog();

    if (now !== listedFor) {
      listedFor = now;
      listed = catalogModels(now, proxy.url);
    }

    return listed;
  };

  models.setProvider({
    ...base,
    baseUrl: proxy.url,
    auth: {
      apiKey: {
        name: "Model proxy API key",
        resolve: () =>
          Promise.resolve({
            auth: { apiKey: proxy.apiKey, baseUrl: proxy.url },
            source: "MODEL_PROXY_API_KEY",
          }),
      },
    },
    getModels: current,
    getAllModels: current,
  });

  return models;
};
