import { fileURLToPath } from "node:url";
import * as Alchemy from "alchemy";
import * as Command from "alchemy/Command";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { connectSession } from "./connect.ts";
import { deployment } from "./deployment.ts";
import { hello } from "./hello.ts";
import { Registry, RegistryLive } from "./registry/Registry.ts";
import { serveRegistryRpc } from "./registry/rpc.ts";
import { isRegistryRpc, sessionSocketId } from "./routes.ts";
import { ModelProxyConfigLive, Session, SessionLive } from "./session/Session.ts";

/**
 * The web app (`apps/web`), built at deploy time and served as static assets by this Worker: a request that matches a
 * file is answered by the asset layer without waking the Worker, a navigation to an unknown path (`/sessions/:id`)
 * gets `index.html`, and every other request (the Session socket, `/rpc`) reaches the Worker. The Worker's bundle
 * folds the build step away, so only the deploy runs it.
 */
const webAssets = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__ === true) return undefined;

  // Alchemy runs from `infra/`, so the app's directory is resolved from this file, not from a relative path.
  const webDirectory = fileURLToPath(new URL("../../web/", import.meta.url).href);

  const build = yield* Command.Build("WebBuild", {
    command: "pnpm run build",
    cwd: webDirectory,
    outdir: "dist",
    // The app imports the protocol package's source, which the default scope (the app's own files) would miss.
    memo: { include: ["**/*", "../../packages/protocol/src/**"], lockfile: true },
  });

  return {
    directory: build.outdir,
    hash: build.hash.output,
    notFoundHandling: "single-page-application" as const,
  };
});

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
    assets: yield* webAssets,
  };
});

/** The main Worker. This file is its own entry, so it is bundled as written. */
export default class Server extends Cloudflare.Worker<Server>()(
  "Server",
  props,
  Effect.gen(function* () {
    const sessions = yield* Session;
    const registries = yield* Registry;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const sessionId = sessionSocketId(request);

        if (sessionId !== undefined) return yield* connectSession(sessions, registries, sessionId);

        if (isRegistryRpc(request)) return yield* serveRegistryRpc(registries);

        return hello;
      }),
    };
  }).pipe(
    // The Worker's init is its entry point.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(
      SessionLive.pipe(Layer.provide(ModelProxyConfigLive), Layer.provideMerge(RegistryLive)),
    ),
  ),
) {}
