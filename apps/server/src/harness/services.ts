// docs/architecture/mcp-endpoint.md → Environment and Settings tools → Shared definitions and the core/wrapper split (No
// Session): the services the management tools' cores read through, built from the Registry and the McpHosts with no
// Session. `/mcp`'s `api` target runs the cores over them (`./dispatch.ts`).
import type { SettingsMcpAccessService } from "@cloudpid/extensions/settings-mcp";
import type { EnvironmentReadServices } from "@cloudpid/extensions/environment-reads";
import type { SettingsMcpReadServices } from "@cloudpid/extensions/settings-mcp-reads";
import type { SettingsReadServices } from "@cloudpid/extensions/settings-reads";
import type * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import type { McpHost } from "../mcp/McpHost.ts";
import { mcpHostName } from "../mcp/name.ts";
import { type EnvironmentReadsRegistry, environmentReads } from "../session/environments.ts";
import { mcpHostClient } from "../session/mcp-host.ts";
import { type SettingsReadsRegistry, settingsReads } from "../session/settings-access.ts";
import { type SettingsMcpReadsRegistry, settingsMcpReads } from "../session/settings-mcp-access.ts";

/** What the reads use of the Registry: the endpoint's Registry stub fits it, as a Session's does. */
export type HarnessRegistry = EnvironmentReadsRegistry &
  SettingsReadsRegistry &
  SettingsMcpReadsRegistry;

/** What the services are built from: the Registry, the Environments' McpHosts, and this stage's app origin. */
export type HarnessDeps = {
  readonly registry: HarnessRegistry;
  /** The McpHost namespace: an Environment's host holds the inventory `settings_mcp_*` shows. */
  readonly mcpHosts: Pick<Cloudflare.DurableObject<McpHost>, "getByName">;
  /** `APP_ORIGIN_VAR`: set on live stages only. */
  readonly appOrigin: string | undefined;
};

/** The services of the five read tools, with no Session: nothing is a Session's own, so nothing is marked as one. */
export type HarnessServices = {
  readonly environments: EnvironmentReadServices;
  readonly settings: SettingsReadServices;
  readonly settingsMcp: SettingsMcpReadServices;
};

/** The reads over `deps`: no write is in them, so none can be made through them. */
export const harnessServices = ({
  registry,
  mcpHosts,
  appOrigin,
}: HarnessDeps): HarnessServices => {
  const host: SettingsMcpAccessService["host"] = (environment) =>
    mcpHostClient(() => mcpHosts.getByName(mcpHostName(environment)));

  return {
    environments: { ...environmentReads(registry), current: Effect.succeed(null) },
    settings: { ...settingsReads(registry), own: Effect.succeed(null) },
    settingsMcp: { ...settingsMcpReads(registry, host), own: Effect.succeed(null), appOrigin },
  };
};
