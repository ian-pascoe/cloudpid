import { fileURLToPath } from "node:url";
import { BROWSER_HOST_BINDING, Browsers } from "@cloudpid/browser";
import { WebConfigLive } from "@cloudpid/extensions/web";
import { WORKER_OBSERVABILITY } from "@cloudpid/telemetry/observability";
import { CODEMODE_SANDBOX_BINDING, CodemodeSandboxes } from "@cloudpid/codemode-sandbox";
import {
  MCP_ENGINE_BINDING,
  MCP_ENGINE_ENTRYPOINT,
  MCP_SERVER_BINDING,
  MCP_SERVER_ENTRYPOINT,
  type McpServerBinding,
  McpWorker,
} from "@cloudpid/mcp-worker";
import * as Alchemy from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Namespace from "alchemy/Namespace";
import * as Command from "alchemy/Command";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { workspaceAttachmentFiles } from "./attachments.ts";
import { connectSession } from "./connect.ts";
import { deployment, STAGE_LABEL_VAR } from "./deployment.ts";
import { accessProps } from "./access-props.ts";
import { bypassAccessProps } from "./bypass-access.ts";
import { guardedRoutes, isStartRequest } from "./sign-in-routes.ts";
import {
  serveCallback,
  serveClientDocument,
  serveStart,
  type SignInEnv,
} from "./mcp/sign-in-http.ts";
import { type GuardEnv, guardFromEnv, loadTeamKeysFromAccess, teamKeys } from "./access.ts";
import { type AssetLayer, serveAsset } from "./assets.ts";
import { WEB_NOT_FOUND_HANDLING } from "./assets-config.ts";
import { buildUpkeep } from "./registry/builds.ts";
import { draftBranches, githubBranches } from "./registry/draft-branches.ts";
import { skillDirectoryOver } from "./registry/skill-directory.ts";
import { githubSkillReader } from "./registry/skill-reader.ts";
import { skillReposOver } from "./registry/skill-repo.ts";
import { searchSkillsSh } from "./registry/skill-search.ts";
import { McpHost, McpHostLive } from "./mcp/McpHost.ts";
import { mcpPushes } from "./mcp/push.ts";
import { mcpStatus } from "./mcp/status.ts";
import { mcpSignInCarry } from "./mcp/sign-in-carry.ts";
import { REGISTRY_NAME, Registry, RegistryLive } from "./registry/Registry.ts";
import {
  legacyCleanup,
  serveRegistryRpc,
  type SessionObjects,
  spareUpkeep,
} from "./registry/rpc.ts";
import { PushConfigLive } from "./push/config.ts";
import { attachmentRoute, isMcpRoute, isRegistryRpc, sessionSocketId } from "./routes.ts";
import { GitHubAppConfig, GitHubAppConfigLive } from "./github/config.ts";
import { serveAttachment } from "./serve-attachment.ts";
import { FileListings, fileListingsLayer } from "./session/file-search.ts";
import { IMAGES_BINDING } from "./session/images.ts";
import { workspaceLookups } from "./session/lookups.ts";
import { SecretsConfigLive } from "./session/secrets.ts";
import {
  destroySessionObject,
  ModelProxyConfigLive,
  Session,
  SessionLive,
} from "./session/Session.ts";
import { WORKSPACE_BINDING } from "./workspace/binding.ts";
import { workspaceObjectsRemote } from "./workspace/lifecycle.ts";
import type { WorkspaceNamespace } from "./session/workspace.ts";
import type { Workspace } from "./workspace/Workspace.ts";
import { Workspaces } from "./workspace/resource.ts";
import {
  LOCAL_AGENT_TOKEN_ID,
  MCP_CALLS_BINDING,
  mcpAccessProps,
  mcpCallsNamespace,
} from "./mcp-access.ts";
import { MCP_CALLS_LIMIT, MCP_CALLS_PERIOD_S } from "./mcp/api.ts";
import { type RateLimiter, serveMcpRoute } from "./mcp/endpoint.ts";

/**
 * The web app (`apps/web`), built at deploy time and served as static assets by this Worker. The Worker runs first
 * (`runWorkerFirst`), so its Access guard covers every request and the files are served after it from the `ASSETS`
 * binding (`serveAsset`): a file the build has, `index.html` for any page load of a path that is no file (a navigation, or a
 * `GET` or `HEAD` that accepts HTML: `/sessions/:id`), and a 404 for a missing `/assets/…` file (`missingAsset`). The Worker's bundle folds the build step away, so only the
 * deploy runs it.
 */
const webAssets = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__ === true) return undefined;

  // Alchemy runs from `infra/`, so the app's directory is resolved from this file, not from a relative path.
  const webDirectory = fileURLToPath(new URL("../../web/", import.meta.url).href);

  const build = yield* Command.Build("WebBuild", {
    command: "bun run build",
    cwd: webDirectory,
    outdir: "dist",
    // The app imports the protocol package's source, which the default scope (the app's own files) would miss.
    memo: { include: ["**/*", "../../packages/protocol/src/**"], lockfile: true },
  });

  return {
    directory: build.outdir,
    hash: build.hash.output,
    notFoundHandling: WEB_NOT_FOUND_HANDLING,
    // The Worker's Access guard must see every request, the web app's files included (D9).
    runWorkerFirst: true,
  };
});

/**
 * The Workspace DO namespace, bound for the Session DOs, which reach it with the raw stub `ComputerExecutionEnv` needs
 * (`docs/architecture/overview.md` → Durable Objects). The Workspace DO lives in the `Workspaces` Worker; its script name is the Output,
 * not a literal, so that Worker deploys first. Only the deploy declares it: the bundle reads the binding from `env`.
 */
const workspaceBinding = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__ === true) return undefined;

  const workspaces = yield* Workspaces;

  return {
    [WORKSPACE_BINDING]: Cloudflare.DurableObject<Workspace>("Workspace", {
      scriptName: workspaces.workerName,
    }),
  };
});

/**
 * The codemode sandbox DO namespace, bound for the Session DOs, which run their scripts in an object of it (ADR-0005).
 * It lives in the `CodemodeSandboxes` Worker, which deploys first as its script name is the Output. Only the deploy
 * declares it: the bundle reads the binding from `env`.
 */
const sandboxBinding = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__ === true) return undefined;

  const sandboxes = yield* CodemodeSandboxes;

  return {
    [CODEMODE_SANDBOX_BINDING]: Cloudflare.DurableObject("CodemodeSandbox", {
      scriptName: sandboxes.workerName,
    }),
  };
});

/**
 * The browser host DO namespace, bound for the Session DOs, which keep their browser in an object of it (ADR-0007). It
 * lives in the `Browsers` Worker, which deploys first as its script name is the Output, after the `Workspaces` Worker,
 * whose Container previews entrypoint it binds (ADR-0023). Only the deploy declares it: the bundle reads the binding
 * from `env`.
 */
const browserBinding = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__ === true) return undefined;

  const workspaces = yield* Workspaces;
  const browsers = yield* Browsers({ workspaces });

  return {
    [BROWSER_HOST_BINDING]: Cloudflare.DurableObject("BrowserHost", {
      scriptName: browsers.workerName,
    }),
  };
});

/**
 * `McpWorker`'s two entrypoints, bound through the Worker's Output, not a literal name, so `McpWorker` deploys first: its
 * `McpEngine`, for `McpHost`, which runs the MCP SDK through it (ADR-0038; `docs/architecture/mcp-connections.md` → The
 * engine), and its `McpServer`, which serves `/mcp` (`docs/architecture/mcp-endpoint.md` → The handler). Only the deploy
 * declares them: the bundle reads the bindings from `env`.
 */
const mcpBindings = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__ === true) return undefined;

  const mcpWorker = yield* McpWorker;

  return {
    [MCP_ENGINE_BINDING]: Cloudflare.WorkerEntrypoint(mcpWorker, MCP_ENGINE_ENTRYPOINT),
    [MCP_SERVER_BINDING]: Cloudflare.WorkerEntrypoint(mcpWorker, MCP_SERVER_ENTRYPOINT),
  };
});

/**
 * Deploy-time props, resolved from the stage: the Worker's name, where it is served, its Access application and the
 * guard's vars (`accessProps`) and, off `prod`, the label var (`deployment.ts`), with the stage's `MCP_CLIENT_DOCUMENT`
 * var (on, except under `alchemy dev`). A deployed stage also declares the MCP endpoint's own Access application and
 * the Local agent's service token (`mcpAccessProps`), whose `aud` and client ID are the Worker's vars
 * `CLOUDPID_MCP_ACCESS_AUD` and `MCP_SERVICE_TOKEN_CLIENT_ID`, and the Bypass application of the two public sign-in paths
 * (`bypassAccessProps`), which the Worker takes no var from. The stage is absent once the Worker
 * runs (the props only matter at deploy time), so that case falls back to a non-prod stage.
 */
const props = Effect.gen(function* () {
  const stage = Option.getOrElse(yield* Effect.serviceOption(Alchemy.Stage), () => "runtime");
  // Read once, and passed to everything below. Where the bundle runs the props only matter at deploy time, and there is
  // no context to read.
  const runtime = globalThis.__ALCHEMY_RUNTIME__ === true;
  const dev = runtime ? false : (yield* AlchemyContext).dev;
  const { label, access, env: deploymentEnv, ...workerProps } = deployment(stage, { dev });

  // The Worker's own Access application, declared here as the `Server/Access` the Worker's `access: { policies }` form
  // made (same logical id, so a deploy updates it in place), so that its `aud` can be a var of the Worker.
  const accessGuardProps = yield* accessProps({
    declare: Cloudflare.Access.Application("Access", {
      type: "self_hosted",
      policies: access.policies,
    }).pipe(Namespace.push("Server")),
    runtime,
    dev,
  });

  // The `<label>` of the App sandbox's `<hash>--<label>` View URLs, set on non-prod stages only: prod's Views have no
  // suffix. Never taken from a request's `Host`.
  const stageLabelVar = label === undefined ? {} : { [STAGE_LABEL_VAR]: label };

  // The MCP endpoint's own Access application and the Local agent's service token (mcp-access.ts), whose `aud` and client
  // id are vars of the Worker. Declared under `Server/` like the Worker's own application.
  const mcpAccess = yield* mcpAccessProps({
    stage,
    runtime,
    dev,
    declare: {
      serviceToken: (tokenProps) =>
        Cloudflare.Access.ServiceToken(LOCAL_AGENT_TOKEN_ID, tokenProps).pipe(
          Namespace.push("Server"),
        ),
      application: (applicationProps) =>
        Cloudflare.Access.Application("McpAccess", applicationProps).pipe(Namespace.push("Server")),
    },
  });

  // The Bypass application of the two public sign-in paths (bypass-access.ts): nothing under `alchemy dev`, which has no
  // Access. Declared under `Server/` like the others, and independent of the Worker (it names its host and paths).
  yield* bypassAccessProps({
    stage,
    runtime,
    dev,
    declare: (applicationProps) =>
      Cloudflare.Access.Application("Bypass", applicationProps).pipe(Namespace.push("Server")),
  });

  return {
    main: import.meta.url,
    compatibility: { date: "2026-08-31" },
    ...workerProps,
    ...accessGuardProps.props,
    observability: WORKER_OBSERVABILITY,
    assets: yield* webAssets,
    env: {
      ...accessGuardProps.vars,
      ...deploymentEnv,
      ...stageLabelVar,
      ...(yield* workspaceBinding),
      ...(yield* sandboxBinding),
      ...(yield* browserBinding),
      ...(yield* mcpBindings),
      // The Images binding the Session DOs' `read` prepares images with; `alchemy dev` emulates it with sharp.
      [IMAGES_BINDING]: Cloudflare.Images.Images(IMAGES_BINDING),
      // The MCP endpoint's rate limit (120 calls per 60 s per identity; docs/architecture/mcp-endpoint.md → Limits and errors).
      [MCP_CALLS_BINDING]: Cloudflare.RateLimit(MCP_CALLS_BINDING, {
        namespaceId: mcpCallsNamespace(stage),
        simple: { limit: MCP_CALLS_LIMIT, period: MCP_CALLS_PERIOD_S },
      }),
      // The deployed version, which `describe()` reports as the MCP endpoint's `serverInfo.version`.
      CF_VERSION_METADATA: Cloudflare.Workers.VersionMetadata(),
      ...mcpAccess.vars,
    },
  };
});

/** The main Worker. This file is its own entry, so it is bundled as written. */
export default class Server extends Cloudflare.Worker<Server>()(
  "Server",
  props,
  Effect.gen(function* () {
    const sessions = yield* Session;
    const registries = yield* Registry;
    const mcpHosts = yield* McpHost;
    // The raw environment: the Workspace DO's own stub, as the Session DOs take it.
    const worker = yield* Cloudflare.WorkerEnvironment;
    // What runs after an answer: the wipe of what is left from before Environments, and the upkeep of the spares and
    // the Builds.
    const execution = yield* Cloudflare.WorkerExecutionContext;

    // SAFETY: the Server Worker binds the Workspace DO namespace as `WORKSPACES` (above), a raw namespace; Attachments
    // are written through the file operations a Session's environment uses.
    const attachmentFiles = (objectName: string) =>
      workspaceAttachmentFiles(worker[WORKSPACE_BINDING] as WorkspaceNamespace, objectName);

    // SAFETY: the same binding; the Workspace DO answers `LifecycleHost.destroy`.
    const workspaces = workspaceObjectsRemote(
      worker[WORKSPACE_BINDING] as Parameters<typeof workspaceObjectsRemote>[0],
    );

    // A Session's object is found anew for each call; any failure of the call is a defect the endpoint reports.
    const sessionObjects: SessionObjects = {
      stop: (id) => Effect.orDie(sessions.getByName(id).stopAll()),
      destroy: destroySessionObject(sessions),
      forkSource: (id, request) => Effect.orDie(sessions.getByName(id).forkSource(request)),
      exportEntries: (id, request) => Effect.orDie(sessions.getByName(id).exportEntries(request)),
      importStart: (id) => Effect.orDie(sessions.getByName(id).importStart()),
      importEntries: (id, entries) => Effect.orDie(sessions.getByName(id).importEntries(entries)),
      importFinish: (id, plan) => Effect.orDie(sessions.getByName(id).importFinish(plan)),
      releaseFork: (id) => Effect.orDie(sessions.getByName(id).releaseFork()),
      deleteSubagent: (id, agent, workspace) =>
        Effect.orDie(sessions.getByName(id).deleteSubagent({ agent, workspace })),
    };

    // Built once per isolate, so a cleanup that found nothing left is not asked again.
    const legacy = legacyCleanup(registries, { sessions: sessionObjects, workspaces });
    // Built once per isolate too: the upkeep of every spare stops once a run finds nothing to do, and so does the Builds'.
    const spares = spareUpkeep(registries, { workspaces });
    // A new good Build makes its Environment's spare stale, so the Builds' upkeep looks at the spare then.
    const builds = buildUpkeep(registries, { workspaces, spares });

    // The MCP server set goes to an Environment's host after the owner's saves and Repo changes (`mcpPending` names the
    // Environments whose set differs from what their host was told, so one with no servers is never woken).
    const mcp = mcpPushes({
      registry: () => registries.getByName(REGISTRY_NAME),
      host: (name) => mcpHosts.getByName(name),
    });

    // The MCP status reads of the client: the Registry says which servers an Environment has, and its host answers from
    // its own storage, so no Container is started and an Environment with no servers never wakes a host.
    const mcpStatusReads = mcpStatus({
      registry: () => registries.getByName(REGISTRY_NAME),
      host: (name) => mcpHosts.getByName(name),
    });

    // A completed MCP sign-in (and, later, a sign-out or a rebind) goes to the hosts of the Environments that use it.
    const signInCarry = mcpSignInCarry({ host: (name) => mcpHosts.getByName(name) });

    // The draft composer's lookups. The listings of its `@` menu are held per isolate, as a Session holds its own, in a
    // scope that is never closed: it lives as long as the isolate.
    const listings = yield* Layer.buildWithScope(fileListingsLayer(), yield* Scope.make()).pipe(
      Effect.map(Context.get(FileListings)),
    );

    // SAFETY: the same binding, the raw namespace whose stubs `ComputerExecutionEnv` needs.
    const lookups = workspaceLookups(worker[WORKSPACE_BINDING] as WorkspaceNamespace, listings);

    // The draft's Start from menu, asked of GitHub with a read-only token of the GitHub App; each repo's list is kept for
    // 60 s per isolate, and the token until less than 45 minutes are left of it.
    const github = yield* GitHubAppConfig;
    const branches = draftBranches(githubBranches(github));

    // The repo page's Skills, read with a read-only token of the GitHub App (one reader, so one token) and kept by blob in
    // the Worker's cache (a Durable Object has none). `caches` exists only in a request's isolate, not where the stack is
    // planned (`alchemy dev` and a deploy run this init in Node), so the cache is looked up per call.
    const skillRepos = skillReposOver({
      reader: githubSkillReader(github),
      cache: {
        match: (url) => caches.default.match(url),
        put: (url, response) => caches.default.put(url, response),
      },
    });

    // The two public sign-in paths go first, ahead of the guard: a bypass application reaches further than the two paths
    // it names, and no other form of them may reach the single-page app's fallback or the assets (`guardedRoutes`,
    // sign-in-routes.ts). The two exact ones are the client document and the OAuth callback (`mcp/sign-in-http.ts`); the
    // start is behind the guard.
    //
    // The guard of every other route (docs/architecture/mcp-sign-in.md → The Access guard): the Worker verifies the Access
    // assertion itself and refuses the rest, so a request that reached it some other way (a bypass application's wider
    // paths, a service binding) gets a 403. The deploy put its vars in the Worker's environment.
    // SAFETY: the deploy sets the sign-in vars as strings (`deployment()`'s env, the label var), and nothing else puts a value under their names.
    const signInEnv = worker as SignInEnv;
    const registry = () => registries.getByName(REGISTRY_NAME);

    // SAFETY: the deploy sets these vars as strings (`guardVars`), and nothing else puts a value under their names.
    const guard = guardedRoutes(
      {
        ...guardFromEnv(worker as GuardEnv),
        keys: teamKeys(loadTeamKeysFromAccess),
      },
      {
        clientDocument: serveClientDocument(signInEnv),
        callback: (path) => serveCallback(registry, path, signInCarry),
      },
    );

    // SAFETY: the Worker's assets are bound as `ASSETS` (the Fetcher of the asset layer), as the deploy declares them.
    const assets = worker.ASSETS as AssetLayer;

    // `/mcp`, after the guard (docs/architecture/mcp-endpoint.md → The handler). SAFETY: the deploy binds `McpWorker`'s
    // `McpServer` entrypoint as `MCP_SERVER` (`mcpBindings`) and the rate limit as `MCP_CALLS`, which `alchemy dev` may lack.
    const mcpRoute = serveMcpRoute({
      registries,
      sessions,
      objects: { workspaces, sessions: sessionObjects },
      spares,
      builds,
      background: (effect) => execution.waitUntil(effect),
      server: worker[MCP_SERVER_BINDING] as McpServerBinding,
      calls: worker[MCP_CALLS_BINDING] as RateLimiter | undefined,
      // SAFETY: the deploy binds the version metadata as `CF_VERSION_METADATA` (an `{ id }`); `alchemy dev` may lack it.
      version: (worker["CF_VERSION_METADATA"] as { readonly id?: string } | undefined)?.id,
    });

    return {
      fetch: guard(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;

          // The MCP endpoint's own audience and its two kinds of caller are the guard's (`isMcpRoute`); this is its route.
          if (isMcpRoute(request)) return yield* mcpRoute;

          const sessionId = sessionSocketId(request);

          if (sessionId !== undefined)
            return yield* connectSession(sessions, registries, sessionId);

          const attachment = attachmentRoute(request);

          if (attachment !== undefined) {
            return yield* serveAttachment(registries, attachmentFiles, attachment);
          }

          // The start of an MCP sign-in: behind the guard, and the link's own request.
          if (isStartRequest(request)) return yield* serveStart(registry, signInEnv);

          if (isRegistryRpc(request))
            return yield* serveRegistryRpc(registries, {
              workspaces,
              sessions: sessionObjects,
              legacy,
              spares,
              builds,
              mcp,
              mcpStatus: mcpStatusReads,
              lookups,
              branches,
              skillSearch: searchSkillsSh,
              // The Worker's own cache: a Durable Object has none.
              skillDirectory: skillDirectoryOver({ cache: caches.default }),
              skillRepos,
              background: (effect) => execution.waitUntil(effect),
            });

          // None of the routes above: the web app's files, served after the guard.
          return yield* serveAsset(assets);
        }),
      ),
    };
  }).pipe(
    // The Worker's init is its entry point.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(
      SessionLive.pipe(
        Layer.provide(Layer.mergeAll(ModelProxyConfigLive, SecretsConfigLive, WebConfigLive)),
        // The Session DOs call their Environment's MCP host.
        Layer.provideMerge(McpHostLive),
        // The Session DOs refuse the app's key in a variable; the Worker asks GitHub for the draft's branches as the app.
        Layer.provideMerge(GitHubAppConfigLive),
        Layer.provideMerge(
          RegistryLive.pipe(
            Layer.provide(Layer.mergeAll(PushConfigLive, SecretsConfigLive, GitHubAppConfigLive)),
          ),
        ),
      ),
    ),
  ),
) {}
