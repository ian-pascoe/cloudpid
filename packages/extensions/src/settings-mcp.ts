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
import { HARNESS_TOOLS } from "@cloudpid/protocol/harness-tools";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Effect from "effect/Effect";
import type { Approvals } from "./approvals.ts";
import {
  pushMcpSet,
  SettingsMcpAccess,
  type SettingsMcpAccessService,
} from "./settings-mcp-access.ts";
import { toolResult } from "./harness.ts";
import { outputSchema } from "./outputs.ts";
import type { AgentChangeLog, DeployCredentials } from "./environment.ts";
import type { Secrets } from "./secrets/store.ts";
import type { SettingsAccess, SettingsReload } from "./settings.ts";

import { mcpReloadCore } from "./settings-mcp-cores.ts";
import { settingsMcpGetRead, settingsMcpListRead } from "./settings-mcp-reads.ts";
import { McpChangeTools } from "./settings-mcp-changes.ts";
import { McpDefinitionTools } from "./settings-mcp-definitions.ts";

export { pushMcpSet, SettingsMcpAccess, type SettingsMcpAccessService };

export const extensionName = "settings_mcp";

/** The tools of the extension that are built: the read-only three. */
export const SETTINGS_MCP_READ_TOOLS = [
  "settings_mcp_list",
  "settings_mcp_get",
  "settings_mcp_reload",
] as const;

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

  const reloadRead = mcpReloadCore(access);
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
    name: HARNESS_TOOLS.settings_mcp_reload.name,
    description: HARNESS_TOOLS.settings_mcp_reload.session.description,
    parameters: HARNESS_TOOLS.settings_mcp_reload.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.settings_mcp_reload.session.output),
    replay: "safe",
    execute: (args) => Effect.map(reloadRead(args, "session"), toolResult),
  });

  return defineExtension({
    name: extensionName,
    tools: [list, get, reload, ...changing, ...defining],
  });
});
