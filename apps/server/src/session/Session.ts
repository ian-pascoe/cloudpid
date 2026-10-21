import { BROWSER_HOST_BINDING } from "@cloudpid/browser/binding";
import { CODEMODE_SANDBOX_BINDING } from "@cloudpid/codemode-sandbox/binding";
import {
  BrowserHost,
  BrowserHandoffs,
  BrowserSession,
  browserSessionLayer,
  imageLimitedModels,
} from "@cloudpid/extensions/browser";
import { WorkspaceFiles } from "@cloudpid/extensions/files";
import { OwnerNotifications } from "@cloudpid/extensions/notify";
import { scrubbingModels, Secrets } from "@cloudpid/extensions/secrets";
import { SubagentSettings } from "@cloudpid/extensions/subagents";
import { WebConfig } from "@cloudpid/extensions/web";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import { REGISTRY_NAME, Registry } from "../registry/Registry.ts";
import { WORKSPACE_BINDING } from "../workspace/binding.ts";
import { type BrowserHostNamespace, remoteBrowserHost } from "./browser.ts";
import { CodemodeSandbox, type CodemodeSandboxNamespace, remoteSandbox } from "./codemode.ts";
import type { PushEvent } from "../push/notification.ts";
import { sessionExtensions } from "./extensions.ts";
import { NOTIFY_TIMEOUT, SessionError, SessionHost, sessionHostLayer } from "./host.ts";
import { sessionSettingsLayer, subagentSettings } from "./settings.ts";
import { proxyModels } from "./models.ts";
import { sessionBrowserHandoffsLayer } from "./handoffs.ts";
import { SecretsConfig, sessionSecretsLayer } from "./secrets.ts";
import { SessionSockets, sessionSocketsLayer } from "./sockets.ts";
import { onIdle, wakeAt } from "./wake.ts";
import {
  cachedPlacement,
  type Placement,
  sessionWorkspace,
  type WorkspaceNamespace,
} from "./workspace.ts";
import { ReportError, SessionRegistry } from "./status.ts";

/** The key the Session's name is kept under, for instances that are not told it. */
const NAME_KEY = "session-name";

/**
 * The key the Session's placement (its Workspace's slug and repo) is kept under, once the Registry has told it. A Session
 * that kept only a slug, under `WORKSPACE_KEY`, was bound before repos existed and works at the Workspace root.
 */
const PLACEMENT_KEY = "session-placement";

const WORKSPACE_KEY = "session-workspace";

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

/**
 * What the Session DO answers: its alarm, and its clients' sockets (`docs/spec.md` → Client and protocol). `fetch`
 * accepts a socket upgrade the main Worker forwards; the socket's events then reach the object directly.
 */
export type SessionMethods = {
  readonly alarm: () => Effect.Effect<void>;
  readonly fetch: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest
  >;
  readonly webSocketMessage: (
    socket: Cloudflare.WebSocket,
    message: string | ArrayBuffer,
  ) => Effect.Effect<void>;
  readonly webSocketClose: (socket: Cloudflare.WebSocket) => Effect.Effect<void>;
  readonly webSocketError: (socket: Cloudflare.WebSocket) => Effect.Effect<void>;
};

/** One Session: a pi-durable Harness over this object's SQLite storage (`docs/spec.md` → Session host). */
export class Session extends Cloudflare.DurableObject<Session, SessionMethods>()("Session", {
  errors: [SessionError],
}) {}

export const SessionLive = Session.make(
  Effect.gen(function* () {
    return {
      proxy: yield* ModelProxyConfig,
      secrets: yield* SecretsConfig,
      web: yield* WebConfig,
      registries: yield* Registry,
      state: yield* Cloudflare.DurableObjectState,
      // The raw environment: `ComputerExecutionEnv` needs the Workspace DO's own stub, not alchemy's Effect client.
      worker: yield* Cloudflare.WorkerEnvironment,
    };
  }).pipe(
    // The outer Effect resolves the shared services; this inner one runs once per instance, in its constructor.
    Effect.map(({ proxy, registries, secrets, state, web, worker }) =>
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

        const sessionRegistry = {
          report: (status) =>
            name === undefined
              ? ReportError.make({ message: "The Session's name is unknown" })
              : registries.getByName(REGISTRY_NAME).setSessionStatus({ id: name, status }),
          notify: (event) =>
            name === undefined
              ? ReportError.make({ message: "The Session's name is unknown" })
              : registries.getByName(REGISTRY_NAME).notify({ sessionId: name, event }),
        } satisfies (typeof SessionRegistry)["Service"];

        const registry = Layer.succeed(SessionRegistry, sessionRegistry);

        /** Push to the owner without ever failing or stalling: a notification is not worth a Run. */
        const notifyOwner = (event: PushEvent) =>
          sessionRegistry.notify(event).pipe(Effect.timeout(NOTIFY_TIMEOUT), Effect.ignore);

        const placement = cachedPlacement({
          name,
          get: () => {
            const known = kv.get<Placement>(PLACEMENT_KEY);

            if (known !== undefined) return known;

            const slug = kv.get<string>(WORKSPACE_KEY);

            return slug === undefined ? undefined : { slug, repo: null };
          },
          put: (known) => kv.put(PLACEMENT_KEY, known),
          lookup: (id) =>
            runtime
              .runPromise(registries.getByName(REGISTRY_NAME).getSession({ id }))
              .then((session) =>
                session === null ? null : { slug: session.workspace, repo: session.repo ?? null },
              ),
        });

        const workspace = sessionWorkspace({
          // SAFETY: the Server Worker binds the Workspace DO namespace as `WORKSPACES` (`worker.ts`), a raw namespace.
          namespace: worker[WORKSPACE_BINDING] as WorkspaceNamespace,
          placement,
        });

        // One sandbox object per Session, named by the Session's ID, in the sandbox Worker's own isolate.
        const sandbox = remoteSandbox(
          // SAFETY: the Server Worker binds the sandbox DO namespace as `CODEMODE_SANDBOX` (`worker.ts`), a raw namespace.
          worker[CODEMODE_SANDBOX_BINDING] as CodemodeSandboxNamespace,
          name ?? state.raw.id.toString(),
        );

        // One browser host object per Session, in the browser Worker, which keeps the Session's one Browser Run browser.
        const browser = remoteBrowserHost(
          // SAFETY: the Server Worker binds the browser host DO namespace as `BROWSER_HOST` (`worker.ts`), a raw namespace.
          worker[BROWSER_HOST_BINDING] as BrowserHostNamespace,
          name ?? state.raw.id.toString(),
        );

        // When the browser was last used is kept in this object's storage; the host's alarm closes it once idle.
        const sessionBrowser = browserSessionLayer({ host: browser, storage: kv });

        // The Registry's saved overrides, read before each request is admitted; the last read is kept in storage.
        const settings = sessionSettingsLayer({
          read: registries
            .getByName(REGISTRY_NAME)
            .getSettings()
            .pipe(Effect.map((saved) => saved.overrides)),
          kv,
        });

        // The Secrets the owner entered, encrypted in this object's storage under a key bound to this object's ID.
        const sessionSecrets = sessionSecretsLayer({
          encryptionKey: secrets.encryptionKey,
          session: state.raw.id.toString(),
          storage: kv,
          sockets: state.raw,
          // A request waits for the owner, who may not have the page open: push it.
          notify: notifyOwner,
        });

        // The Browser Handoffs waiting for the owner: kept here, shown on the sockets, and pushed with their Live View link.
        const sessionBrowserHandoffs = sessionBrowserHandoffsLayer({
          host: browser,
          storage: kv,
          sockets: state.raw,
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              sessionBrowser,
              Layer.succeed(OwnerNotifications, { notify: notifyOwner }),
            ),
          ),
        );

        // The object's services, built once and kept for its lifetime. Building the sockets restarts the watches of
        // sockets that outlived the last instance, before any of their events is handled.
        const runtime = ManagedRuntime.make(
          sessionSocketsLayer(state.raw).pipe(
            Layer.provideMerge(
              sessionHostLayer({
                storage: state.raw.storage,
                // Every model call (generations, summaries) is scrubbed of the Secrets this Session holds.
                models: Effect.map(Effect.service(Secrets), (held) =>
                  scrubbingModels(imageLimitedModels(models), held),
                ),
                reset: (reason) => state.raw.abort(reason),
                extensions: sessionExtensions.pipe(
                  Effect.provideService(WebConfig, web),
                  Effect.provideService(WorkspaceFiles, workspace.files),
                  // For extensions that need the owner (a Live View link, say): pushes through the Registry.
                  Effect.provideService(OwnerNotifications, { notify: notifyOwner }),
                  Effect.provideService(CodemodeSandbox, sandbox),
                  Effect.provideService(BrowserHost, browser),
                  Effect.provideServiceEffect(SubagentSettings, subagentSettings),
                ),
                env: workspace.env,
                // An idle Session still wakes when a Secret expires, so its ciphertext is deleted on time, and when the
                // browser falls idle past its keep-alive, so it is closed.
                wakeAt: Effect.flatMap(
                  Effect.all([Effect.service(Secrets), Effect.service(BrowserSession)]),
                  ([held, browser]) => wakeAt(held, browser),
                ),
                // A Secret request or Browser Handoff whose call is gone stops being shown, and an idle browser is closed.
                onIdle: Effect.flatMap(
                  Effect.all([
                    Effect.service(Secrets),
                    Effect.service(BrowserSession),
                    Effect.service(BrowserHandoffs),
                  ]),
                  ([held, browser, handoffs]) => onIdle(held, browser, handoffs),
                ),
              }),
            ),
            Layer.provideMerge(sessionSecrets),
            Layer.provideMerge(sessionBrowserHandoffs),
            Layer.provideMerge(sessionBrowser),
            Layer.provide(Layer.mergeAll(registry, settings)),
          ),
        );

        // A failed open resets the object, and the fallback alarm it armed first starts it again.
        const services = yield* Effect.orDie(runtime.contextEffect);
        const host = Context.get(services, SessionHost);
        const sockets = Context.get(services, SessionSockets);
        const held = Context.get(services, Secrets);

        return {
          // A failed alarm is retried by the runtime. Expired Secrets are deleted first.
          alarm: () => Effect.orDie(held.sweep.pipe(Effect.andThen(host.alarm))),
          fetch: Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;

            if (request.headers.upgrade?.toLowerCase() !== "websocket") {
              return HttpServerResponse.empty({ status: 426, headers: { upgrade: "websocket" } });
            }

            const client = yield* sockets.connect;

            return HttpServerResponse.setBody(
              HttpServerResponse.empty({ status: 101 }),
              HttpBody.raw(new Response(null, { status: 101, webSocket: client })),
            );
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Session socket upgrade failed", cause).pipe(
                Effect.as(HttpServerResponse.empty({ status: 503 })),
              ),
            ),
          ),
          webSocketMessage: (socket, message) => sockets.receive(socket.ws, message),
          webSocketClose: (socket) => sockets.drop(socket.ws),
          webSocketError: (socket) => sockets.drop(socket.ws),
        };
      }),
    ),
  ),
);
