import { BROWSER_HOST_BINDING } from "@cloudpid/browser/binding";
import { CODEMODE_SANDBOX_BINDING } from "@cloudpid/codemode-sandbox/binding";
import {
  BrowserError,
  BrowserHost,
  BrowserHandoffs,
  browserPaneLayer,
  BrowserSession,
  browserSessionLayer,
  imageLimitedModels,
} from "@cloudpid/extensions/browser";
import { WorkspaceContainer } from "@cloudpid/extensions/container";
import { EnvironmentRemoval } from "@cloudpid/extensions/approval-tools";
import { Approvals } from "@cloudpid/extensions/approvals";
import { DeployCredentials, Environments } from "@cloudpid/extensions/environment";
import { WorkspaceFiles } from "@cloudpid/extensions/files";
import { Images } from "@cloudpid/extensions/images";
import { OwnerNotifications } from "@cloudpid/extensions/notify";
import { scrubbingModels, Secrets } from "@cloudpid/extensions/secrets";
import { SettingsAccess } from "@cloudpid/extensions/settings";
import { SubagentSettings, SubagentWorkspaces } from "@cloudpid/extensions/subagents";
import { ToolSearchSettings } from "@cloudpid/extensions/tool-search";
import { WebConfig } from "@cloudpid/extensions/web";
import {
  telemetryLayer,
  tracingModels,
  tracingTools,
  workersTelemetry,
  type WorkersTracing,
} from "@cloudpid/telemetry";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import * as Tracer from "effect/Tracer";
import { githubAppKeyForms } from "../github/app.ts";
import { GitHubAppConfig } from "../github/config.ts";
import { REGISTRY_NAME, Registry } from "../registry/Registry.ts";
import { buildUpkeep } from "../registry/builds.ts";
import { spareUpkeep } from "../registry/rpc.ts";
import { removals } from "../registry/removal.ts";
import { sumContainerUsage } from "./container-cost.ts";
import { sessionSubagentWorkspaces } from "./subagent-workspaces.ts";
import { workspaceObjectsRemote } from "../workspace/lifecycle.ts";
import { sessionLifecycle } from "./environment-lifecycle.ts";
import { runChanges } from "./agent-changes.ts";
import { sessionEnvironments } from "./environments.ts";
import { sessionEnvironmentRemoval } from "./environment-removal.ts";
import { sessionApprovalsLayer } from "./approvals.ts";
import { sessionSettingsAccess } from "./settings-access.ts";
import { WORKSPACE_BINDING } from "../workspace/binding.ts";
import { type BrowserHostNamespace, remoteBrowserHost } from "./browser.ts";
import { CodemodeSandbox, type CodemodeSandboxNamespace, remoteSandbox } from "./codemode.ts";
import type { PushEvent } from "../push/notification.ts";
import { sessionExtensions } from "./extensions.ts";
import { IMAGES_BINDING } from "./images.ts";
import { NOTIFY_TIMEOUT, SessionHost, sessionHostLayer } from "./host.ts";
import { SessionError } from "./errors.ts";
import type { ExportPage, ExportRequest, ForkPlan, ForkSourceRequest } from "./fork.ts";
import type { EntryRecord } from "@earendil-works/pi-durable";
import {
  reloadSessionExtensions,
  sessionSettingsLayer,
  subagentSettings,
  toolSearchSettings,
} from "./settings.ts";
import { proxyModels } from "./models.ts";
import { sessionBrowserHandoffsLayer } from "./handoffs.ts";
import { sessionOwnerTabDriversLayer } from "./owner-tab-drivers.ts";
import { sessionKeepSecrets } from "./secret-keeping.ts";
import { SecretsConfig, sessionSecretsLayer } from "./secrets.ts";
import {
  annotationsMessage,
  send,
  SessionSockets,
  sessionSocketsLayer,
  viewedMessage,
} from "./sockets.ts";
import { AnnotationStore, annotationStoreLayer } from "./annotations.ts";
import { viewedStoreLayer } from "./viewed.ts";
import { changesRefreshingTools, SessionChanges, sessionChangesLayer } from "./changes.ts";
import { sessionComparisonsLayer } from "./comparisons.ts";
import { runsOpeningTools, SessionRuns, sessionRunsLayer } from "./runs.ts";
import { annotationsPruningTools, SessionReviews, sessionReviewsLayer } from "./reviews.ts";
import { destroySession, SESSION_DELETED_REASON, stopSession } from "./lifecycle.ts";
import { onIdle, wakeAt } from "./wake.ts";
import {
  cachedPlacement,
  type Placement,
  sessionWorkspace,
  type WorkspaceNamespace,
  workspacePlacement,
} from "./workspace.ts";
import { WORKSPACE_ROOT, workspaceObjectName } from "../workspace/binding.ts";
import { workspacePreparation } from "../workspace/prepare.ts";
import { ReportError, SessionRegistry } from "./status.ts";

/**
 * Workers' tracing API (`cloudflare:workers`), where the runtime has one. It is read when an object is built, not when
 * the module loads: the stack imports this module under Node, which has no such module.
 */
const workersTracing = (): Promise<WorkersTracing | undefined> =>
  import("cloudflare:workers").then(
    (workers) => workers.tracing,
    () => undefined,
  );

/** The key the Session's name is kept under, for instances that are not told it. */
const NAME_KEY = "session-name";

/**
 * The key the Session's placement (its Workspace and the directory it works in) is kept under, once the Registry has
 * told it. Not the key Sessions bound to Machines kept theirs under (`session-placement`): those are wiped at the cutover
 * to Environments (ADR-0016), and until then are not listed, so they never read one.
 */
const PLACEMENT_KEY = "workspace-placement";

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
 * What the Session DO answers: its alarm, and its clients' sockets (`docs/architecture/client-and-protocol.md`). `fetch`
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
  /** Stop everything the Session runs (its root and every subagent): the owner archived it. */
  readonly stopAll: () => Effect.Effect<void, SessionError>;
  /** What a Fork or Clone of this Session carries besides the entries: the main Worker makes one (`forkSession`). */
  readonly forkSource: (request: ForkSourceRequest) => Effect.Effect<ForkPlan, SessionError>;
  /** A page of the entries a Fork or Clone of this Session copies. */
  readonly exportEntries: (request: ExportRequest) => Effect.Effect<ExportPage, SessionError>;
  /** Start filling this new Session as a Fork or Clone; it takes no message until `importFinish`. */
  readonly importStart: () => Effect.Effect<void, SessionError>;
  /** Append a page of the source's entries, renumbered. */
  readonly importEntries: (
    entries: ReadonlyArray<EntryRecord>,
  ) => Effect.Effect<void, SessionError>;
  /** Take the agent and documents a Fork or Clone carries, and take messages from then on. */
  readonly importFinish: (plan: ForkPlan) => Effect.Effect<void, SessionError>;
  /** Take messages again once a Fork or Clone in a new Workspace carried this Session's files. */
  readonly releaseFork: () => Effect.Effect<void>;
  /**
   * Delete subagent `agent` with everything below it and their Subagent Workspaces: the owner removed its Subagent
   * Workspace `workspace` (an agent that does not work in it is kept). Answers why a Subagent Workspace of theirs is
   * still there, one line each.
   */
  readonly deleteSubagent: (input: {
    readonly agent: string;
    readonly workspace: string;
  }) => Effect.Effect<ReadonlyArray<string>, SessionError>;
  /** Delete the Session's own state (`destroySession`): the owner deleted it, and the Registry forgets it next. */
  readonly destroy: () => Effect.Effect<void>;
  /**
   * Reset the object (`ctx.abort`) after `destroy` has answered, so the next event (if any) finds no instance over the
   * wiped storage. The call always fails with `SESSION_DELETED_REASON`, as an abort fails the call that makes it.
   */
  readonly reset: () => Effect.Effect<void>;
};

/** One Session: a pi-durable Harness over this object's SQLite storage (`docs/architecture/overview.md` → Session host). */
export class Session extends Cloudflare.DurableObject<Session, SessionMethods>()("Session", {
  errors: [SessionError],
}) {}

/** The Session objects as a Worker or another Session reaches them, by name. */
type SessionNamespace = Pick<Cloudflare.DurableObject<Session>, "getByName">;

/**
 * Wipe Session `id`'s object (`SessionMethods.destroy`), then reset it. Once the wipe has answered, the object resets:
 * that call fails by design (an abort fails the call that makes it), and a reset that does not happen only leaves an
 * instance over empty storage until it is evicted. A wipe that fails dies.
 */
export const destroySessionObject =
  (sessions: SessionNamespace) =>
  (id: string): Effect.Effect<void> => {
    const session = sessions.getByName(id);

    return Effect.orDie(session.destroy()).pipe(
      Effect.andThen(Effect.ignoreCause(session.reset())),
    );
  };

export const SessionLive = Session.make(
  Effect.gen(function* () {
    return {
      proxy: yield* ModelProxyConfig,
      github: yield* GitHubAppConfig,
      secrets: yield* SecretsConfig,
      web: yield* WebConfig,
      registries: yield* Registry,
      // The other Sessions' objects, which deleting an Environment the owner approved wipes (`environment_delete`).
      // This class's own namespace, which alchemy hands its constructor (not `yield* Session`: this Layer provides it).
      // SAFETY: the namespace of the class this constructor makes, whose objects answer `SessionMethods`.
      sessions: (yield* Cloudflare.DurableObjectScope) as Cloudflare.DurableObject<Session>,
      state: yield* Cloudflare.DurableObjectState,
      // The raw environment: `ComputerExecutionEnv` needs the Workspace DO's own stub, not alchemy's Effect client.
      worker: yield* Cloudflare.WorkerEnvironment,
    };
  }).pipe(
    // The outer Effect resolves the shared services; this inner one runs once per instance, in its constructor.
    Effect.map(({ github, proxy, registries, sessions, secrets, state, web, worker }) =>
      Effect.gen(function* () {
        // One tracer for the object's life: its spans are custom spans of the Worker's trace (`docs/architecture/operations.md` → Telemetry).
        const telemetry = workersTelemetry(yield* Effect.promise(workersTracing));

        /** `effect` as an invocation of the object: a span of its own, under the tracer every Session span is made by. */
        const invoked = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.withSpan(name),
            Effect.provideService(Tracer.Tracer, telemetry.tracer),
          );

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
          reportAgents: (agents) =>
            name === undefined
              ? ReportError.make({ message: "The Session's name is unknown" })
              : registries.getByName(REGISTRY_NAME).setSessionAgents({ id: name, agents }),
          notify: (event) =>
            name === undefined
              ? ReportError.make({ message: "The Session's name is unknown" })
              : registries.getByName(REGISTRY_NAME).notify({ sessionId: name, event }),
          titleWanted:
            name === undefined
              ? ReportError.make({ message: "The Session's name is unknown" })
              : registries
                  .getByName(REGISTRY_NAME)
                  .getSession({ id: name })
                  .pipe(
                    // A Session the Registry does not know has nowhere to keep a title.
                    Effect.map((session) => session !== null && session.titleSource === null),
                  ),
          setTitle: (title) =>
            name === undefined
              ? ReportError.make({ message: "The Session's name is unknown" })
              : registries
                  .getByName(REGISTRY_NAME)
                  .setGeneratedTitle({ id: name, title })
                  .pipe(Effect.asVoid),
        } satisfies (typeof SessionRegistry)["Service"];

        const registry = Layer.succeed(SessionRegistry, sessionRegistry);

        /** Push to the owner without ever failing or stalling: a notification is not worth a Run. */
        const notifyOwner = (event: PushEvent) =>
          sessionRegistry.notify(event).pipe(Effect.timeout(NOTIFY_TIMEOUT), Effect.ignore);

        const placement = cachedPlacement({
          name,
          get: () => kv.get<Placement>(PLACEMENT_KEY),
          put: (known) => kv.put(PLACEMENT_KEY, known),
          lookup: (id) =>
            runtime.runPromise(
              Effect.gen(function* () {
                const registry = registries.getByName(REGISTRY_NAME);
                const session = yield* registry.getSession({ id });

                if (session === null) return null;

                const workspace = yield* registry.getWorkspace({ id: session.workspace });

                // A Workspace removed meanwhile takes the Session with it; until then it works at the root.
                return workspacePlacement(
                  session.workspace,
                  workspace?.directory ?? WORKSPACE_ROOT,
                );
              }),
            ),
        });

        // SAFETY: the Server Worker binds the Workspace DO namespace as `WORKSPACES` (`worker.ts`), a raw namespace.
        const workspaces = worker[WORKSPACE_BINDING] as WorkspaceNamespace;

        // A Setup Script that fails is reported in the Worker log; the Session's commands see its state.
        const prepare = workspacePreparation(workspaces, (message) =>
          // @effect-diagnostics-next-line globalConsole:off
          console.warn(message),
        );

        const workspace = sessionWorkspace({
          namespace: workspaces,
          placement,
          // What the Workspace is made of is the Registry's; a Workspace it no longer lists is left as it is.
          // @effect-diagnostics-next-line asyncFunction:off
          prepare: async (id) => {
            // The Registry hands the Environment's Skill set only when it is not the one the Workspace holds.
            const skillSetHash = await workspaces.getByName(workspaceObjectName(id)).skillSetHash();

            const setup = await runtime.runPromise(
              registries.getByName(REGISTRY_NAME).getWorkspaceSetup({ id, skillSetHash }),
            );

            if (setup !== null) await prepare(workspaceObjectName(id), setup);
          },
        });

        // The Builds' upkeep after an Agent change, as the main Worker runs it after the owner's save, and the
        // Environments the agent reads and changes.
        // SAFETY: the same binding; the Workspace DO answers `LifecycleHost`'s calls and the Build object's.
        const workspaceObjects = workspaceObjectsRemote(
          worker[WORKSPACE_BINDING] as Parameters<typeof workspaceObjectsRemote>[0],
        );

        const spares = spareUpkeep(registries, { workspaces: workspaceObjects });
        const builds = buildUpkeep(registries, { workspaces: workspaceObjects, spares });

        const registryObject = registries.getByName(REGISTRY_NAME);

        const environments = sessionEnvironments({
          registry: registryObject,
          session: name,
          placement,
          handOver: (object, overrides) =>
            workspaces.getByName(object).updateContainerSettings(overrides),
          handSkills: (object, set) => workspaces.getByName(object).updateSkills(set),
          builds,
          lifecycle: sessionLifecycle({ registry: registryObject, session: name, builds, spares }),
        });

        // The deletes the owner approved: an Environment with its Workspaces and Sessions, wiped as the owner's delete
        // wipes them (`removals`, `registry/removal.ts`), and a kept Secret.
        const environmentRemoval = sessionEnvironmentRemoval({
          registry: registryObject,
          session: name,
          objects: {
            workspaces: workspaceObjects,
            sessions: { destroy: destroySessionObject(sessions) },
          },
          builds,
        });

        // The Session's Subagent Workspaces: registered by the Registry as the Session's, removed as a Workspace is.
        const subagentWorkspaces = sessionSubagentWorkspaces({
          registry: registryObject,
          session: name,
          placement,
          objects: workspaceObjects,
          remove: removals(registryObject, {
            workspaces: workspaceObjects,
            sessions: { destroy: destroySessionObject(sessions) },
          }).removeSubagentWorkspace,
          builds,
          run: (effect) => runtime.runPromise(effect),
        });

        // The Agent changes waiting for the owner's Approval: kept here, shown on the sockets, and pushed.
        const sessionApprovals = sessionApprovalsLayer({
          storage: kv,
          sockets: state.raw,
          notify: notifyOwner,
        });

        // The owner's draft Annotations: kept here, and sent to every client whenever they change.
        const sessionAnnotations = annotationStoreLayer({
          storage: kv,
          announce: (drafts) =>
            Effect.forEach(
              state.raw.getWebSockets(),
              (socket) => send(socket, annotationsMessage(drafts)),
              { discard: true },
            ),
        });

        // The owner's Viewed boxes on pull requests: kept here, and sent to every client whenever they change.
        const sessionViewed = viewedStoreLayer({
          storage: kv,
          announce: (viewed) =>
            Effect.forEach(
              state.raw.getWebSockets(),
              (socket) => send(socket, viewedMessage(viewed)),
              { discard: true },
            ),
        });

        // One sandbox object per Session, named by the Session's ID, in the sandbox Worker's own isolate.
        const sandbox = remoteSandbox(
          // SAFETY: the Server Worker binds the sandbox DO namespace as `CODEMODE_SANDBOX` (`worker.ts`), a raw namespace.
          worker[CODEMODE_SANDBOX_BINDING] as CodemodeSandboxNamespace,
          name ?? state.raw.id.toString(),
        );

        // One browser host object per Session, in the browser Worker, which keeps the Session's one Browser Run browser.
        // The calls that can acquire a browser name the Session's Workspace, which its Container previews reach (ADR-0023).
        const browser = remoteBrowserHost(
          // SAFETY: the Server Worker binds the browser host DO namespace as `BROWSER_HOST` (`worker.ts`), a raw namespace.
          worker[BROWSER_HOST_BINDING] as BrowserHostNamespace,
          name ?? state.raw.id.toString(),
          // @effect-diagnostics-next-line asyncFunction:off
          async () => {
            const { workspace: id, object } = await placement();

            return id === null ? undefined : object;
          },
        );

        // The Images binding `read` prepares images with, so each fits the conversation.
        // SAFETY: the Server Worker binds the Images binding as `IMAGES` (`worker.ts`).
        const images = worker[IMAGES_BINDING] as ImagesBinding;

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
          // Its Environment's kept Secrets, opened by the Registry, held in memory and asked for again now and then. A
          // Session the Registry does not list has none. Each set is handed to the Workspace before the Session uses
          // it, so no value reaches the Container that the scan before a snapshot does not search for; a set the
          // Workspace did not take is not used (the Session keeps the one it held, and asks again soon).
          kept:
            name === undefined
              ? Effect.succeed([])
              : registries
                  .getByName(REGISTRY_NAME)
                  .sessionSecrets({ session: name })
                  .pipe(
                    Effect.tap((kept) =>
                      Effect.gen(function* () {
                        const { workspace: id } = yield* Effect.tryPromise(() => placement());

                        if (id === null) return;

                        // The Session's Workspace, and each of its Subagent Workspaces.
                        const subagents = yield* registries
                          .getByName(REGISTRY_NAME)
                          .listSubagentWorkspaces({ session: name });

                        yield* Effect.tryPromise(() =>
                          Promise.all(
                            Arr.map([id, ...Arr.map(subagents, (each) => each.id)], (each) =>
                              workspaces
                                .getByName(workspaceObjectName(each))
                                .updateEnvironmentSecrets(kept),
                            ),
                          ),
                        );
                      }),
                    ),
                  ),
          // What the owner chooses to keep in the form is saved in the Registry as the Environments page saves it.
          keep: sessionKeepSecrets({
            registry: registryObject,
            session: name,
            builds,
            changes: runChanges(kv),
          }),
        });

        // The Changes of the Session's Workspace, in the directory the Session works in, and of each Subagent Workspace,
        // in its own (ADR-0024). Read without readying the Workspace, so a listing clones nothing, and only the owner's
        // Refresh may start its Container.
        const sessionChanges = sessionChangesLayer({
          session: {
            // @effect-diagnostics-next-line asyncFunction:off
            list: async (startContainer) => {
              const { workspace: id, object, directory } = await placement();

              if (id === null) return null;

              return workspaces.getByName(object).changes({ directory, startContainer });
            },
            // @effect-diagnostics-next-line asyncFunction:off
            file: async (query) => {
              const { workspace: id, object } = await placement();

              if (id === null) throw new Error("This Session has no Workspace");

              return workspaces.getByName(object).changeFile(query);
            },
          },
          subagent: ({ object, directory }) => ({
            list: (startContainer) =>
              workspaces.getByName(object).changes({ directory, startContainer }),
            file: (query) => workspaces.getByName(object).changeFile(query),
          }),
        });

        // This branch's Comparisons, in the directory the Session works in: asked of the Workspace, which starts its
        // Container only for a request that says so (the owner's pick or Refresh).
        const sessionComparisons = sessionComparisonsLayer({
          // @effect-diagnostics-next-line asyncFunction:off
          sources: async (pulls) => {
            const { workspace: id, object, directory } = await placement();

            if (id === null) return null;

            return workspaces.getByName(object).comparisonSources(directory, pulls);
          },
          // @effect-diagnostics-next-line asyncFunction:off
          compare: async (query) => {
            const { workspace: id, object } = await placement();

            if (id === null) throw new Error("This Session has no Workspace");

            return workspaces.getByName(object).compare(query);
          },
          // @effect-diagnostics-next-line asyncFunction:off
          file: async (query) => {
            const { workspace: id, object } = await placement();

            if (id === null) throw new Error("This Session has no Workspace");

            return workspaces.getByName(object).comparisonFile(query);
          },
        });

        // The Last run: the Workspace copies its repos' files before the Run's first writing call and at its end. Scoped
        // by this Session's ID, since a Workspace may be shared. The Container is never started for a copy.
        const sessionRuns = sessionRunsLayer(
          {
            // @effect-diagnostics-next-line asyncFunction:off
            start: async (request) => {
              const { workspace: id, object, directory } = await placement();

              if (id === null) return null;

              return workspaces
                .getByName(object)
                .runStart({ ...request, scope: state.raw.id.toString(), directory });
            },
            // @effect-diagnostics-next-line asyncFunction:off
            end: async (request) => {
              const { workspace: id, object } = await placement();

              if (id === null) return null;

              return workspaces
                .getByName(object)
                .runEnd({ ...request, scope: state.raw.id.toString() });
            },
            // @effect-diagnostics-next-line asyncFunction:off
            diff: async () => {
              const { workspace: id, object } = await placement();

              if (id === null) return null;

              return workspaces.getByName(object).runDiff(state.raw.id.toString());
            },
            // @effect-diagnostics-next-line asyncFunction:off
            file: async (query) => {
              const { workspace: id, object } = await placement();

              if (id === null) throw new Error("This Session has no Workspace");

              return workspaces
                .getByName(object)
                .runFile({ ...query, scope: state.raw.id.toString() });
            },
          },
          kv,
          {
            announce: (lastRun) =>
              Effect.forEach(
                state.raw.getWebSockets(),
                (socket) => send(socket, { type: "last_run", lastRun }),
                { discard: true },
              ),
          },
        );

        // The Browser Handoffs waiting for the owner: kept here, shown on the sockets, and pushed (with no Live View link).
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

        // The Browser Pane's links (`owner_tab_view`). An archived Session opens nothing in the browser: the Registry
        // says whether it is, for each ask to open; one it does not list is not.
        const sessionBrowserPane = browserPaneLayer({
          host: browser,
          archived:
            name === undefined
              ? Effect.succeed(false)
              : registries
                  .getByName(REGISTRY_NAME)
                  .getSession({ id: name })
                  .pipe(
                    Effect.map((session) => session !== null && session.archivedAt !== null),
                    Effect.mapError((error) =>
                      BrowserError.make({
                        message: `Could not tell whether the Session is archived: ${String(error)}`,
                      }),
                    ),
                  ),
        }).pipe(Layer.provide(sessionBrowser));

        // The object's services, built once and kept for its lifetime. Building the sockets restarts the watches of
        // sockets that outlived the last instance, before any of their events is handled.
        const runtime = ManagedRuntime.make(
          sessionSocketsLayer(state.raw).pipe(
            // Reviews, which the sockets send, place through the host and check against the Changes.
            Layer.provideMerge(sessionReviewsLayer(kv)),
            Layer.provideMerge(
              sessionHostLayer({
                storage: state.raw.storage,
                // Every model call (generations, summaries) is scrubbed of the Secrets this Session holds.
                // Each request is a span too, measured where it leaves for the proxy.
                models: Effect.map(Effect.service(Secrets), (held) =>
                  tracingModels(
                    scrubbingModels(imageLimitedModels(models), held),
                    telemetry.context,
                  ),
                ),
                reset: (reason) => state.raw.abort(reason),
                // Read where the Session and its Subagent Workspaces work, without readying them: it starts nothing.
                // @effect-diagnostics-next-line asyncFunction:off
                containerUsage: async (subagents) => {
                  const { workspace: id, object } = await placement();

                  if (id === null) return null;

                  const read = await Promise.all(
                    Arr.map([object, ...subagents], (each) =>
                      workspaces.getByName(each).containerUsage(),
                    ),
                  );

                  return sumContainerUsage(Arr.filter(read, (usage) => usage !== null));
                },
                subagentWorkspaces,
                extensions: sessionExtensions.pipe(
                  // After every other extension, so each of their tools is named and its call is a span, and the
                  // Changes are listed again after each writing call.
                  // A deleted subagent's drafts are deleted with it.
                  Effect.flatMap((installed) =>
                    Effect.map(
                      Effect.all([
                        Effect.service(SessionChanges),
                        Effect.service(AnnotationStore),
                        Effect.service(SessionRuns),
                      ]),
                      ([changes, annotations, runs]) => {
                        const tools = Arr.flatMap(installed, (extension) => extension.tools ?? []);

                        return [
                          ...installed,
                          tracingTools(telemetry.context, tools),
                          runsOpeningTools(tools, runs),
                          changesRefreshingTools(tools, changes),
                          annotationsPruningTools(tools, annotations),
                        ];
                      },
                    ),
                  ),
                  Effect.provideService(WebConfig, web),
                  Effect.provideService(WorkspaceFiles, workspace.files),
                  Effect.provideService(WorkspaceContainer, workspace.container),
                  Effect.provideService(SubagentWorkspaces, subagentWorkspaces),
                  Effect.provideService(Environments, environments),
                  Effect.provideService(EnvironmentRemoval, environmentRemoval),
                  Effect.provideService(
                    SettingsAccess,
                    sessionSettingsAccess({
                      registry: registries.getByName(REGISTRY_NAME),
                      session: name,
                    }),
                  ),
                  Effect.provideService(DeployCredentials, {
                    values: githubAppKeyForms(github.privateKey.pipe(Redacted.value)),
                  }),
                  Effect.provideService(Images, images),
                  // For extensions that need the owner (a Browser Handoff, say): pushes through the Registry.
                  Effect.provideService(OwnerNotifications, { notify: notifyOwner }),
                  Effect.provideService(CodemodeSandbox, sandbox),
                  Effect.provideService(BrowserHost, browser),
                  Effect.provideServiceEffect(SubagentSettings, subagentSettings),
                  Effect.provideServiceEffect(ToolSearchSettings, toolSearchSettings),
                ),
                reload: reloadSessionExtensions,
                env: workspace.env,
                // The composer's catalog and `@` menu do not wait for the Session's Workspace to be readied.
                lookupEnv: workspace.lookupEnv,
                // An idle Session still wakes when a Secret expires, so its ciphertext is deleted on time, and when the
                // browser falls idle past its keep-alive, so it is closed.
                wakeAt: Effect.flatMap(
                  Effect.all([Effect.service(Secrets), Effect.service(BrowserSession)]),
                  ([held, browser]) => wakeAt(held, browser),
                ),
                // The Last run ends when the Session goes idle.
                onSettled: (newest) =>
                  Effect.flatMap(Effect.service(SessionRuns), (runs) => runs.settled(newest)),
                // A Secret request, Browser Handoff or Approval request whose call is gone stops being shown, and an
                // idle browser is closed.
                onIdle: Effect.flatMap(
                  Effect.all([
                    Effect.service(Secrets),
                    Effect.service(BrowserSession),
                    Effect.service(BrowserHandoffs),
                    Effect.service(Approvals),
                  ]),
                  ([held, browser, handoffs, approvals]) =>
                    onIdle(held, browser, handoffs, approvals),
                ),
              }),
            ),
            Layer.provideMerge(sessionSecrets),
            Layer.provideMerge(sessionChanges),
            Layer.provideMerge(sessionComparisons),
            Layer.provideMerge(sessionRuns),
            Layer.provideMerge(sessionAnnotations),
            Layer.provideMerge(sessionViewed),
            Layer.provideMerge(sessionApprovals),
            Layer.provideMerge(sessionBrowserHandoffs),
            Layer.provideMerge(sessionBrowser),
            // The sockets mint the Browser Pane's links through it (`owner_tab_view`).
            Layer.provideMerge(sessionBrowserPane),
            // The `browser` calls in Owner tabs, told to every client for the Browser Pane (`owner_tab_drivers`).
            Layer.provideMerge(sessionOwnerTabDriversLayer(state.raw)),
            Layer.provide(Layer.mergeAll(registry, settings)),
            // Last, so the object's own Effects (those the host and the sockets run) make their spans there too.
            Layer.provideMerge(telemetryLayer(telemetry)),
          ),
        );

        // A failed open resets the object, and the fallback alarm it armed first starts it again.
        const services = yield* Effect.orDie(runtime.contextEffect);
        const host = Context.get(services, SessionHost);
        const sockets = Context.get(services, SessionSockets);
        const held = Context.get(services, Secrets);
        const reviews = Context.get(services, SessionReviews);

        return {
          // A failed alarm is retried by the runtime. Expired Secrets are deleted first.
          alarm: () =>
            invoked("session.alarm", Effect.orDie(held.sweep.pipe(Effect.andThen(host.alarm)))),
          fetch: invoked(
            "session.connect",
            Effect.gen(function* () {
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
          ),
          webSocketMessage: (socket, message) =>
            invoked("session.message", sockets.receive(socket.ws, message)),
          webSocketClose: (socket) => invoked("session.close", sockets.drop(socket.ws)),
          webSocketError: (socket) => invoked("session.close", sockets.drop(socket.ws)),
          stopAll: () =>
            invoked("session.stop", stopSession.pipe(Effect.provideService(SessionHost, host))),
          forkSource: (request) => invoked("session.fork.source", host.forkSource(request)),
          exportEntries: (request) => invoked("session.fork.export", host.exportEntries(request)),
          importStart: () => invoked("session.fork.start", host.importStart),
          importEntries: (entries) => invoked("session.fork.import", host.importEntries(entries)),
          importFinish: (plan) =>
            invoked(
              "session.fork.finish",
              host.importFinish(plan).pipe(Effect.andThen(sockets.greetAgain)),
            ),
          releaseFork: () => invoked("session.fork.release", host.releaseFork),
          deleteSubagent: ({ agent, workspace }) =>
            invoked(
              "session.subagent.delete",
              host.deleteSubagent(agent, workspace).pipe(
                // The drafts addressed to it go with it.
                Effect.tap(() => reviews.prune),
                Effect.map((deletion) => deletion.kept),
              ),
            ),
          destroy: () =>
            invoked(
              "session.destroy",
              destroySession({ state: state.raw, closeBrowser: browser.close }).pipe(
                Effect.provideService(SessionHost, host),
              ),
            ),
          reset: () => Effect.sync(() => state.raw.abort(SESSION_DELETED_REASON)),
        };
      }),
    ),
  ),
);
