// The model proxy's configuration (`docs/architecture/overview.md` → Models): its base URL and API key, deploy-time secrets.
// Sessions send their model requests through it, and the Registry reads the Model catalog from it (ADR-0051).
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";

/** The model proxy as it is called: its base URL and API key, read out of `ModelProxyConfig`. */
export type ModelProxy = { readonly url: string; readonly apiKey: string };

/** The model proxy's base URL and API key: deploy-time secrets, bound to the Worker by `Config.Redacted`. */
export class ModelProxyConfig extends Context.Service<
  ModelProxyConfig,
  { readonly url: Redacted.Redacted<string>; readonly apiKey: Redacted.Redacted<string> }
>()("@cloudpid/server/model-proxy/ModelProxyConfig") {}

/** Reads `MODEL_PROXY_URL` and `MODEL_PROXY_API_KEY`: from the deploying environment, then from the Worker's secrets. */
export const ModelProxyConfigLive = Layer.effect(
  ModelProxyConfig,
  Config.all({
    url: Config.Redacted("MODEL_PROXY_URL"),
    apiKey: Config.Redacted("MODEL_PROXY_API_KEY"),
  }),
);
