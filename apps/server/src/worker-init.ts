import { WebConfigLive } from "@cloudpid/extensions/web";
import { MCP_SERVER_BINDING, type McpServerBinding } from "@cloudpid/mcp-worker";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { workspaceAttachmentFiles } from "./attachments.ts";
import { connectSession } from "./connect.ts";
import { guardedRoutes, isStartRequest } from "./sign-in-routes.ts";
import {
  serveCallback,
  serveClientDocument,
  serveStart,
  type SignInEnv,
} from "./mcp/sign-in-http.ts";
import { type GuardEnv, guardFromEnv, loadTeamKeysFromAccess, teamKeys } from "./access.ts";
import { type AssetLayer, serveAsset } from "./assets.ts";
import { buildUpkeep } from "./registry/builds.ts";
import { draftBranches, githubBranches } from "./registry/draft-branches.ts";
import { skillDirectoryOver } from "./registry/skill-directory.ts";
import { githubSkillReader } from "./registry/skill-reader.ts";
import { skillReposOver } from "./registry/skill-repo.ts";
import { searchSkillsSh } from "./registry/skill-search.ts";
import { McpHost, McpHostLive } from "./mcp/McpHost.ts";
import { mcpPushes } from "./mcp/push.ts";
import { mcpSignInManage, signInStageView } from "./mcp/sign-in-manage.ts";
import { mcpStatus } from "./mcp/status.ts";
import { mcpSignInCarry } from "./mcp/sign-in-carry.ts";
import { mcpSignInSessions } from "./mcp/sign-in-sessions.ts";
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
import { workspaceLookups } from "./session/lookups.ts";
import { SecretsConfigLive } from "./session/secrets.ts";
import {
  destroySessionObject,
  ModelProxyConfigLive,
  Session,
  SessionLive,
} from "./session/Session.ts";
import { triggerObjects } from "./trigger/objects.ts";
import { Trigger, TriggerLive } from "./trigger/Trigger.ts";
import { WORKSPACE_BINDING } from "./workspace/binding.ts";
import { workspaceObjectsRemote } from "./workspace/lifecycle.ts";
import type { WorkspaceNamespace } from "./session/workspace.ts";
import { MCP_CALLS_BINDING } from "./mcp-access.ts";
import { type RateLimiter, serveMcpRoute } from "./mcp/endpoint.ts";
import type { ServerDurableObject } from "./worker-shape.ts";

/**
 * The Durable Object classes the init takes its objects from, by the name alchemy's generated entry exports each under.
 * The typecheck holds the keys to exactly `SERVER_DURABLE_OBJECTS` (`worker-shape.ts`), which the startup budget bundles
 * with; that each class's own id is its key, and that a Durable Object added to the Layers below is added here and there,
 * is by convention.
 */
const durableObjects = { Session, Registry, McpHost, Trigger } satisfies {
  readonly [Name in ServerDurableObject]:
    | typeof Session
    | typeof Registry
    | typeof McpHost
    | typeof Trigger;
};

/**
 * The Server Worker's init (`worker.ts`): its routes, over the Session, Registry, McpHost and Trigger objects, whose Layers it
 * provides. Built at the isolate's first event, never at startup; `worker.ts` imports it dynamically, so that none of this
 * module's graph is evaluated in the Worker's global scope (`docs/development/workers.md` → Startup).
 */
export const serverInit = Effect.gen(function* () {
  const sessions = yield* durableObjects.Session;
  const registries = yield* durableObjects.Registry;
  const mcpHosts = yield* durableObjects.McpHost;
  // The objects of the Triggers that go with a deleted Environment are wiped.
  const triggers = triggerObjects(yield* durableObjects.Trigger);
  // The raw environment: the Workspace DO's own stub, as the Session DOs take it.
  const worker = yield* Cloudflare.WorkerEnvironment;
  // What runs after an answer: the wipe of what is left from before Environments, and the upkeep of the spares and
  // the Builds.
  const execution = yield* Cloudflare.WorkerExecutionContext;

  // SAFETY: the Server Worker binds the Workspace DO namespace as `WORKSPACES` (`worker.ts`), a raw namespace; Attachments
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
    importEntries: (id, entries, apps, questions, visuals) =>
      Effect.orDie(sessions.getByName(id).importEntries(entries, apps, questions, visuals)),
    importFinish: (id, plan) => Effect.orDie(sessions.getByName(id).importFinish(plan)),
    releaseFork: (id) => Effect.orDie(sessions.getByName(id).releaseFork()),
    deleteSubagent: (id, agent, workspace) =>
      Effect.orDie(sessions.getByName(id).deleteSubagent({ agent, workspace })),
  };

  // Built once per isolate, so a cleanup that found nothing left is not asked again.
  const legacy = legacyCleanup(registries, { sessions: sessionObjects, workspaces });
  // Built once per isolate too: the upkeep of every spare stops once a run finds nothing to do, and so does the Builds'.
  const spares = spareUpkeep(registries, { workspaces });

  // The MCP server set goes to an Environment's host after the owner's saves and Repo changes (`mcpPending` names the
  // Environments whose set differs from what their host was told, so one with no servers is never woken).
  const mcp = mcpPushes({
    registry: () => registries.getByName(REGISTRY_NAME),
    host: (name) => mcpHosts.getByName(name),
  });

  // A new good Build makes its Environment's spare stale, so the Builds' upkeep looks at the spare then.
  const builds = buildUpkeep(registries, { workspaces, spares, mcp });

  // The MCP status reads of the client: the Registry says which servers an Environment has, and its host answers from
  // its own storage, so no Container is started and an Environment with no servers never wakes a host.
  const mcpStatusReads = mcpStatus({
    registry: () => registries.getByName(REGISTRY_NAME),
    host: (name) => mcpHosts.getByName(name),
  });

  // A completed MCP sign-in, and a sign-out, go to the hosts of the Environments that use it (a rebind completes a
  // sign-in, so it is carried as one).
  const signInCarry = mcpSignInCarry({
    host: (name) => mcpHosts.getByName(name),
    sessions: mcpSignInSessions({ session: (id) => sessions.getByName(id) }),
  });

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

  // The owner's sign-ins for Settings: the Registry's list with the stage, and a sign-out carried to the hosts.
  const mcpSignIns = mcpSignInManage({
    registry,
    carry: signInCarry,
    stage: signInStageView(signInEnv),
  });

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
  // `McpServer` entrypoint as `MCP_SERVER` (`worker.ts` → `mcpBindings`) and the rate limit as `MCP_CALLS`, which `alchemy dev` may lack.
  const mcpRoute = serveMcpRoute({
    registries,
    sessions,
    objects: { workspaces, sessions: sessionObjects, triggers },
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

        if (sessionId !== undefined) return yield* connectSession(sessions, registries, sessionId);

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
            triggers,
            legacy,
            spares,
            builds,
            mcp,
            mcpStatus: mcpStatusReads,
            mcpSignIns,
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
    TriggerLive.pipe(
      // A Trigger's object calls the Registry and its Fires' Sessions.
      Layer.provideMerge(SessionLive),
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
);
