// The `settings_mcp` extension (`docs/architecture/mcp-configuration.md` → The agent's changes; `docs/architecture/agent-changes.md`
// → MCP server changes): the agent's tools for the MCP servers of either Scope, as deferred tools of the root conversation
// only (`settings_` is in `PARENT_ONLY_TOOL_PREFIXES`), in an extension of their own and not in `mcp`, which is rebuilt
// whenever the inventory changes. Here are its read-only tools, `settings_mcp_list`, `settings_mcp_get` and
// `settings_mcp_reload`, and the ordinary changes of `./settings-mcp-changes.ts`: `disable`, `exposure_set` and
// `tool_exposure_set`. The ones that wait for the owner's Approval (`add`, `update`, `remove`, `enable`) join this extension,
// and are not built yet. The values are in `./settings-mcp-values.ts`, their words in `./settings-mcp-words.ts`.
//
// What the tools read has two sources, neither of which connects to a server or starts a Container. The Registry
// (`SettingsMcpAccess`) gives the configuration: the Scope's servers as the owner's set resolves them, where each key comes
// from, what each `${NAME}` reads (`secret`, `variable` or `missing`, never its value), the MCP sign-in, the problems and
// the Repos' files. The Environment's `McpHost`, through `McpHostClient.servers` with `demand: false` (no Workspace, no
// wait, and no discovery started), gives the inventory it holds: the state, the tools and the negotiated protocol version.
// The inventory is null at Global, which has no host, and for an Environment whose set has no server (no host is woken for
// it). Nothing they give holds a resolved value or a hash.
//
// A reload reads the Repos' files again, under the throttle the scheduled looks share, then pushes the set the Registry now
// computes to the Environment's host, since the Registry never calls out, and has the host drop its eras and Legacy sessions
// and rediscover its HTTP servers at once. It is no Agent change.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off globalJsonInEffect:off globalDate:off -- builders over plain values.
import { defineEffectTool } from "@cloudpid/effect-durable";
import {
  GLOBAL_SETTINGS_SCOPE,
  HARNESS_TOOLS,
  SettingsScope,
} from "@cloudpid/protocol/harness-tools";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { Approvals } from "./approvals.ts";
import type { McpHostClientService } from "./mcp/client.ts";
import {
  pushMcpSet,
  SettingsMcpAccess,
  type SettingsMcpAccessService,
} from "./settings-mcp-access.ts";
import { toolResult } from "./harness.ts";
import { asOutput, outputSchema } from "./outputs.ts";
import type { AgentChangeLog, DeployCredentials } from "./environment.ts";
import type { Secrets } from "./secrets/store.ts";
import { type SettingsAccess, SettingsAccessError, type SettingsReload } from "./settings.ts";

import { type ReloadHost, reloadOutput } from "./settings-mcp-values.ts";
import { SettingsMcpReloadOutput } from "./settings-mcp-outputs.ts";
import { settingsMcpGetRead, settingsMcpListRead } from "./settings-mcp-reads.ts";
import { McpChangeTools } from "./settings-mcp-changes.ts";
import { McpDefinitionTools } from "./settings-mcp-definitions.ts";
import { describeReload } from "./settings-mcp-words.ts";

export { pushMcpSet, SettingsMcpAccess, type SettingsMcpAccessService };

export const extensionName = "settings_mcp";

/** The tools of the extension that are built: the read-only three. */
export const SETTINGS_MCP_READ_TOOLS = [
  "settings_mcp_list",
  "settings_mcp_get",
  "settings_mcp_reload",
] as const;

/** How the host answered a reload, as a value gives it. */
const reloadHost = (
  answer: Effect.Success<ReturnType<McpHostClientService["apply"]>> | undefined,
): ReloadHost => {
  if (answer === undefined) {
    return { status: "not_reached", servers: [], note: "the set has no servers" };
  }

  if (Predicate.isTagged(answer, "Reloaded")) {
    return { status: "reloaded", servers: answer.servers, note: null };
  }

  return Predicate.isTagged(answer, "HostUnsupported")
    ? {
        status: "unsupported",
        servers: [],
        note: "the host is an older build that does not reload yet: it heals at the next deploy",
      }
    : { status: "failed", servers: [], note: "the host did not answer" };
};

/**
 * The `settings_mcp` extension: its read-only tools over the Session's `SettingsMcpAccess` (the Registry's MCP read) and
 * the Environments' hosts it reaches (`SettingsMcpAccess.host`), and the changing tools: those that change what is reachable
 * (`McpChangeTools`) and those that define servers (`McpDefinitionTools`), over the Settings' change machinery and the
 * Approvals.
 */
export const SettingsMcpTools: Effect.Effect<
  Extension,
  never,
  | Approvals
  | SettingsMcpAccess
  | SettingsAccess
  | SettingsReload
  | AgentChangeLog
  | DeployCredentials
  | Secrets
> = Effect.gen(function* () {
  const access = yield* SettingsMcpAccess;
  const changing = yield* McpChangeTools;
  const defining = yield* McpDefinitionTools;

  const listRead = settingsMcpListRead(access);
  const getRead = settingsMcpGetRead(access);

  const list = yield* defineEffectTool({
    name: HARNESS_TOOLS.settings_mcp_list.name,
    description: HARNESS_TOOLS.settings_mcp_list.session.description,
    parameters: HARNESS_TOOLS.settings_mcp_list.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.settings_mcp_list.session.output),
    replay: "safe",
    execute: (args) => Effect.map(listRead(args, "session"), toolResult),
  });

  const get = yield* defineEffectTool({
    name: HARNESS_TOOLS.settings_mcp_get.name,
    description: HARNESS_TOOLS.settings_mcp_get.session.description,
    parameters: HARNESS_TOOLS.settings_mcp_get.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.settings_mcp_get.session.output),
    replay: "safe",
    execute: (args) => Effect.map(getRead(args, "session"), toolResult),
  });

  const reload = yield* defineEffectTool({
    name: "settings_mcp_reload",
    description: `Read an Environment's Repos' .pi/mcp.json again (at most once per Repo each 30 seconds, a Repo looked at since being reported as recent), and have the Environment's MCP host drop its eras and Legacy sessions and rediscover its HTTP servers at once: for a server that is stuck, or a file that was just merged. It reports per Repo its directory, slug, path, outcome (changed, unchanged, absent, unreadable, invalid, not_github or recent), blob, read time and error; and for the set the servers added, removed and changed and the problems that appeared and cleared. A Repo that cannot be read keeps its last good copy: only the user's Reload on the Settings page drops it. scope is an Environment's id only ("*" is refused: Global has no Repos and no host). The set is sent to that Environment's MCP host and the host reloaded, whichever Environment it is (a host is not woken for an Environment whose set is and was empty). It is not an Agent change: no reason, no record, no Approval. A Repo's file is read on its default branch only, so a change on a branch shows once it is merged.`,
    parameters: Schema.Struct({ scope: SettingsScope }),
    structuredOutputSchema: outputSchema(SettingsMcpReloadOutput),
    replay: "safe",
    execute: ({ scope }) =>
      Effect.gen(function* () {
        if (scope === GLOBAL_SETTINGS_SCOPE) {
          return yield* SettingsAccessError.make({
            message:
              "settings_mcp_reload takes an Environment's id: Global has no Repos to read and no MCP host to reload. Give the id as environment_list shows it.",
          });
        }

        const report = yield* access.reload(scope);
        const push = yield* pushMcpSet(access, scope);

        // A set with no server has nothing to rediscover, and the host is not woken for none.
        const reloaded =
          report.servers > 0 ? yield* access.host(scope).apply({ kind: "reload" }) : undefined;

        const out = reloadOutput(report, push, reloadHost(reloaded));

        return {
          output: [{ type: "text" as const, text: describeReload(out) }],
          structuredOutput: asOutput(SettingsMcpReloadOutput, out),
          details: { scope: report.scope, servers: report.servers },
        };
      }),
  });

  return defineExtension({
    name: extensionName,
    tools: [list, get, reload, ...changing, ...defining],
  });
});
