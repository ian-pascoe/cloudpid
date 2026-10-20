import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { deployment } from "./deployment.ts";
import { hello } from "./hello.ts";
import { promptSession, promptSessionId } from "./prompt.ts";
import { ModelProxyConfigLive, Session, SessionLive } from "./session/Session.ts";

/**
 * Deploy-time props, resolved from the stage. The stage is absent once the Worker runs (the props
 * only matter at deploy time), so that case falls back to a non-prod stage.
 */
const props = Effect.gen(function* () {
  const stage = Option.getOrElse(yield* Effect.serviceOption(Alchemy.Stage), () => "runtime");

  return {
    main: import.meta.url,
    compatibility: { date: "2026-08-31" },
    ...deployment(stage),
  };
});

/** The main Worker. This file is its own entry, so it is bundled as written. */
export default class Server extends Cloudflare.Worker<Server>()(
  "Server",
  props,
  Effect.gen(function* () {
    const sessions = yield* Session;

    return {
      fetch: Effect.gen(function* () {
        const sessionId = promptSessionId(yield* HttpServerRequest.HttpServerRequest);

        return sessionId === undefined ? hello : yield* promptSession(sessions, sessionId);
      }),
    };
  }).pipe(
    // The Worker's init is its entry point.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(SessionLive.pipe(Layer.provide(ModelProxyConfigLive))),
  ),
) {}
