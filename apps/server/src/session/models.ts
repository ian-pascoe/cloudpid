// Model access through the model proxy (`docs/architecture/overview.md` → Models). Providers mirror `~/.pi/agent/models.json`: pi-ai's
// built-in provider and models, served from the proxy's base URL and authenticated with the proxy's API key.
import {
  createModels,
  type Api,
  type Model,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import * as Arr from "effect/Array";

/** The model proxy: its base URL and API key, from the `MODEL_PROXY_URL` and `MODEL_PROXY_API_KEY` secrets. */
export type ModelProxy = { readonly url: string; readonly apiKey: string };

/** `models.json` caps these Claude models' context window below their catalog value. */
const CLAUDE_CONTEXT_WINDOW = 400_000;

const CLAUDE_CAPPED = new Set([
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
]);

/** `base` with its requests sent to the proxy, authenticated with its API key, and models adjusted by `adjust`. */
const proxied = <T extends Api>(
  base: Provider<T>,
  proxy: ModelProxy,
  adjust: (model: Model<T>) => Model<T>,
): Provider<T> => {
  const models = Arr.map(base.getModels(), (model) => adjust({ ...model, baseUrl: proxy.url }));

  return {
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
    getModels: () => models,
    getAllModels: () => models,
  };
};

/** pi-ai `Models` whose providers all go through the model proxy. */
export const proxyModels = (proxy: ModelProxy): MutableModels => {
  const models = createModels();

  models.setProvider(
    proxied(anthropicProvider(), proxy, (model) =>
      CLAUDE_CAPPED.has(model.id) ? { ...model, contextWindow: CLAUDE_CONTEXT_WINDOW } : model,
    ),
  );

  return models;
};
