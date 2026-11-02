import { fileURLToPath } from "node:url";
import { BROWSER_HOST_BINDING, Browsers } from "@cloudpid/browser";
import { WebConfigLive } from "@cloudpid/extensions/web";
import { WORKER_OBSERVABILITY } from "@cloudpid/telemetry/observability";
import { CODEMODE_SANDBOX_BINDING, CodemodeSandboxes } from "@cloudpid/codemode-sandbox";
import * as Alchemy from "alchemy";
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
import {
  type GuardEnv,
  guardAccess,
  guardFromEnv,
  loadTeamKeysFromAccess,
  teamKeys,
} from "./access.ts";
import { type AssetLayer, serveAsset } from "./assets.ts";
import { buildUpkeep } from "./registry/builds.ts";
import { draftBranches, githubBranches } from "./registry/draft-branches.ts";
import { skillDirectoryOver } from "./registry/skill-directory.ts";
import { githubSkillReader } from "./registry/skill-reader.ts";
import { skillReposOver } from "./registry/skill-repo.ts";
import { searchSkillsSh } from "./registry/skill-search.ts";
import { Registry, RegistryLive } from "./registry/Registry.ts";
import {
  legacyCleanup,
  serveRegistryRpc,
  type SessionObjects,
  spareUpkeep,
} from "./registry/rpc.ts";
import { PushConfigLive } from "./push/config.ts";
import { attachmentRoute, isRegistryRpc, sessionSocketId } from "./routes.ts";
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

/**
 * The web app (`apps/web`), built at deploy time and served as static assets by this Worker. The Worker runs first
 * (`runWorkerFirst`), so its Access guard covers every request and the files are served after it from the `ASSETS`
 * binding (`serveAsset`): a file the build has, `index.html` for a navigation to an unknown path (`/sessions/:id`),
 * and a 404 for a missing `/assets/…` file (`missingAsset`). The Worker's bundle folds the build step away, so only the
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
    notFoundHandling: "single-page-application" as const,
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
 * Deploy-time props, resolved from the stage: the Worker's name, where it is served, its Access application and the
 * guard's vars (`accessProps`) and, off `prod`, the label var (`deployment.ts`). The stage is absent once the Worker
 * runs (the props only matter at deploy time), so that case falls back to a non-prod stage.
 */
const props = Effect.gen(function* () {
  const stage = Option.getOrElse(yield* Effect.serviceOption(Alchemy.Stage), () => "runtime");
  const { label, access, ...workerProps } = deployment(stage);

  // The Worker's own Access application, declared here as the `Server/Access` the Worker's `access: { policies }` form
  // made (same logical id, so a deploy updates it in place), so that its `aud` can be a var of the Worker.
  const guard = yield* accessProps({
    declare: Cloudflare.Access.Application("Access", {
      type: "self_hosted",
      policies: access.policies,
    }).pipe(Namespace.push("Server")),
    runtime: globalThis.__ALCHEMY_RUNTIME__ === true,
  });

  // The `<label>` of the App sandbox's `<hash>--<label>` View URLs, set on non-prod stages only: prod's Views have no
  // suffix. Never taken from a request's `Host`.
  const stageLabelVar = label === undefined ? {} : { [STAGE_LABEL_VAR]: label };

  return {
    main: import.meta.url,
    compatibility: { date: "2026-08-31" },
    ...workerProps,
    ...guard.props,
    observability: WORKER_OBSERVABILITY,
    assets: yield* webAssets,
    env: {
      ...guard.vars,
      ...stageLabelVar,
      ...(yield* workspaceBinding),
      ...(yield* sandboxBinding),
      ...(yield* browserBinding),
      // The Images binding the Session DOs' `read` prepares images with; `alchemy dev` emulates it with sharp.
      [IMAGES_BINDING]: Cloudflare.Images.Images(IMAGES_BINDING),
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

    // The guard of every route (docs/architecture/mcp-sign-in.md → The Access guard): the Worker verifies the Access
    // assertion itself and refuses the rest, so a request that reached it some other way (a bypass application's wider
    // paths, a service binding) gets a 403. The deploy put its vars in the Worker's environment.
    // SAFETY: the deploy sets these vars as strings (`guardVars`), and nothing else puts a value under their names.
    const guard = guardAccess({
      ...guardFromEnv(worker as GuardEnv),
      keys: teamKeys(loadTeamKeysFromAccess),
    });

    // SAFETY: the Worker's assets are bound as `ASSETS` (the Fetcher of the asset layer), as the deploy declares them.
    const assets = worker.ASSETS as AssetLayer;

    return {
      fetch: guard(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const sessionId = sessionSocketId(request);

          if (sessionId !== undefined)
            return yield* connectSession(sessions, registries, sessionId);

          const attachment = attachmentRoute(request);

          if (attachment !== undefined) {
            return yield* serveAttachment(registries, attachmentFiles, attachment);
          }

          if (isRegistryRpc(request))
            return yield* serveRegistryRpc(registries, {
              workspaces,
              sessions: sessionObjects,
              legacy,
              spares,
              builds,
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
