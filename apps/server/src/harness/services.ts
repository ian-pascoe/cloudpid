// docs/architecture/mcp-endpoint.md → Environment and Settings tools → Shared definitions and the core/wrapper split (No
// Session), → After a change, and Notifications: the services the management tools' cores run over, built from the
// Registry, the McpHosts and the main Worker's upkeep with no Session. `/mcp`'s `api` target runs the cores over them
// (`./dispatch.ts`). The reads are the Session's own reads; the writes are the Session's services built with the
// endpoint's author source (`../session/change-author.ts`), with no Workspace to hand a change to, and with the Builds'
// and spares' upkeep they run handed to `background`, so it runs after the answer as after the owner's save.
import type { SettingsEndpointServices } from "@cloudpid/extensions/settings-endpoint";
import type { SettingsMcpAccessService } from "@cloudpid/extensions/settings-mcp";
import { DeployCredentials, type EnvironmentsService } from "@cloudpid/extensions/environment";
import type { SettingsAccessService } from "@cloudpid/extensions/settings";
import {
  type EnvironmentChangeServices,
  endpointTextCheck,
  type TextCheck,
} from "@cloudpid/extensions/environment-changes";
import type { LifecycleChangeServices } from "@cloudpid/extensions/environment-lifecycle-changes";
import type { ResetCoreServices } from "@cloudpid/extensions/environment-reset";
import type { SkillChangeServices } from "@cloudpid/extensions/environment-skill-changes";
import type { EnvironmentReadServices } from "@cloudpid/extensions/environment-reads";
import type { SettingsMcpReadServices } from "@cloudpid/extensions/settings-mcp-reads";
import type { SettingsReadServices } from "@cloudpid/extensions/settings-reads";
import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import type { McpHost } from "../mcp/McpHost.ts";
import { mcpHostName } from "../mcp/name.ts";
import type { McpPushes } from "../mcp/push.ts";
import type { Builds } from "../registry/builds.ts";
import type { RegistryMethods } from "../registry/Registry.ts";
import type { Spares } from "../registry/rpc.ts";
import { afterRepos, type UpkeepChange, upkeepFor } from "../registry/upkeep.ts";
import { type AuthorSource, sessionSource } from "../session/change-author.ts";
import { type LifecycleRegistry, sessionLifecycle } from "../session/environment-lifecycle.ts";
import {
  type EnvironmentReadsRegistry,
  type EnvironmentsRegistry,
  environmentReads,
  sessionEnvironments,
} from "../session/environments.ts";
import { mcpHostClient } from "../session/mcp-host.ts";
import {
  type SettingsReadsRegistry,
  type SettingsRegistry,
  sessionSettingsAccess,
  settingsReads,
} from "../session/settings-access.ts";
import {
  type SettingsMcpReadsRegistry,
  type SettingsMcpRegistry,
  sessionSettingsMcpAccess,
  settingsMcpReads,
} from "../session/settings-mcp-access.ts";

/** What the dispatcher itself asks of the Registry around a write: the probe, a `request_id`'s claim, and the notice. */
export type HarnessChangeRegistry = Pick<
  RegistryMethods,
  "agentChangeFeatures" | "changeRequest" | "settleChangeRequest" | "notifyMcpChanges"
>;

/**
 * What the Approvals asked over the endpoint use of the Registry (`./approval-ask.ts`, `./approval-runner.ts`,
 * `./approval-follow.ts`): the requests, their lease and push, and the claims an approved one's write records.
 */
export type ApprovalsRegistry = Pick<
  RegistryMethods,
  | "requestApproval"
  | "approval"
  | "withdrawApproval"
  | "claimApproval"
  | "finishApproval"
  | "staleApprovals"
  | "notifyApproval"
  | "waitApproval"
  | "changeRequest"
  | "settleChangeRequest"
>;

/** What the tools use of the Registry: the endpoint's Registry stub fits it, as a Session's does. */
export type HarnessRegistry = EnvironmentReadsRegistry &
  SettingsReadsRegistry &
  SettingsMcpReadsRegistry &
  EnvironmentWritesRegistry &
  SettingsMcpRegistry &
  Pick<RegistryMethods, "mcpLookRepoFiles"> &
  HarnessChangeRegistry &
  ApprovalsRegistry;

/** What the writes with no Session use of the Registry: the Environments' and the Settings'. */
export type EnvironmentWritesRegistry = EnvironmentsRegistry & LifecycleRegistry & SettingsRegistry;

/** What the writes with no Session are built from (`endpointWrites`). */
export type EndpointWriteDeps = {
  readonly registry: EnvironmentWritesRegistry;
  readonly builds: Pick<Builds, "of" | "rebuild">;
  readonly spares: Pick<Spares, "of">;
  readonly background: (effect: Effect.Effect<void>) => Effect.Effect<void>;
  readonly credentials: ReadonlyArray<string>;
  /** What an Environment's Repos' change runs after it (`../registry/upkeep.ts` `afterRepos`); none where no tool adds one. */
  readonly afterRepos?: Parameters<typeof sessionLifecycle>[0]["afterRepos"];
};

/** The writes a caller with no Session makes, by author source: the Environments, the Settings, and the check of a text. */
export type EndpointWrites = {
  /** The Environments, written as the Session writes them, with no Workspace, the upkeep after the answer. */
  readonly environments: (source: AuthorSource) => EnvironmentsService;
  /** The Settings at either Scope, written as the Session writes them. */
  readonly settings: (source: AuthorSource) => Pick<SettingsAccessService, "get" | "change">;
  /** The endpoint's check of a kept text: the deploy-time credentials and Secret References (the Registry checks the kept Secrets). */
  readonly holdsSecret: TextCheck;
};

/**
 * The writes with no Session over `deps`: what the management tools' change cores run over, and what an approved
 * Approval's apply runs over (`./approval-runner.ts`), from the `/mcp` request or from the owner's `/rpc` call alike.
 */
export const endpointWrites = ({
  registry,
  builds,
  spares,
  background,
  credentials,
  afterRepos: reposChanged,
}: EndpointWriteDeps): EndpointWrites => {
  // The upkeep a write runs, after the answer: as after the owner's save, it never fails the change.
  const afterAnswer = {
    builds: { of: (environment: string) => background(builds.of(environment)) },
    spares: { of: (environment: string) => background(spares.of(environment)) },
  };

  return {
    environments: (source) =>
      // No Workspace: `current` is null, so no change is this caller's own, and none is handed anywhere.
      sessionEnvironments({
        registry,
        author: source,
        ...afterAnswer,
        lifecycle: sessionLifecycle({
          registry,
          author: source,
          // No Test Builds: the lifecycle refuses one on the endpoint (S4a serves them). The Build a rebuild asks for is
          // awaited, as the owner's Rebuild awaits it: the answer says whether one was asked for.
          builds: { ...afterAnswer.builds, rebuild: builds.rebuild },
          spares: afterAnswer.spares,
          ...(reposChanged === undefined ? {} : { afterRepos: reposChanged }),
        }),
      }),
    settings: (source) => sessionSettingsAccess({ registry, author: source }),
    // The deploy-time credentials and the Secret Reference placeholders: the Registry checks the kept Secrets itself.
    holdsSecret: (text) =>
      endpointTextCheck.pipe(
        Effect.provideService(DeployCredentials, { values: credentials }),
        Effect.flatMap((check) => check(text)),
      ),
  };
};

/** What the services are built from: the Registry, the Environments' McpHosts, the upkeep, and this stage's app origin. */
export type HarnessDeps = {
  readonly registry: HarnessRegistry;
  /** The McpHost namespace: an Environment's host holds the inventory `settings_mcp_*` shows. */
  readonly mcpHosts: Pick<Cloudflare.DurableObject<McpHost>, "getByName">;
  /** `APP_ORIGIN_VAR`: set on live stages only. */
  readonly appOrigin: string | undefined;
  /** The Builds' upkeep after a change (`of`, run in `background`), and the Build a rebuild asks for (awaited). */
  readonly builds: Pick<Builds, "of" | "rebuild">;
  /** The spares' upkeep after a change of the Spare Workspace setting or the Repos, run in `background`. */
  readonly spares: Pick<Spares, "of" | "all">;
  /** The push of an Environment's MCP server set to its host, after a change of an MCP server's key. */
  readonly mcp: Pick<McpPushes, "sync">;
  /** Runs `effect` once the answer is sent, keeping the request alive until it is done (`waitUntil`). */
  readonly background: (effect: Effect.Effect<void>) => Effect.Effect<void>;
  /** The deploy-time credentials a kept text may not hold (`DeployCredentials`): the GitHub App's key, in its forms. */
  readonly credentials: ReadonlyArray<string>;
  /** This request's own origin, which a request's card `url` starts with. */
  readonly origin?: string | undefined;
};

/** What the change tools' cores run over: each family's services (one `Environments`, written as the Session writes it). */
export type HarnessChangeServices = EnvironmentChangeServices &
  LifecycleChangeServices &
  SkillChangeServices &
  ResetCoreServices;

/** The services of the management tools, with no Session: nothing is a Session's own, so nothing is marked as one. */
export type HarnessServices = {
  readonly environments: EnvironmentReadServices;
  readonly settings: SettingsReadServices;
  readonly settingsMcp: SettingsMcpReadServices;
  /**
   * What the change tools' cores run over for a call made by `source`'s author (the verified caller, and the claim of
   * its `request_id`): the Environments, written as the Session writes them, and the endpoint's check of a kept text.
   */
  readonly changes: (source: AuthorSource) => HarnessChangeServices;
  /**
   * What the Settings' and the MCP servers' cores run over for a call made by `source`: the Settings and the servers written
   * as the Session writes them, with the endpoint's check of a kept text and no `SettingsReload`; the sets a change reaches are
   * pushed to their hosts before the answer, and one that fails is sent again with one `mcp.sync(environment)` in `background`.
   */
  readonly settingsChanges: (source: AuthorSource) => SettingsEndpointServices;
  /** The MCP servers' access for `settings_mcp_reload`, which makes no Agent change and so has no author. */
  readonly settingsMcpReload: SettingsMcpAccessService;
  /** The writes with no Session, which an approved Approval's apply runs over. */
  readonly writes: EndpointWrites;
  /** The probe, the claims of `request_id` and the notice, and the Approvals asked over the endpoint. */
  readonly registry: HarnessChangeRegistry & ApprovalsRegistry;
  /**
   * This request's own origin (`https://<host>`), which a request's card `url` starts with; none for a caller that has none
   * (a test), whose `url` is the path.
   */
  readonly origin?: string | undefined;
  /** The upkeep recorded `changes` call for, in `background`: what an answer built from an earlier call's records runs. */
  readonly upkeep: (changes: ReadonlyArray<UpkeepChange>) => Effect.Effect<void>;
  readonly background: (effect: Effect.Effect<void>) => Effect.Effect<void>;
};

/** The services over `deps`. */
export const harnessServices = ({
  registry,
  mcpHosts,
  appOrigin,
  builds,
  spares,
  mcp,
  background,
  credentials,
  origin,
}: HarnessDeps): HarnessServices => {
  const host: SettingsMcpAccessService["host"] = (environment) =>
    mcpHostClient(() => mcpHosts.getByName(mcpHostName(environment)));

  const writes = endpointWrites({
    registry,
    builds,
    spares,
    background,
    credentials,
    // As after the owner's `addRepo` and `removeRepo`: a Repo's `.pi/mcp.json` is looked at, then the set is pushed.
    afterRepos: (repos) => afterRepos({ registry, mcp, background }, repos),
  });

  return {
    environments: { ...environmentReads(registry), current: Effect.succeed(null) },
    settings: { ...settingsReads(registry), own: Effect.succeed(null) },
    settingsMcp: { ...settingsMcpReads(registry, host), own: Effect.succeed(null), appOrigin },
    changes: (source) => ({
      environments: writes.environments(source),
      holdsSecret: writes.holdsSecret,
    }),
    settingsChanges: (source) => ({
      settings: sessionSettingsAccess({ registry, author: source }),
      settingsMcp: sessionSettingsMcpAccess({ registry, author: source, host, appOrigin }),
      // A set that could not be handed to a host is sent again once, after the answer, as after the owner's save.
      pushFailed: (environment) => background(Effect.suspend(() => mcp.sync(environment))),
      // The Registry checks the kept Secrets in the write itself: a text that cannot be checked is refused, as holding one.
      holdsSecret: (text) => writes.holdsSecret(text).pipe(Effect.orElseSucceed(() => true)),
    }),
    // Nobody is a Session here: `sessionSource(undefined)` has no own Environment, and the reload reads none.
    settingsMcpReload: sessionSettingsMcpAccess({
      registry,
      author: sessionSource(undefined),
      host,
      appOrigin,
    }),
    writes,
    registry,
    origin,
    upkeep: (changes) => upkeepFor({ registry, builds, spares, mcp, background }, changes),
    background,
  };
};
