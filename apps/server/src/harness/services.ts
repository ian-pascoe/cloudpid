// docs/architecture/mcp-endpoint.md → Environment and Settings tools → Shared definitions and the core/wrapper split (No
// Session), → After a change, and Notifications: the services the management tools' cores run over, built from the
// Registry, the McpHosts and the main Worker's upkeep with no Session. `/mcp`'s `api` target runs the cores over them
// (`./dispatch.ts`). The reads are the Session's own reads; the writes are the Session's services built with the
// endpoint's author source (`../session/change-author.ts`), with no Workspace to hand a change to, and with the Builds'
// and spares' upkeep they run handed to `background`, so it runs after the answer as after the owner's save.
import type { SettingsEndpointServices } from "@cloudpid/extensions/settings-endpoint";
import type { SettingsMcpAccessService } from "@cloudpid/extensions/settings-mcp";
import { DeployCredentials } from "@cloudpid/extensions/environment";
import {
  type EnvironmentChangeServices,
  endpointTextCheck,
  type TextCheck,
} from "@cloudpid/extensions/environment-changes";
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
import { type UpkeepChange, upkeepFor } from "../registry/upkeep.ts";
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

/** What the tools use of the Registry: the endpoint's Registry stub fits it, as a Session's does. */
export type HarnessRegistry = EnvironmentReadsRegistry &
  SettingsReadsRegistry &
  SettingsMcpReadsRegistry &
  EnvironmentsRegistry &
  LifecycleRegistry &
  SettingsRegistry &
  SettingsMcpRegistry &
  HarnessChangeRegistry;

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
};

/** The services of the management tools, with no Session: nothing is a Session's own, so nothing is marked as one. */
export type HarnessServices = {
  readonly environments: EnvironmentReadServices;
  readonly settings: SettingsReadServices;
  readonly settingsMcp: SettingsMcpReadServices;
  /**
   * What the change tools' cores run over for a call made by `source`'s author (the verified caller, and the claim of
   * its `request_id`): the Environments, written as the Session writes them, and the endpoint's check of a kept text.
   */
  readonly changes: (source: AuthorSource) => EnvironmentChangeServices;
  /**
   * What the Settings' and the MCP servers' cores run over for a call made by `source`: the Settings and the servers written
   * as the Session writes them, with the endpoint's check of a kept text and no `SettingsReload`; the sets a change reaches are
   * pushed to their hosts before the answer, and one that fails is sent again with one `mcp.sync(environment)` in `background`.
   */
  readonly settingsChanges: (source: AuthorSource) => SettingsEndpointServices;
  /** The MCP servers' access for `settings_mcp_reload`, which makes no Agent change and so has no author. */
  readonly settingsMcpReload: SettingsMcpAccessService;
  /** The probe, the claims of `request_id` and the notice. */
  readonly registry: HarnessChangeRegistry;
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
}: HarnessDeps): HarnessServices => {
  const host: SettingsMcpAccessService["host"] = (environment) =>
    mcpHostClient(() => mcpHosts.getByName(mcpHostName(environment)));

  // The upkeep a write runs, after the answer: as after the owner's save, it never fails the change.
  const afterAnswer = {
    builds: { of: (environment: string) => background(builds.of(environment)) },
    spares: { of: (environment: string) => background(spares.of(environment)) },
  };

  // The deploy-time credentials and the Secret Reference placeholders: the Registry checks the kept Secrets itself.
  const holdsSecret: TextCheck = (text) =>
    endpointTextCheck.pipe(
      Effect.provideService(DeployCredentials, { values: credentials }),
      Effect.flatMap((check) => check(text)),
    );

  return {
    environments: { ...environmentReads(registry), current: Effect.succeed(null) },
    settings: { ...settingsReads(registry), own: Effect.succeed(null) },
    settingsMcp: { ...settingsMcpReads(registry, host), own: Effect.succeed(null), appOrigin },
    changes: (source) => ({
      // No Workspace: `current` is null, so no change is this caller's own, and none is handed anywhere.
      environments: sessionEnvironments({
        registry,
        author: source,
        ...afterAnswer,
        lifecycle: sessionLifecycle({
          registry,
          author: source,
          // No Test Builds: the lifecycle refuses one on the endpoint (S4a serves them).
          builds: { ...afterAnswer.builds, rebuild: builds.rebuild },
          spares: afterAnswer.spares,
        }),
      }),
      holdsSecret,
    }),
    settingsChanges: (source) => ({
      settings: sessionSettingsAccess({ registry, author: source }),
      settingsMcp: sessionSettingsMcpAccess({ registry, author: source, host, appOrigin }),
      // A set that could not be handed to a host is sent again once, after the answer, as after the owner's save.
      pushFailed: (environment) => background(Effect.suspend(() => mcp.sync(environment))),
      // The Registry checks the kept Secrets in the write itself: a text that cannot be checked is refused, as holding one.
      holdsSecret: (text) => holdsSecret(text).pipe(Effect.orElseSucceed(() => true)),
    }),
    // Nobody is a Session here: `sessionSource(undefined)` has no own Environment, and the reload reads none.
    settingsMcpReload: sessionSettingsMcpAccess({
      registry,
      author: sessionSource(undefined),
      host,
      appOrigin,
    }),
    registry,
    upkeep: (changes) => upkeepFor({ registry, builds, spares, mcp, background }, changes),
    background,
  };
};
