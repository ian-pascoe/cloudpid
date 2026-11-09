// The tools whose change waits for the owner's Approval, as the MCP endpoint serves them, and the two endpoint-only tools
// that follow one (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools → Approvals with no Session;
// ADR-0050). On the endpoint nothing waits for the owner inside a call: an asking tool answers `pending` with the request's
// id and the url of its card, and `approval_wait` follows it. These declarations are the endpoint's only (`session` is
// absent): the in-session tools keep their own (`packages/extensions/src/approval-tools.ts`), which wait for the answer.
// The Self-use rule still reads their names (`HARNESS_TOOL_NAMES`), so a Session's own endpoint offers none of them. The
// MCP servers' definition tools (`settings_mcp_add`, `_update`, `_enable`) are here: they always ask. The ones that ask only
// when they widen (`settings_mcp_exposure_set` and the others) keep their declarations in `./settings-mcp-changes.ts`.
// @effect-diagnostics missingPipeableSignature:off
import { InstanceType, MAX_INSTRUCTIONS_BYTES } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import { NextField } from "./field-page.ts";
import { MAX_CHANGE_REASON, RequestIdField } from "./reason.ts";
import {
  environmentId,
  GLOBAL_ID,
  GLOBAL_SETTINGS_SCOPE,
  idOrGlobal,
  ScopeRef,
  SettingsScope,
} from "./scope.ts";
import { SecretName } from "./secret-name.ts";
import { DESTRUCTIVE, DESTRUCTIVE_IDEMPOTENT, READ_ONLY, WRITE } from "./surface.ts";

/** The most seconds `approval_wait` waits, and how long it waits when it is not told. */
export const MAX_APPROVAL_WAIT_S = 300;

export const DEFAULT_APPROVAL_WAIT_S = 45;

/** An asking tool's `reason`: the owner reads it on the card, and it is kept with the change. */
const AskReason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CHANGE_REASON),
).annotate({
  description:
    "Why you make the change, shown to the owner on the Approval card and kept with the change, such as 'the test suite needs 12 GiB of memory'",
});

/** What every asking tool's description says of the Approval, on the endpoint. */
const APPROVAL = `The owner must approve the change, in cloudpid: the call does not wait for them. It answers status "pending" with an approval_id, the url of the card the owner answers, and when the request expires (7 days); follow it with approval_wait, which says whether it was approved and applied, declined, or not applied. On Approve the change is made only while the target still has the value the owner saw, and is recorded as approved, with your reason. Asking again for the same change while one waits answers the same approval_id (a different value replaces the waiting request); at most 10 of yours may wait or be applying at once. A value the target has already is answered "unchanged", and nothing is asked. A Secret's value in an argument is refused, and nothing is asked.`;

/** What the Settings tools' descriptions say of the Scope, on the endpoint. */
const SCOPE = `Give scope "${GLOBAL_SETTINGS_SCOPE}" to change Global, which each Environment inherits unless it overrides the field, or an Environment's id (environment_list shows them) to override Global for that Environment's Sessions only; there is no default. At an Environment the value is kept as its Override even when it equals Global's.`;

/** What the Settings tools' descriptions say of whom a change reaches, on the endpoint. */
const REACH =
  "The owner can see and revert the change on the Settings page. A change at an Environment reaches only that Environment's Sessions, and a change at Global only those whose Environment does not override the field; each takes it when it next admits input, and a Run going keeps what it started with.";

/** What a `pending` answer says of the request: its id, its card's url, and when it expires. */
export const ApprovalRequestFields = {
  approval_id: Schema.optionalKey(
    Schema.String.annotate({
      description: "The request's id, for approval_wait and approval_withdraw",
    }),
  ),
  url: Schema.optionalKey(
    Schema.String.annotate({ description: "Where the owner answers it: its card in cloudpid" }),
  ),
  expires_at: Schema.optionalKey(
    Schema.String.annotate({ description: "When the request expires unanswered (ISO 8601)" }),
  ),
};

/** The endpoint's answer to an asking tool: the request made (or the one waiting already), or the value set already. */
export const ApprovalAskOutput = Schema.Struct({
  ...NextField,
  status: Schema.String.annotate({
    description:
      '"pending": the owner was asked, and approval_wait follows the request; "unchanged": the target has the value already, so nothing was asked',
  }),
  ...ApprovalRequestFields,
  scope: Schema.optionalKey(ScopeRef),
  unchanged: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description: 'For "unchanged": the fields that have the value already',
    }),
  ),
});

export type ApprovalAskOutput = typeof ApprovalAskOutput.Type;

export const settingsSpendLimitSet = {
  name: "settings_spend_limit_set",
  annotations: WRITE,
  endpoint: {
    description: Arr.join(
      [
        "Ask the owner to set the spend limit: the US dollars one Session (its root conversation and every subagent) may spend on model requests before it stops, or null for no limit. It is a Limit, at either Scope.",
        SCOPE,
        APPROVAL,
        REACH,
      ],
      "\n\n",
    ),
    input: Schema.Struct({
      scope: SettingsScope,
      per_session: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThan(0))).annotate({
        description: "US dollars per Session, more than 0; null turns the limit off",
      }),
      reason: AskReason,
      ...RequestIdField,
    }),
    output: ApprovalAskOutput,
  },
} as const;

export const settingsSubagentDepthSet = {
  name: "settings_subagent_depth_set",
  annotations: WRITE,
  endpoint: {
    description: Arr.join(
      [
        "Ask the owner to set the subagent depth: how many levels of subagents may run below a Session's root conversation (1: the root's children only). A deeper tree can spend more at once. It is a Limit, at either Scope. Subagents that run keep the depth they started with.",
        SCOPE,
        APPROVAL,
        REACH,
      ],
      "\n\n",
    ),
    input: Schema.Struct({
      scope: SettingsScope,
      depth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
        description: "Levels of subagents below the root, at least 1",
      }),
      reason: AskReason,
      ...RequestIdField,
    }),
    output: ApprovalAskOutput,
  },
} as const;

export const settingsSubagentWorkspacesSet = {
  name: "settings_subagent_workspaces_set",
  annotations: WRITE,
  endpoint: {
    description: Arr.join(
      [
        "Ask the owner to set the Subagent Workspace limit: how many Subagent Workspaces (a subagent's own Workspace, with its own Container) one Session may have at once. Each runs a Container of its own, which costs while it runs. It is a Limit, at either Scope. Subagent Workspaces that exist stay.",
        SCOPE,
        APPROVAL,
        REACH,
      ],
      "\n\n",
    ),
    input: Schema.Struct({
      scope: SettingsScope,
      limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
        description: "Subagent Workspaces one Session may have at once; 0 allows none",
      }),
      reason: AskReason,
      ...RequestIdField,
    }),
    output: ApprovalAskOutput,
  },
} as const;

export const settingsInstructionsSet = {
  name: "settings_instructions_set",
  annotations: WRITE,
  endpoint: {
    description: Arr.join(
      [
        `Ask the owner to set their Instructions at one Scope: Markdown that conversations' models (each Session's root and its subagents) are shown in their system prompt from the start of their Context Window, before the Project instructions of the AGENTS.md files. They are what the owner wants of every Session (Global) or of every Session in one Environment; what only one repo needs belongs in its AGENTS.md. Give the whole text: it replaces that Scope's Instructions, and an empty text removes them. At most ${MAX_INSTRUCTIONS_BYTES / 1024} KiB of UTF-8 per Scope. settings_get shows them.`,
        "They steer conversations unasked, so the owner approves each change; ask only when the owner wants it. An approved change applies from each conversation's next Context Window (a new Session, a Handoff or a Rollover), never inside one.",
        `Give scope "${GLOBAL_SETTINGS_SCOPE}" for the Global Instructions, which every Session's conversations are shown, or an Environment's id for its own, which its Sessions' conversations are shown after the Global ones.`,
        APPROVAL,
        "The owner can see the change as a line diff and revert it on the Settings page.",
      ],
      "\n\n",
    ),
    input: Schema.Struct({
      scope: SettingsScope,
      text: Schema.String.annotate({
        description: `The whole Instructions, as Markdown (at most ${MAX_INSTRUCTIONS_BYTES / 1024} KiB of UTF-8); empty removes them`,
      }),
      reason: AskReason,
      ...RequestIdField,
    }),
    output: ApprovalAskOutput,
  },
} as const;

export const environmentContainerSizeLimitSet = {
  name: "environment_container_size_limit_set",
  annotations: WRITE,
  endpoint: {
    description: Arr.join(
      [
        "Ask the owner to set an Environment's size limit (the one id names): the largest size its Containers may have, which bounds environment_container_resize. A larger limit lets the agents run larger, costlier Containers, so it is a Limit. It cannot be below the Environment's own size: lower that first with environment_container_resize.",
        `With id "${GLOBAL_ID}" the limit at Global is set: each Environment that does not override it inherits it, and a limit that would leave such an Environment's size above it is refused. Setting an Environment's limit makes it the Environment's own.`,
        APPROVAL,
        "The owner can see and revert the change on the Settings page. It applies to the Container starts after it.",
      ],
      "\n\n",
    ),
    input: Schema.Struct({
      id: idOrGlobal(
        "the size limit at Global, which each Environment that does not override it inherits",
        "endpoint",
      ),
      size: InstanceType.annotate({ description: "The largest size the Environment allows" }),
      reason: AskReason,
      ...RequestIdField,
    }),
    output: ApprovalAskOutput,
  },
} as const;

/** The `name` of an MCP server, as `settings_mcp_list` shows it. */
const McpServerName = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: "The server's name as settings_mcp_list shows it",
});

/** What the descriptions of the MCP servers' definition tools say of what a server definition is, on the endpoint. */
const DEFINITION_NOTE = `A server definition is the owner's to approve because it decides which code runs, where Secrets go (a Global entry resolves \${NAME} against each Environment's Secrets, and an Environment's id as scope writes into that Environment), what every later call sends, and what the model is told (the description). The owner's card says what the server runs or connects to, which \${NAME} values it sends and where, whom it reaches and what it replaces. Keep every credential out of the entry: write \${NAME} for a Secret the owner keeps (they keep Secrets on the Secrets page) or a Variable (environment_variable_set keeps one that is not secret). A literal in an Authorization, Proxy-Authorization, Cookie, X-API-Key or Api-Key header, or in an env or headers key ending TOKEN, SECRET, PASSWORD, PASSWD, API_KEY, APIKEY, ACCESS_KEY or PRIVATE_KEY, is refused. At an Environment a \${NAME} must be a Secret or a Variable there or at Global, or the call is refused. Once approved the change is recorded with your reason, and the new set is sent to the MCP host of each Environment it reaches by cloudpid, after the answer. The result reports the server's status as not_checked: settings_mcp_get shows it later, and the owner signs in on the Settings page if the server asks for a sign-in. A Repo's .pi/mcp.json is edited as a file in a pull request and is no Agent change.`;

export const settingsMcpAdd = {
  name: "settings_mcp_add",
  annotations: WRITE,
  endpoint: {
    description: Arr.join(
      [
        `Ask the owner to add an MCP server at one Scope: at "${GLOBAL_SETTINGS_SCOPE}" to Global's entries, or at an Environment's id to that Environment's own (which replaces Global's server of the name there, or shadows a Repo's). Give exactly one of entry (the server in pi's shape: command, args, env, cwd, url, headers, oauth, timeout, description, sampling, and optionally enabled, exposure, toolExposure; it must define a server with a command or a url) and from_repo (an Environment's id only: the directory name of a Repo of the Environment, whose server of that name is copied from the last good read of its .pi/mcp.json, with \${NAME} kept and a stdio cwd made absolute, /workspace/<directory>; settings_mcp_reload reads the file again). The copy is the owner's server afterwards: it can read Secrets, needs its own MCP sign-in, and no longer follows the Repo's commits.`,
        "Adding a server always waits for the owner's Approval.",
        DEFINITION_NOTE,
        APPROVAL,
      ],
      "\n\n",
    ),
    input: Schema.Struct({
      scope: SettingsScope,
      name: McpServerName,
      entry: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)).annotate({
        description: "The server in pi's shape; exactly one of entry and from_repo",
      }),
      from_repo: Schema.optionalKey(Schema.String).annotate({
        description:
          "The directory name of a Repo of the Environment (as settings_mcp_list shows it, not owner/repo), whose server of this name is copied; an Environment's id as scope only",
      }),
      reason: AskReason,
      ...RequestIdField,
    }),
    output: ApprovalAskOutput,
  },
} as const;

export const settingsMcpUpdate = {
  name: "settings_mcp_update",
  annotations: WRITE,
  endpoint: {
    description: Arr.join(
      [
        `Ask the owner to change the definition of an MCP server where it is defined: Global's at "${GLOBAL_SETTINGS_SCOPE}", an Environment's own entry at its id (a Global server at an Environment is refused: change it at "${GLOBAL_SETTINGS_SCOPE}", or add an entry of its own; a Repo's is changed in the Repo's file). set takes definition keys only: a top-level key replaces its value and null removes it; env, headers and oauth merge key by key, null removing one key; args is replaced whole. enabled, exposure and toolExposure are refused: settings_mcp_disable, settings_mcp_enable, settings_mcp_exposure_set and settings_mcp_tool_exposure_set change them.`,
        "Changing a definition always waits for the owner's Approval.",
        DEFINITION_NOTE,
        APPROVAL,
      ],
      "\n\n",
    ),
    input: Schema.Struct({
      scope: SettingsScope,
      name: McpServerName,
      set: Schema.Record(Schema.String, Schema.Json).annotate({
        description:
          "The definition keys to change: a value replaces the key's, null removes it; env, headers and oauth merge key by key",
      }),
      reason: AskReason,
      ...RequestIdField,
    }),
    output: ApprovalAskOutput,
  },
} as const;

export const settingsMcpEnable = {
  name: "settings_mcp_enable",
  annotations: WRITE,
  endpoint: {
    description: Arr.join(
      [
        "Ask the owner to switch an MCP server on at one Scope. Switching a server on makes its tools reachable again, so it always waits for the owner's Approval, even for a server that is off nowhere it reaches. It connects at the next demand, and its tools are registered once discovered.",
        `A name is the server in force in that Scope's set. At scope "${GLOBAL_SETTINGS_SCOPE}" the key is changed in Global's entry, which reaches every Environment but those whose own entry or adjustment overrides it; at an Environment's id the change is that Environment's own, an Override even when it equals Global's (settings_reset removes it).`,
        "Once approved the change is recorded with your reason, and the new set is sent to the MCP host of each Environment it reaches by cloudpid, after the answer. The result reports the server's status as not_checked: settings_mcp_get shows it later, and the owner signs in on the Settings page if the server asks for a sign-in.",
        APPROVAL,
      ],
      "\n\n",
    ),
    input: Schema.Struct({
      scope: SettingsScope,
      name: McpServerName,
      reason: AskReason,
      ...RequestIdField,
    }),
    output: ApprovalAskOutput,
  },
} as const;

/** What the deletes' descriptions say of the Approval, on the endpoint: no revert can undo one, unlike a change. */
const DELETE_APPROVAL = `No revert can undo it, so the owner must approve it, in cloudpid: the call does not wait for them. It answers status "pending" with an approval_id, the url of the card the owner answers, and when the request expires (7 days); follow it with approval_wait, which says whether it was approved and done, declined, or not done. Asking again for the same delete while one waits answers the same approval_id; at most 10 of yours may wait or be applying at once. A Secret's value in an argument is refused, and nothing is asked.`;

export const environmentDelete = {
  name: "environment_delete",
  annotations: DESTRUCTIVE,
  endpoint: {
    description: Arr.join(
      [
        "Ask the owner to delete an Environment, as their delete on the Settings page does: its Workspaces with their Sessions (archived ones too) and everything not pushed in them, its spare Workspace, its Build, the Secrets kept for it, its Triggers and its Agent changes. The default Environment cannot be deleted, and an id that names no Environment is refused; neither asks.",
        DELETE_APPROVAL,
        "On Approve the Environment is deleted only while it takes no more than the owner saw (no Workspace, Session, kept Secret or Trigger added since). The delete is long: cloudpid runs it while the owner has cloudpid open, so approval_wait reports it approved and not finished until it is done, and does not run it itself. Its requests still waiting are withdrawn with it.",
      ],
      "\n\n",
    ),
    input: Schema.Struct({
      id: environmentId("endpoint"),
      reason: AskReason,
      ...RequestIdField,
    }),
    output: ApprovalAskOutput,
  },
} as const;

export const environmentSecretDelete = {
  name: "environment_secret_delete",
  annotations: DESTRUCTIVE,
  endpoint: {
    description: Arr.join(
      [
        `Ask the owner to delete a Secret kept for an Environment (the one id names; id "${GLOBAL_ID}" is a Secret kept Global), as their delete on the Secrets page does: commands, Sessions and Builds no longer get it. environment_get lists the Secrets kept (names only); a name that is not kept there is refused, and nothing is asked.`,
        DELETE_APPROVAL,
        "On Approve the Secret is deleted only while its value and Build mark are still those the owner saw, and the delete is recorded with your reason; the history keeps no value. The Builds' upkeep runs after it.",
      ],
      "\n\n",
    ),
    input: Schema.Struct({
      id: idOrGlobal("a Secret kept Global", "endpoint"),
      name: SecretName.annotate({ description: "The Secret's name, such as NPM_TOKEN" }),
      reason: AskReason,
      ...RequestIdField,
    }),
    output: ApprovalAskOutput,
  },
} as const;

/** The asking tools the endpoint serves, by name. */
export const APPROVAL_ASK_TOOLS = {
  settings_spend_limit_set: settingsSpendLimitSet,
  settings_subagent_depth_set: settingsSubagentDepthSet,
  settings_subagent_workspaces_set: settingsSubagentWorkspacesSet,
  settings_instructions_set: settingsInstructionsSet,
  environment_container_size_limit_set: environmentContainerSizeLimitSet,
  environment_delete: environmentDelete,
  environment_secret_delete: environmentSecretDelete,
  settings_mcp_add: settingsMcpAdd,
  settings_mcp_update: settingsMcpUpdate,
  settings_mcp_enable: settingsMcpEnable,
} as const;

export type ApprovalAskToolName = keyof typeof APPROVAL_ASK_TOOLS;

/**
 * The tools that ask the owner only when their change widens what an MCP server reaches (`docs/architecture/mcp-configuration.md`
 * → Approval): they narrow at once, through their own core, and the three `settings_mcp` ones are the endpoint's changing
 * tools with an output of their own (`McpChangeAskOutput`). The reset of an MCP field is `settings_reset`'s.
 */
export const MCP_WIDENING_TOOLS = [
  "settings_mcp_exposure_set",
  "settings_mcp_tool_exposure_set",
  "settings_mcp_remove",
] as const;

export type McpWideningToolName = (typeof MCP_WIDENING_TOOLS)[number];

/**
 * The Skill tools whose change asks the owner at Global (`id: "*"`) and is made at once at an Environment (S3b-3). They keep
 * their declarations in `./environment-skills.ts`. An install and an update are multi-write: each Skill is kept in a
 * transaction of its own, so an approved one cut midway is applied again under the same attempt (#685 L18).
 */
export const GLOBAL_SKILL_TOOLS = [
  "environment_skill_install",
  "environment_skill_update",
  "environment_skill_remove",
] as const;

export type GlobalSkillToolName = (typeof GLOBAL_SKILL_TOOLS)[number];

/**
 * Every tool whose change waits for the owner's Approval on the endpoint: the asking tools, the two resets, whose Limit's
 * reset asks (`settings_reset` of a Limit or of an MCP field that widens, `environment_setting_reset` of the size limit),
 * the MCP tools that ask when they widen, and the Skill tools at Global.
 */
export type ApprovalToolName =
  | ApprovalAskToolName
  | McpWideningToolName
  | GlobalSkillToolName
  | "settings_reset"
  | "environment_setting_reset";

const ApprovalId = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: "The approval_id the asking tool answered",
});

/** `approval_wait`'s and `approval_withdraw`'s answer: where the request stands, and what came of it. */
export const ApprovalStateOutput = Schema.Struct({
  ...NextField,
  approval_id: Schema.String,
  tool: Schema.String.annotate({ description: "The tool that asked" }),
  status: Schema.String.annotate({
    description:
      "pending (waiting for the owner), approved (approved, its change being applied: finished is false), finished (applied), declined, changed_since (the target changed since the ask, so nothing was changed), refused (cloudpid refused the change), expired or withdrawn",
  }),
  finished: Schema.Boolean.annotate({
    description: "Nothing more happens to the request: it is applied, or ended without a change",
  }),
  reason: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Why it ended so: the owner's reason for a Decline, what the target is now, cloudpid's refusal, or who withdrew it",
    }),
  ),
  result: Schema.optionalKey(
    Schema.Struct({
      text: Schema.String,
      structured: Schema.Json,
    }).annotate({ description: "For finished: what the applied change says, as the tool would" }),
  ),
  expires_at: Schema.String.annotate({
    description: "When the request expires if the owner has not answered (ISO 8601)",
  }),
  interrupted: Schema.optionalKey(
    Schema.Literal(true).annotate({
      description:
        "The wait was cut short (a deploy): the status is as read once after; wait again",
    }),
  ),
  long: Schema.optionalKey(
    Schema.Literal(true).annotate({
      description:
        "The apply is long (an Environment's delete): cloudpid runs it while the owner has cloudpid open or presses Try again on its card, never approval_wait",
    }),
  ),
});

export type ApprovalStateOutput = typeof ApprovalStateOutput.Type;

export const approvalWait = {
  name: "approval_wait",
  annotations: READ_ONLY,
  endpoint: {
    description: `Wait for the owner's answer to a change that needs their Approval (approval_id, from the tool that asked), up to timeout_s seconds (0 to ${MAX_APPROVAL_WAIT_S}, default ${DEFAULT_APPROVAL_WAIT_S}; 0 reads it once). It returns at once when the request is no longer pending, and otherwise when it changes or the time is up. status says where it stands; finished is true once nothing more happens to it, and result then holds what the applied change says. An approved change whose apply was cut is applied again by this call. Only the owner answers, in cloudpid; at most 8 waits of yours run at once.`,
    input: Schema.Struct({
      approval_id: ApprovalId,
      timeout_s: Schema.optionalKey(
        Schema.Finite.check(
          Schema.isBetween({ minimum: 0, maximum: MAX_APPROVAL_WAIT_S }),
        ).annotate({
          description: `Seconds to wait, 0 to ${MAX_APPROVAL_WAIT_S} (default ${DEFAULT_APPROVAL_WAIT_S}); 0 reads the request once`,
        }),
      ),
    }),
    output: ApprovalStateOutput,
  },
} as const;

export const approvalWithdraw = {
  name: "approval_withdraw",
  annotations: DESTRUCTIVE_IDEMPOTENT,
  endpoint: {
    description:
      "Take back a request for the owner's Approval that is still waiting (approval_id, from the tool that asked): its card goes, and nothing is changed. A request already withdrawn, expired or declined is answered as it is; one the owner approved is refused, whether its change is applied, being applied or was not applied (approval_wait says which).",
    input: Schema.Struct({ approval_id: ApprovalId }),
    output: ApprovalStateOutput,
  },
} as const;

/** The endpoint-only tools that follow a request, each served by an operation of its own. */
export const APPROVAL_FOLLOW_TOOLS = {
  approval_wait: approvalWait,
  approval_withdraw: approvalWithdraw,
} as const;

export type ApprovalFollowToolName = keyof typeof APPROVAL_FOLLOW_TOOLS;
