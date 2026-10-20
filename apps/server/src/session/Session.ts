import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import { REGISTRY_NAME, Registry } from "../registry/Registry.ts";
import { sessionExtensions } from "./extensions.ts";
import { type Answer, type Prompt, SessionError, SessionHost, sessionHostLayer } from "./host.ts";
import { DEFAULT_AGENT, proxyModels } from "./models.ts";
import { ReportError, SessionRegistry } from "./status.ts";

/** The key the Session's name is kept under, for instances that are not told it. */
const NAME_KEY = "session-name";

/** The model proxy's base URL and API key: deploy-time secrets, bound to the Worker by `Config.Redacted`. */
export class ModelProxyConfig extends Context.Service<
  ModelProxyConfig,
  { readonly url: Redacted.Redacted<string>; readonly apiKey: Redacted.Redacted<string> }
>()("@cloudpid/server/session/Session/ModelProxyConfig") {}

/** Reads `MODEL_PROXY_URL` and `MODEL_PROXY_API_KEY`: from the deploying environment, then from the Worker's secrets. */
export const ModelProxyConfigLive = Layer.effect(
  ModelProxyConfig,
  Config.all({
    url: Config.Redacted("MODEL_PROXY_URL"),
    apiKey: Config.Redacted("MODEL_PROXY_API_KEY"),
  }),
);

/** What the Session DO answers over RPC. */
export type SessionMethods = {
  /** Submit `prompt` to the root conversation and wait for its answer. */
  readonly prompt: (prompt: Prompt) => Effect.Effect<Answer, SessionError>;
  readonly alarm: () => Effect.Effect<void>;
};

/** One Session: a pi-durable Harness over this object's SQLite storage (`docs/spec.md` → Session host). */
export class Session extends Cloudflare.DurableObject<Session, SessionMethods>()("Session", {
  errors: [SessionError],
}) {}

export const SessionLive = Session.make(
  Effect.gen(function* () {
    return {
      proxy: yield* ModelProxyConfig,
      registries: yield* Registry,
      state: yield* Cloudflare.DurableObjectState,
    };
  }).pipe(
    // The outer Effect resolves the shared services; this inner one runs once per instance, in its constructor.
    Effect.map(({ proxy, registries, state }) =>
      Effect.gen(function* () {
        const models = proxyModels({
          url: Redacted.value(proxy.url),
          apiKey: Redacted.value(proxy.apiKey),
        });

        // The Session's name is its ID in the Registry. Instances are told it when addressed by name, as every Session
        // is; it is kept so one that is not, such as an alarm's, still has it.
        const { kv } = state.raw.storage;
        const name = state.raw.id.name ?? kv.get<string>(NAME_KEY);

        if (name !== undefined) kv.put(NAME_KEY, name);

        const registry = Layer.succeed(SessionRegistry, {
          report: (status) =>
            name === undefined
              ? ReportError.make({ message: "The Session's name is unknown" })
              : registries.getByName(REGISTRY_NAME).setSessionStatus({ id: name, status }),
        });

        // The object's services, built once and kept for its lifetime.
        const runtime = ManagedRuntime.make(
          sessionHostLayer({
            storage: state.raw.storage,
            models,
            agent: DEFAULT_AGENT,
            reset: (reason) => state.raw.abort(reason),
            extensions: sessionExtensions,
          }).pipe(Layer.provide(registry)),
        );

        // A failed open resets the object, and the fallback alarm it armed first starts it again.
        const host = yield* runtime.contextEffect.pipe(
          Effect.map(Context.get(SessionHost)),
          Effect.orDie,
        );

        return {
          prompt: host.prompt,
          // A failed alarm is retried by the runtime.
          alarm: () => Effect.orDie(host.alarm),
        };
      }),
    ),
  ),
);
