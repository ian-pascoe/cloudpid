// The Session's reach to the Registry's MCP servers and to the Environments' `McpHost`s, for the `settings_mcp` tools
// (`docs/architecture/mcp-configuration.md` → The agent's changes): the Registry's MCP read, the held inventory of a host,
// and the push of a changed set, which the Registry never makes itself. Shared by the read tools (`./settings-mcp.ts`) and the
// ones that change servers (`./settings-mcp-changes.ts`).
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off -- builders over plain values.
import type { McpApplySet, McpServersRequest, McpSetRevision } from "@cloudpid/mcp/types";
import type {
  McpFieldChange,
  SettingsMcpChangeCheck,
  SettingsMcpReload,
  SettingsMcpView,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { Mutable } from "effect/Types";
import type { McpHostClientService } from "./mcp/client.ts";
import { GLOBAL_SETTINGS_SCOPE, type SettingsAccessError } from "./settings.ts";
import { type Inventory, notRead } from "./settings-mcp-values.ts";

/**
 * The Registry's MCP read, the Environments' hosts and the pushes of a changed set, as the Session reaches them. `view` and
 * `reload` fail, saying so, for an id no Environment has.
 */
export type SettingsMcpAccessService = {
  /** The MCP servers of `scope` (`*`, or an Environment's id), only `name`'s when given, with its layers as written. */
  readonly view: (input: {
    readonly scope: string;
    readonly name?: string | undefined;
  }) => Effect.Effect<SettingsMcpView, SettingsAccessError>;
  /** The Session's own Environment; null when the Registry does not list it. */
  readonly own: Effect.Effect<string | null, SettingsAccessError>;
  /** Look at `environment`'s Repos' files again, under the shared throttle, and what that made of the set. */
  readonly reload: (environment: string) => Effect.Effect<SettingsMcpReload, SettingsAccessError>;
  /**
   * What a change of server `name`'s `changes` would do to each Environment's set, before anything is written (the Registry's
   * `mcpChangeCheck`): whether the entry in force changes there, and what it makes reachable that was not.
   */
  readonly check: (input: {
    readonly scope: string;
    readonly name: string;
    readonly changes: ReadonlyArray<McpFieldChange>;
  }) => Effect.Effect<SettingsMcpChangeCheck, SettingsAccessError>;
  /** The sets the Registry has yet to hand `environment`'s host (`mcpPending`'s pushes for it), each with its revision. */
  readonly pushes: (
    environment: string,
  ) => Effect.Effect<ReadonlyArray<McpApplySet>, SettingsAccessError>;
  /** Tell the Registry its host took a set (`mcpPushed`), so it is not sent again. */
  readonly pushed: (
    input: McpSetRevision & { readonly environment: string },
  ) => Effect.Effect<void, SettingsAccessError>;
  /** The `McpHost` of Environment `environment`, own or another's: a host that is not asked is not woken. */
  readonly host: (environment: string) => McpHostClientService;
};

export class SettingsMcpAccess extends Context.Service<
  SettingsMcpAccess,
  SettingsMcpAccessService
>()("@cloudpid/extensions/settings-mcp-access/SettingsMcpAccess") {}

/**
 * The host's inventory of `view`'s servers, with `parts`. Asked for an Environment's set that has servers, whichever
 * Environment it is, and never for one without any (a host is not woken for none). It names no Workspace, waits for
 * nothing and has the host start no discovery (`demand: false`): it reads what the host holds, and starts no Container.
 */
export const readInventory = (
  access: SettingsMcpAccessService,
  input: {
    readonly view: SettingsMcpView;
    readonly names?: ReadonlyArray<string>;
    readonly parts: ReadonlyArray<string>;
  },
): Effect.Effect<Inventory> =>
  Effect.gen(function* () {
    const { view } = input;

    if (view.scope === GLOBAL_SETTINGS_SCOPE) return notRead("global");

    if (view.servers.length === 0) return notRead("no_servers");

    const request: Mutable<McpServersRequest> = { parts: input.parts, demand: false };

    if (input.names !== undefined) request.names = input.names;

    const answer = yield* access.host(view.scope).servers(request);

    return Predicate.isTagged(answer, "HostFailed")
      ? notRead("host_unavailable")
      : {
          read: "read",
          byName: new Map(Arr.map(answer.servers, (server) => [server.name, server] as const)),
        };
  });

/**
 * Send `environment`'s host the set the Registry has not handed it (`mcpPending`'s push for it), as the main Worker does
 * after the owner's save: the Registry never calls out, so the Session carries the push of its own change, to any
 * Environment's host (`docs/architecture/mcp-configuration.md` → From the Registry to the host). It tells the Registry
 * once the host took it. `not_needed` when there is nothing to hand it (the host has the set, or neither it nor the set
 * has a server, `shouldPushMcpSet`: such a host is never woken) or it holds a later one; `failed` when the push could
 * not be made: nothing fails the tool for it, and the host's next pull heals it.
 */
export const pushMcpSet = (
  access: SettingsMcpAccessService,
  environment: string,
): Effect.Effect<"pushed" | "not_needed" | "failed"> =>
  Effect.gen(function* () {
    const sets = yield* access.pushes(environment);

    if (sets.length === 0) return "not_needed" as const;

    const host = access.host(environment);
    let sent = false;

    for (const set of sets) {
      const answer = yield* host.apply(set);

      if (Predicate.isTagged(answer, "Applied")) {
        yield* access.pushed({ environment, hash: set.hash, revision: set.revision });
        sent = true;
      } else if (!Predicate.isTagged(answer, "Stale")) {
        return "failed" as const;
      }
    }

    return sent ? ("pushed" as const) : ("not_needed" as const);
  }).pipe(Effect.orElseSucceed(() => "failed" as const));
