// The web tools' deploy-time configuration: the search providers' API keys, which are Worker secrets.
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

type Key = Option.Option<Redacted.Redacted<string>>;

/** Which search providers this deployment has keys for. With neither, `web_search` reports that it is not configured. */
export class WebConfig extends Context.Service<
  WebConfig,
  { readonly exaApiKey: Key; readonly parallelApiKey: Key }
>()("@cloudpid/extensions/web/config/WebConfig") {}

/** An empty value is no key: CI passes an unset secret as an empty variable. */
const present = (key: Key): Key => Option.filter(key, (value) => Redacted.value(value) !== "");

/**
 * Reads `EXA_API_KEY` and `PARALLEL_API_KEY`, both optional, with `Config.Redacted`: from the deploying environment,
 * where the stack binds a key that is set to the Worker as a secret, then from the Worker's secrets at runtime.
 */
export const WebConfigLive = Layer.effect(
  WebConfig,
  Config.all({
    exaApiKey: Config.option(Config.Redacted("EXA_API_KEY")),
    parallelApiKey: Config.option(Config.Redacted("PARALLEL_API_KEY")),
  }).pipe(
    Effect.map(({ exaApiKey, parallelApiKey }) => ({
      exaApiKey: present(exaApiKey),
      parallelApiKey: present(parallelApiKey),
    })),
  ),
);
