// The Session's `SettingsMcpAccess` and its `McpHostClient` (`@cloudpid/extensions/settings-mcp`,
// `docs/architecture/mcp-configuration.md` → The agent's changes): the Registry's MCP read for the agent's `settings_mcp_*`
// tools, and the Environment's `McpHost` they reach, which is the Session's own Environment's.
//
// The Registry never calls out, so the Session carries the push of a changed set to the host (`mcpPending` for what the host
// was not handed, `McpHostClient.apply` to hand it, `mcpPushed` once it took it): the Session → Registry edge has no version
// gate, so a Registry still on the code from before these methods fails the call, loudly, and the next deploy heals it
// (`docs/architecture/mcp.md` → Deploys).
import type { McpHostClientService } from "@cloudpid/extensions/mcp";
import { HostLost } from "@cloudpid/extensions/mcp";
import { GLOBAL_SETTINGS_SCOPE, SettingsAccessError } from "@cloudpid/extensions/settings";
import type { SettingsMcpAccessService } from "@cloudpid/extensions/settings-mcp";
import { HostFailed } from "@cloudpid/mcp/types";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type { RegistryMethods } from "../registry/Registry.ts";

/** What the Session's MCP read and pushes use of the Registry. */
export type SettingsMcpRegistry = Pick<
  RegistryMethods,
  "mcpSettingsView" | "mcpSettingsReload" | "mcpPending" | "mcpPushed" | "sessionSettings"
>;

export type SessionSettingsMcpAccessOptions = {
  readonly registry: SettingsMcpRegistry;
  /** The Session's id in the Registry; undefined when unknown, for a Session that then has no own Environment. */
  readonly session: string | undefined;
};

/** Why an Environment's MCP servers are not reached: no Environment has the id. */
const noEnvironment = (id: string) =>
  SettingsAccessError.make({
    message: `No Environment has the id ${JSON.stringify(id)}. Give scope "*" for Global, or an Environment's id as environment_list shows it.`,
  });

export const sessionSettingsMcpAccess = ({
  registry,
  session,
}: SessionSettingsMcpAccessOptions): SettingsMcpAccessService => ({
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
  own:
    session === undefined
      ? Effect.succeed(null)
      : Effect.suspend(() => registry.sessionSettings({ session })).pipe(
          Effect.map(({ environment }) => environment),
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
});

/** The failure of a host the Session has no Environment's to reach. */
const NO_HOST = "This Session has no Environment, so there is no MCP host to reach";

/**
 * `McpHostClient` of the Session's own Environment, found anew for each call: its Environment is the Registry's answer
 * (`own`), so a Session in no Environment reaches no host. A Session reaches only its own Environment's host, and wakes no other.
 */
export const sessionOwnMcpHost = (options: {
  readonly own: Effect.Effect<string | null, SettingsAccessError>;
  /** The `McpHostClient` of Environment `environment`'s host. */
  readonly host: (environment: string) => McpHostClientService;
}): McpHostClientService => {
  const failed = HostFailed.make({ message: NO_HOST });

  /** `use` on the own Environment's host, or `none` when there is none or the Registry did not say. */
  const through = <A>(
    use: (host: McpHostClientService) => Effect.Effect<A>,
    none: A,
  ): Effect.Effect<A> =>
    options.own.pipe(
      Effect.flatMap((environment) =>
        environment === null ? Effect.succeed(none) : use(options.host(environment)),
      ),
      Effect.orElseSucceed(() => none),
    );

  return {
    requestStart: (input) => through((host) => host.requestStart(input), failed),
    servers: (input) => through((host) => host.servers(input), failed),
    apply: (input) => through((host) => host.apply(input), failed),
    request: (input, hooks) =>
      through((host) => host.request(input, hooks), HostLost.make({ message: NO_HOST })),
  };
};
