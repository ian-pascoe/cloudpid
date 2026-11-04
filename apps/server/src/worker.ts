import { fileURLToPath } from "node:url";
import { BROWSER_HOST_BINDING, Browsers } from "@cloudpid/browser";
import { WORKER_OBSERVABILITY } from "@cloudpid/telemetry/observability";
import { CODEMODE_SANDBOX_BINDING, CodemodeSandboxes } from "@cloudpid/codemode-sandbox";
import {
  MCP_ENGINE_BINDING,
  MCP_ENGINE_ENTRYPOINT,
  MCP_SERVER_BINDING,
  MCP_SERVER_ENTRYPOINT,
  McpWorker,
} from "@cloudpid/mcp-worker";
import * as Alchemy from "alchemy";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Namespace from "alchemy/Namespace";
import * as Command from "alchemy/Command";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { deployment, STAGE_LABEL_VAR } from "./deployment.ts";
import { accessProps } from "./access-props.ts";
import { bypassAccessProps } from "./bypass-access.ts";
import { WEB_NOT_FOUND_HANDLING } from "./assets-config.ts";
import { IMAGES_BINDING } from "./session/images.ts";
import { WORKSPACE_BINDING } from "./workspace/binding.ts";
import type { Workspace } from "./workspace/Workspace.ts";
import { Workspaces } from "./workspace/resource.ts";
import {
  LOCAL_AGENT_TOKEN_ID,
  MCP_CALLS_BINDING,
  MCP_CALLS_LIMIT,
  MCP_CALLS_PERIOD_S,
  mcpAccessProps,
  mcpCallsNamespace,
} from "./mcp-access.ts";

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
 * `McpWorker`'s two entrypoints, bound through the Worker's Output, not a literal name, so `McpWorker` deploys first, after
 * the `Workspaces` Worker whose `WorkspaceMcpBridge` entrypoint it binds as `MCP_BRIDGE`: its
 * `McpEngine`, for `McpHost`, which runs the MCP SDK through it (ADR-0038; `docs/architecture/mcp-connections.md` → The
 * engine), and its `McpServer`, which serves `/mcp` (`docs/architecture/mcp-endpoint.md` → The handler). Only the deploy
 * declares them: the bundle reads the bindings from `env`.
 */
const mcpBindings = Effect.gen(function* () {
  if (globalThis.__ALCHEMY_RUNTIME__ === true) return undefined;

  const workspaces = yield* Workspaces;
  const mcpWorker = yield* McpWorker({ workspaces });

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
/**
 * The main Worker. This file is its own entry, so it is bundled as written. Its init is a module of its own, loaded at the
 * isolate's first event (`worker-init.ts`): the Worker's global scope evaluates only what the props need, so the startup
 * stays far below the platform's limit however much the Durable Objects grow (`docs/development/workers.md` → Startup).
 */
export default class Server extends Cloudflare.Worker<Server>()(
  "Server",
  props,
  Effect.promise(() => import("./worker-init.ts")).pipe(Effect.flatMap((init) => init.serverInit)),
) {}
