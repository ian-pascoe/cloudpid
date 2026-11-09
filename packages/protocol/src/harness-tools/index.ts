// The Environment and Settings tools both surfaces serve, as declarations (`docs/architecture/mcp-endpoint.md` →
// Environment and Settings tools → Shared definitions and the core/wrapper split): each tool's name,
// annotations, and, for the Session surface and the endpoint surface, its description, input schema and output schema.
// `packages/extensions` builds each tool's core and wrapper from one declaration, and `McpServer` turns the endpoint's
// into MCP tool definitions. This subpath imports only `effect`, `@cloudpid/config` and its own files, so McpWorker can
// import it without pi-durable (`packages/protocol/.oxlintrc.json`).
//
// The tools join `HARNESS_TOOLS` as the stage that serves them declares them. The Self-use rule reads its names: the
// Session registers none of the endpoint's tools that it has in-session twins of.
// @effect-diagnostics missingPipeableSignature:off
import * as Record from "effect/Record";
import {
  APPROVAL_ASK_TOOLS,
  APPROVAL_FOLLOW_TOOLS,
  type ApprovalAskToolName,
  type ApprovalFollowToolName,
} from "./approvals.ts";
import { environmentGet, environmentList } from "./environment.ts";
import { CONTAINER_SETTING_TOOLS, environmentSecretBuild } from "./environment-changes.ts";
import {
  environmentCreate,
  environmentRebuild,
  environmentRename,
  environmentRepoAdd,
  environmentRepoRemove,
} from "./environment-lifecycle.ts";
import { environmentSettingReset } from "./environment-reset.ts";
import {
  environmentSkillInstall,
  environmentSkillRemove,
  environmentSkillUpdate,
} from "./environment-skills.ts";
import { settingsGet } from "./settings.ts";
import { settingsReset, SETTINGS_CHANGE_TOOLS } from "./settings-changes.ts";
import { settingsMcpGet, settingsMcpList } from "./settings-mcp.ts";
import { SETTINGS_MCP_CHANGE_TOOLS, settingsMcpReload } from "./settings-mcp-changes.ts";

export * from "./approvals.ts";

export * from "./change-output.ts";

export * from "./environment.ts";

export * from "./environment-changes.ts";

export * from "./environment-lifecycle.ts";

export * from "./environment-reset.ts";

export * from "./environment-skills.ts";

export * from "./lifecycle-output.ts";

export * from "./skill-words.ts";

// `Source` and `placement` are this folder's own pieces of the output schemas, not part of its surface.
export {
  BuildOutput,
  EnvironmentGetOutput,
  EnvironmentListOutput,
  RepoOutput,
  SecretOutput,
  SettingsOutput,
  SkillOutput,
  SkillSourceOutput,
  VariableOutput,
} from "./environment-output.ts";

export * from "./field-page.ts";

export * from "./reason.ts";

export * from "./scope.ts";

export * from "./secret-name.ts";

export * from "./settings.ts";

export * from "./settings-changes.ts";

export * from "./settings-mcp.ts";

export * from "./settings-mcp-changes.ts";

export * from "./settings-mcp-output.ts";

export * from "./settings-output.ts";

export * from "./surface.ts";

/**
 * Every harness tool's declaration, by name: the five reads, the nine Container setting tools,
 * `environment_secret_build`, the five tools for an Environment's record and Build, `environment_setting_reset`, the
 * three that install, update and remove an Environment's Skills, the Settings' changing tools, `settings_mcp_reload` and
 * the MCP servers' narrowing tools, and the endpoint's own declarations of the tools that ask for the owner's Approval
 * and of `approval_wait` and `approval_withdraw`, which have no `session` part.
 */
export const HARNESS_TOOLS = {
  environment_list: environmentList,
  environment_get: environmentGet,
  ...CONTAINER_SETTING_TOOLS,
  environment_secret_build: environmentSecretBuild,
  environment_create: environmentCreate,
  environment_rename: environmentRename,
  environment_repo_add: environmentRepoAdd,
  environment_repo_remove: environmentRepoRemove,
  environment_rebuild: environmentRebuild,
  environment_setting_reset: environmentSettingReset,
  environment_skill_install: environmentSkillInstall,
  environment_skill_update: environmentSkillUpdate,
  environment_skill_remove: environmentSkillRemove,
  settings_get: settingsGet,
  settings_mcp_list: settingsMcpList,
  settings_mcp_get: settingsMcpGet,
  ...SETTINGS_CHANGE_TOOLS,
  settings_reset: settingsReset,
  settings_mcp_reload: settingsMcpReload,
  ...SETTINGS_MCP_CHANGE_TOOLS,
  ...APPROVAL_ASK_TOOLS,
  ...APPROVAL_FOLLOW_TOOLS,
} as const;

export type HarnessToolName = keyof typeof HARNESS_TOOLS;

/** The tools with a `session` part: all but the endpoint's own declarations of the asking and following tools. */
export type SessionHarnessToolName = Exclude<
  HarnessToolName,
  ApprovalAskToolName | ApprovalFollowToolName
>;

/** The tools the `harness` operation serves: all but `approval_wait` and `approval_withdraw`, which have their own. */
export type DispatchedToolName = Exclude<HarnessToolName, ApprovalFollowToolName>;

/** Whether `name` is one of the endpoint-only tools with an operation of its own. */
export const isApprovalFollowTool = (name: string): name is ApprovalFollowToolName =>
  name === APPROVAL_FOLLOW_TOOLS.approval_wait.name ||
  name === APPROVAL_FOLLOW_TOOLS.approval_withdraw.name;

/** The names of `HARNESS_TOOLS`, in the order it declares them. */
// SAFETY: the keys of the record are its tools' names.
export const HARNESS_TOOL_NAMES = Record.keys(HARNESS_TOOLS) as ReadonlyArray<HarnessToolName>;
