import { sandboxImageContext } from "@cloudpid/sandbox-image";
import { WORKER_OBSERVABILITY } from "@cloudpid/telemetry/observability";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { OWNER_EMAIL } from "../deployment.ts";
import { readGitHubAppSecrets } from "../github/config.ts";
import { WORKSPACE_CONTAINER, WORKSPACE_BINDING } from "./binding.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * The sandbox image (`apps/sandbox-image`) as a Container the Workspace DO schedules itself: the object picks the image
 * and the instance size when it starts the Container (`schedulingPolicy: "durable_object"`, ADR-0004), so neither is
 * declared here. The image is built from the Dockerfile, and reaches the object as `ctx.container.images.WorkspaceContainer`.
 */
export const WorkspaceContainer = Cloudflare.Container(WORKSPACE_CONTAINER, {
  schedulingPolicy: "durable_object",
  context: sandboxImageContext,
});

/** The identity of the agent's commits unless the deploying environment sets `CLOUDPID_GIT_NAME` or `CLOUDPID_GIT_EMAIL`. */
export const DEFAULT_GIT_NAME = "cloudpid";

/**
 * The Worker that hosts the Workspace DO, one object per Workspace slug. It has no public URL: Session DOs reach it
 * through a Durable Object binding.
 *
 * - `CLOUDPID_GITHUB_APP_ID` and `CLOUDPID_GITHUB_APP_PRIVATE_KEY` are deploy-time secrets (`Config.Redacted`, bound as
 *   Worker secrets; a key that is not an RSA PEM fails the deploy): the Workspace DO mints GitHub tokens from them that
 *   the Container's commands get as `GH_TOKEN` and `GITHUB_TOKEN`, so the agent can clone, commit and push with real
 *   git and gh (docs/spec.md → Git, ADR-0025).
 * - `SECRETS_ENCRYPTION_KEY` is the deploy-time master key (`Config.Redacted`, bound as a Worker secret) the Workspace
 *   DO seals its copy of the Environment's kept Secrets under, as the Session DOs and the Registry seal theirs
 *   (docs/spec.md → Secrets).
 * - `CLOUDPID_GIT_NAME` and `CLOUDPID_GIT_EMAIL` set who those commits are by (the owner's email by default).
 * - `CLOUDPID_ANALYTICS_TOKEN` is an optional deploy-time secret: an API token with Account Analytics Read, bound with
 *   the account it reads (`CLOUDFLARE_ACCOUNT_ID`), that the Workspace DO reads its Containers' usage analytics with
 *   (`container-analytics.ts`). Unset or empty, their cost is estimated (docs/spec.md → Operations → Usage).
 * - Under `alchemy dev` the Container runs in local Docker without `/dev/fuse`, where computerd's userspace shim
 *   cannot keep paths container-local: the Workspace DO is told not to ask for it (`CONTAINER_FUSE`).
 */
export const Workspaces = Effect.gen(function* () {
  const { dev } = yield* AlchemyContext;
  const githubApp = yield* readGitHubAppSecrets;

  const analyticsToken = (yield* Config.option(Config.Redacted("CLOUDPID_ANALYTICS_TOKEN"))).pipe(
    Option.filter((token) => Redacted.value(token) !== ""),
  );

  // The account is the deploy's own: its analytics are the ones the token reads.
  const analytics = Option.isSome(analyticsToken)
    ? {
        CLOUDPID_ANALYTICS_TOKEN: analyticsToken.value,
        CLOUDFLARE_ACCOUNT_ID: (yield* yield* Cloudflare.CloudflareEnvironment).accountId,
      }
    : {};

  return yield* Cloudflare.Worker("Workspaces", {
    main: new URL("./worker.ts", import.meta.url).href,
    compatibility: { date: "2026-08-31" },
    workersDev: false,
    observability: WORKER_OBSERVABILITY,
    env: {
      [WORKSPACE_BINDING]: Cloudflare.DurableObject<Workspace>("Workspace", {
        containers: [WorkspaceContainer],
      }),
      LOADER: Cloudflare.WorkerLoader(),
      CLOUDPID_GITHUB_APP_ID: githubApp.appId,
      CLOUDPID_GITHUB_APP_PRIVATE_KEY: githubApp.privateKey,
      SECRETS_ENCRYPTION_KEY: Config.Redacted("SECRETS_ENCRYPTION_KEY"),
      CLOUDPID_GIT_NAME: Config.String("CLOUDPID_GIT_NAME").pipe(
        Config.withDefault(DEFAULT_GIT_NAME),
      ),
      CLOUDPID_GIT_EMAIL: Config.String("CLOUDPID_GIT_EMAIL").pipe(Config.withDefault(OWNER_EMAIL)),
      CONTAINER_FUSE: dev ? "false" : "true",
      ...analytics,
    },
  });
});
