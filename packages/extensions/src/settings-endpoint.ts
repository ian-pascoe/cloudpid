// The Settings' and the MCP servers' tools as the endpoint serves them (`docs/architecture/mcp-endpoint.md` → Environment and
// Settings tools → Shared definitions and the core/wrapper split, → Retries: `request_id`): every core `/mcp`'s dispatcher
// runs for them over the endpoint's services, and the answer a repeat of a `request_id` gets that an earlier call recorded
// changes for. A Limit and the Instructions wait for the owner's Approval, which the dispatcher asks before it runs these
// cores (`./approval-cores.ts`); the cores answer one `unsupported` (the dispatcher maps that code through). So do the MCP
// servers' changes that widen what is reachable, and `settings_mcp_add`, `_update` and `_enable`, which always ask: their cores
// are `./settings-mcp-approvals.ts`, and these make only the change that narrows. The Limit options of `settings_extension_set`
// are refused by its core in the same way.
// @effect-diagnostics missingPipeableSignature:off
import { SETTINGS_SCOPE } from "@cloudpid/protocol";
import { GLOBAL_ID, GLOBAL_NAME } from "@cloudpid/protocol/harness-tools";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import { type RecordedChange, type Replayed, replayedChange } from "./environment-changes.ts";
import type { SettingsMcpAccessService } from "./settings-mcp-access.ts";
import { type McpChangeToolName, mcpChangeCores } from "./settings-mcp-cores.ts";
import { settingsResetCore } from "./settings-reset.ts";
import {
  NOT_PICKED,
  type SettingsAccessService,
  type SettingsChangeToolName,
  settingsChangeCores,
} from "./settings.ts";

/** What the endpoint's cores for the Settings and the MCP servers run over: no Session, so nothing is its own. */
export type SettingsEndpointServices = {
  readonly settings: SettingsAccessService;
  readonly settingsMcp: SettingsMcpAccessService;
  /** Whether a text holds a deploy-time credential (the Registry checks the kept Secrets in the write itself). */
  readonly holdsSecret: (value: string) => Effect.Effect<boolean>;
  /** The main Worker's push of an Environment's new set to its host (`mcp.sync`), after the answer, for each one a change reaches. */
  readonly sync?: ((environment: string) => Effect.Effect<void>) | undefined;
};

/** The changing tools the endpoint serves for the Settings and the MCP servers. */
export type SettingsEndpointToolName =
  | SettingsChangeToolName
  | "settings_reset"
  | McpChangeToolName;

/** The cores of those tools, over `services`. */
export const settingsEndpointCores = (services: SettingsEndpointServices) => {
  const base = {
    access: services.settings,
    // The endpoint has no Session to read the Settings again, so nothing is picked.
    reload: Effect.succeed(NOT_PICKED),
    holdsSecret: services.holdsSecret,
  };

  const mcp = mcpChangeCores({
    access: services.settingsMcp,
    settings: services.settings,
    holdsSecret: services.holdsSecret,
    sync: services.sync,
  });

  const { resetField, ...mcpTools } = mcp;

  return {
    ...settingsChangeCores(base),
    settings_reset: settingsResetCore({ ...base, mcp: { resetField } }),
    ...mcpTools,
  };
};

export type SettingsEndpointCores = ReturnType<typeof settingsEndpointCores>;

/** `settings_mcp_reload`'s core, which takes no `request_id` and records nothing: it runs over the access alone. */
export { mcpReloadCore } from "./settings-mcp-cores.ts";

/** A record of Global's Settings, as an answer names its Scope: the Registry keeps them under `settings`. */
const atGlobal = (changes: ReadonlyArray<RecordedChange>): ReadonlyArray<RecordedChange> =>
  Arr.map(changes, (change) =>
    change.scope === SETTINGS_SCOPE
      ? { ...change, scope: GLOBAL_ID, scopeName: GLOBAL_NAME }
      : change,
  );

const replayedSettings = replayedChange("settings_get");

const replayedServers: Replayed = (changes, scope) =>
  replayedChange("settings_mcp_list")(atGlobal(changes), scope);

const replayedAtGlobal: Replayed = (changes, scope) => replayedSettings(atGlobal(changes), scope);

/**
 * Each tool's replayed answer, by name: the shared fields from the records an earlier call with the same `request_id` left,
 * the rest neutral (`docs/architecture/mcp-endpoint.md` → Retries: `request_id`).
 */
export const SETTINGS_REPLAYED: Readonly<Record<SettingsEndpointToolName, Replayed>> = {
  settings_model_set: replayedAtGlobal,
  settings_role_set: replayedAtGlobal,
  settings_tool_offer: replayedAtGlobal,
  settings_tool_defer: replayedAtGlobal,
  settings_compaction_set: replayedAtGlobal,
  settings_branch_summary_set: replayedAtGlobal,
  settings_extension_set: replayedAtGlobal,
  settings_reset: replayedAtGlobal,
  settings_mcp_disable: replayedServers,
  settings_mcp_exposure_set: replayedServers,
  settings_mcp_tool_exposure_set: replayedServers,
  settings_mcp_remove: replayedServers,
};
