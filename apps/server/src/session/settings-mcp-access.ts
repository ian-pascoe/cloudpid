// The Session's `SettingsMcpAccess` (`@cloudpid/extensions/settings-mcp`,
// `docs/architecture/mcp-configuration.md` → The agent's changes): the Registry's MCP read for the agent's `settings_mcp_*`
// tools, with the `McpHost` of the Environment they name.
//
// The Registry never calls out, so the Session carries the push of a changed set to the host (`mcpPending` for what the host
// was not handed, `McpHostClient.apply` to hand it, `mcpPushed` once it took it): the Session → Registry edge has no version
// gate, so a Registry still on the code from before these methods fails the call, loudly, and the next deploy heals it
// (`docs/architecture/mcp.md` → Deploys).
import type { McpHostClientService } from "@cloudpid/extensions/mcp";
import { GLOBAL_SETTINGS_SCOPE } from "@cloudpid/extensions/settings";
import type { SettingsMcpAccessService } from "@cloudpid/extensions/settings-mcp";
import * as Arr from "effect/Array";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { RegistryMethods } from "../registry/Registry.ts";
import { noEnvironment } from "./settings-access.ts";

/** What the Session's MCP read and pushes use of the Registry. */
export type SettingsMcpRegistry = Pick<
  RegistryMethods,
  | "mcpSettingsView"
  | "mcpSettingsReload"
  | "mcpChangeCheck"
  | "mcpPending"
  | "mcpPushed"
  | "sessionSettings"
>;

/** What the MCP read uses of the Registry: the endpoint's Registry stub fits it, as the Session's does. */
export type SettingsMcpReadsRegistry = Pick<RegistryMethods, "mcpSettingsView">;

export type SessionSettingsMcpAccessOptions = {
  readonly registry: SettingsMcpRegistry;
  /** The Session's id in the Registry; undefined when unknown, for a Session that then has no own Environment. */
  readonly session: string | undefined;
  /** The `McpHostClient` of Environment `environment`'s host: any Environment's, since a Session names the host it reaches. */
  readonly host: (environment: string) => McpHostClientService;
  /** The object of the Session's Workspace (`ws:<id>`), which the status wait names; null with none. */
  readonly workspace?: Effect.Effect<string | null, Cause.UnknownError> | undefined;
};

/**
 * The read of the Session's `SettingsMcpAccess`, which needs no Session: the MCP servers of a Scope, and the `McpHost` of any
 * Environment, whose held inventory the reads ask for (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools →
 * Shared definitions: No Session). The Session spreads it into its service, adding `own`, the checks, the pushes and the
 * reload; the MCP endpoint builds it from its Registry and its hosts alone.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const settingsMcpReads = (
  registry: SettingsMcpReadsRegistry,
  host: (environment: string) => McpHostClientService,
): Pick<SettingsMcpAccessService, "view" | "host"> => ({
  view: ({ scope, name }) =>
    Effect.suspend(() =>
      registry.mcpSettingsView({
        environment: scope === GLOBAL_SETTINGS_SCOPE ? undefined : scope,
        name,
      }),
    ).pipe(
      Effect.filterOrFail(
        (view) => view !== null,
        () => noEnvironment(scope),
      ),
    ),
  host,
});

export const sessionSettingsMcpAccess = ({
  registry,
  session,
  host,
  workspace,
}: SessionSettingsMcpAccessOptions): SettingsMcpAccessService => ({
  ...settingsMcpReads(registry, host),
  own:
    session === undefined
      ? Effect.succeed(null)
      : Effect.suspend(() => registry.sessionSettings({ session })).pipe(
          Effect.map(({ environment }) => environment),
        ),
  check: ({ scope, name, changes, reads }) =>
    Effect.suspend(() =>
      registry.mcpChangeCheck({
        environment: scope === GLOBAL_SETTINGS_SCOPE ? undefined : scope,
        name,
        changes,
        reads,
      }),
    ).pipe(
      Effect.filterOrFail(
        (check) => check !== null,
        () => noEnvironment(scope),
      ),
    ),
  reload: (environment) =>
    Effect.suspend(() => registry.mcpSettingsReload({ environment })).pipe(
      Effect.filterOrFail(
        (report) => report !== null,
        () => noEnvironment(environment),
      ),
    ),
  pushes: (environment) =>
    Effect.suspend(() => registry.mcpPending({ environment })).pipe(
      // Only this Environment's: the wipes and the other Environments' sets are the main Worker's to send.
      Effect.map(({ pushes }) =>
        Arr.map(
          Arr.filter(pushes, (push) => push.environment === environment),
          ({ set }) => set,
        ),
      ),
    ),
  pushed: (input) => Effect.suspend(() => registry.mcpPushed(input)),
  workspace:
    workspace === undefined
      ? Effect.succeed(null)
      : workspace.pipe(Effect.orElseSucceed(() => null)),
});
