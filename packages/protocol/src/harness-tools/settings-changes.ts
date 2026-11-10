// The Settings' changing tools for both surfaces (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools →
// Names and surfaces, The tools; `docs/architecture/agent-changes.md`): `settings_model_set`, `_role_set`,
// `_tool_offer`, `_tool_defer`, `_compaction_set`, `_branch_summary_set`, `_extension_set` and `settings_reset`. The
// in-session descriptions, parameters and output schemas stay as they were (the snapshot in
// `packages/extensions/src/harness-session.test.ts` pins them). The endpoint's sentences name the owner and no Session,
// and no tool the endpoint does not serve (`tool_search`); every endpoint input takes `request_id`, and every endpoint
// output is a flat object. A Limit's reset asks the owner there, as the Limit tools do (`./approvals.ts`), and answers
// `pending`, as does a reset of an MCP field that would widen what a server reaches; `settings_reset` does not take the
// Instructions (`settings_instructions_set` clears them).
// @effect-diagnostics missingPipeableSignature:off
import {
  extensionField,
  ModelId,
  OVERRIDE_FIELD_NAMES,
  ROLE_NAMES,
  THINKING_LEVELS,
  ThinkingLevel,
} from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import { ApprovalRequestFields } from "./approvals.ts";
import { ChangeEndpointOutput, ChangeOutput } from "./change-output.ts";
import { RequestIdField, settingsReason } from "./reason.ts";
import { GLOBAL_SETTINGS_SCOPE, SettingsScope } from "./scope.ts";
import { WRITE, WRITE_IDEMPOTENT } from "./surface.ts";

/** The options of `extensions.subagents` that are lists of tool name patterns (the subagents extension's own list). */
export const SUBAGENT_TOOLSET_OPTION_NAMES: ReadonlyArray<string> = [
  "baseToolset",
  "readToolset",
  "modifyToolset",
];

/** The tools every conversation is offered whatever `tools.offered` says (`tool-search.ts`' own list). */
export const ALWAYS_OFFERED_TOOL_NAMES: ReadonlyArray<string> = ["tool_search", "context_rollover"];

/** The Limits' fields (`approval-cores.ts` builds its Limits over them). */
export const SPEND_LIMIT_FIELD = "spendLimit.perSession";
export const DEPTH_LIMIT_FIELD = extensionField("subagents", "maxSubagentDepth");
export const WORKSPACES_LIMIT_FIELD = extensionField("subagents", "maxSubagentWorkspaces");

/**
 * The fields that are Limits, as the tools' descriptions name them: their tools, and a reset of one, wait for the owner's
 * Approval. Which field a call names is a Limit is decided by `limitOfField` (`@cloudpid/extensions/approval-cores`, built
 * over these fields), for the Session's tools and the endpoint's routing alike.
 */
export const SETTINGS_LIMIT_FIELDS: ReadonlyArray<string> = [
  SPEND_LIMIT_FIELD,
  DEPTH_LIMIT_FIELD,
  WORKSPACES_LIMIT_FIELD,
];

/** What the tools that wait for the owner's Approval say of the card. */
export const APPROVAL_NOTE =
  "The user is asked for their Approval on a card in the Session (and a notification): the call waits for the answer, with no deadline. On Approve the change is made and recorded as approved; on Decline nothing changes, and the result carries their reason. If the user changes the same setting meanwhile, the approval does not apply and you are told to ask again.";

/** What the descriptions of the changing tools say of the `scope`. */
export const SCOPE_NOTE = `Give scope "${GLOBAL_SETTINGS_SCOPE}" to change Global, which each Environment inherits unless it overrides the field, or an Environment's id (environment_list shows them) to override Global for that Environment's Sessions only; there is no default. At an Environment the value is kept as its Override even when it equals Global's, so the field stops following Global until settings_reset removes the Override.`;

/** What the descriptions of the changing tools say of the record and of the Sessions a change reaches. */
export const CHANGE_NOTE =
  "The change is recorded with your reason, and the user can see and revert it on the Settings page. Each Session runs with its own Environment's Settings (its Overrides over Global over the defaults): a change at an Environment reaches only that Environment's Sessions, and a change at Global only those whose Environment does not override the field. A Session it reaches uses it from its next request (this one) or when it next admits input (the others); the result says whether it reaches this Session.";

/** The same on the endpoint: no Session is its own, and a Session takes a change when it next admits input. */
export const CHANGE_NOTE_ENDPOINT =
  "The change is recorded with your reason, and the owner can see and revert it on the Settings page. Each Session runs with its own Environment's Settings (its Overrides over Global over the defaults): a change at an Environment reaches only that Environment's Sessions, and a change at Global only those whose Environment does not override the field. A Session it reaches uses it when it next admits input.";

/**
 * What the descriptions say of the models: the Model catalog changes without a release, so it is never listed in a
 * description (ADR-0052), which must stay as it is for the prompt cache; the agent lists it with `models_list`.
 */
const MODEL_NOTE =
  "Models: any id models_list lists (provider/id, such as anthropic/claude-opus-5-5); one the model proxy does not serve is refused";

/** The same on the endpoint, where `environments_list` lists the models. */
const MODEL_NOTE_ENDPOINT =
  "Models: any of environments_list's models.available (as provider/id, such as anthropic/claude-opus-5-5); one the model proxy does not serve is refused";

const Reason = settingsReason("user", "this task is small and cheap");

const ReasonEndpoint = settingsReason("owner", "this task is small and cheap");

const paragraphs = (lines: ReadonlyArray<string>): string => Arr.join(lines, "\n\n");

/** What the offer result and description say of a tool a conversation loaded, and of a pattern. */
export const OFFER_NOTE =
  "A tool that a conversation has loaded with tool_search stays offered to it. A pattern is a tool's name, or a name with * for any run of characters (context_*): snake_case, and one that matches no tool does nothing.";

/** The same on the endpoint, where there is no `tool_search`. */
export const OFFER_NOTE_ENDPOINT =
  "A tool that a conversation has loaded stays offered to it. A pattern is a tool's name, or a name with * for any run of characters (context_*): snake_case, and one that matches no tool does nothing.";

const listNote =
  "The offered tools are one setting: the list in force at the Scope gets the entry, and is saved whole there (at an Environment, as its Override).";

// ─── settings_model_set ──────────────────────────────────────────────────────

const modelFields = {
  scope: SettingsScope,
  model: Schema.optionalKey(ModelId.annotate({ description: "The default model" })),
  thinking_level: Schema.optionalKey(
    ThinkingLevel.annotate({ description: "The default thinking level" }),
  ),
};

export const settingsModelSet = {
  name: "settings_model_set",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description: paragraphs([
      `Set the default model and/or thinking level: what a Session's root conversation runs with until the Session picks its own with the model picker. ${MODEL_NOTE}; thinking levels: ${Arr.join(THINKING_LEVELS, ", ")}. Give at least one of them.`,
      "A Session that picked its own model or thinking level keeps its pick; the result says whether this Session did. Subagents keep the agent they started with: their models come from the roles (settings_role_set).",
      SCOPE_NOTE,
      CHANGE_NOTE,
    ]),
    input: Schema.Struct({ ...modelFields, reason: Reason }),
    output: ChangeOutput,
  },
  endpoint: {
    description: paragraphs([
      `Set the default model and/or thinking level: what a Session's root conversation runs with until the Session picks its own with the model picker. ${MODEL_NOTE_ENDPOINT}; thinking levels: ${Arr.join(THINKING_LEVELS, ", ")}. Give at least one of them.`,
      "A Session that picked its own model or thinking level keeps its pick. Subagents keep the agent they started with: their models come from the roles (settings_role_set).",
      SCOPE_NOTE,
      CHANGE_NOTE_ENDPOINT,
    ]),
    input: Schema.Struct({ ...modelFields, reason: ReasonEndpoint, ...RequestIdField }),
    output: ChangeEndpointOutput,
  },
} as const;

// ─── settings_role_set ───────────────────────────────────────────────────────

const roleFields = {
  scope: SettingsScope,
  role: Schema.Literals(ROLE_NAMES).annotate({ description: "The role to change" }),
  model: ModelId.annotate({ description: "The role's model" }),
  hint: Schema.optionalKey(
    Schema.String.annotate({
      description: "When an agent should pick this role (replaces the hint it has)",
    }),
  ),
};

const roleIntro = `Set one model role: the model a subagent runs on when it is started with that role, and optionally its hint, the text that tells an agent when to pick it. Roles: ${Arr.join(ROLE_NAMES, ", ")}.`;

const roleNote =
  "A Role's model and hint are one setting: a hint left out keeps the hint the role has at that Scope now, and at an Environment the two are its Override together. The change reaches the next subagent started; subagents that run keep the model they started with.";

const roleLines = [`${roleIntro} ${MODEL_NOTE}.`, roleNote];

const roleLinesEndpoint = [`${roleIntro} ${MODEL_NOTE_ENDPOINT}.`, roleNote];

export const settingsRoleSet = {
  name: "settings_role_set",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description: paragraphs([...roleLines, SCOPE_NOTE, CHANGE_NOTE]),
    input: Schema.Struct({ ...roleFields, reason: Reason }),
    output: ChangeOutput,
  },
  endpoint: {
    description: paragraphs([...roleLinesEndpoint, SCOPE_NOTE, CHANGE_NOTE_ENDPOINT]),
    input: Schema.Struct({ ...roleFields, reason: ReasonEndpoint, ...RequestIdField }),
    output: ChangeEndpointOutput,
  },
} as const;

// ─── settings_tool_offer and settings_tool_defer ─────────────────────────────

const offerFields = {
  scope: SettingsScope,
  pattern: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "The tool's name or a pattern, such as web_fetch or settings_*",
  }),
};

export const settingsToolOffer = {
  name: "settings_tool_offer",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description: paragraphs([
      "Offer a tool to the model from the first request: add one entry (a tool's name, or a pattern with * for any run of characters, such as context_*) to the offered tools, which every conversation's model is shown without searching. The rest of the tools are deferred: the model loads them with tool_search, and code mode scripts call them without loading. Every offered tool costs context on every request, so offer what is used constantly.",
      OFFER_NOTE,
      listNote,
      SCOPE_NOTE,
      CHANGE_NOTE,
    ]),
    input: Schema.Struct({ ...offerFields, reason: Reason }),
    output: ChangeOutput,
  },
  endpoint: {
    description: paragraphs([
      "Offer a tool to the model from the first request: add one entry (a tool's name, or a pattern with * for any run of characters, such as context_*) to the offered tools, which every conversation's model is shown without searching. The rest of the tools are deferred: the model loads one when it needs it. Every offered tool costs context on every request, so offer what is used constantly.",
      OFFER_NOTE_ENDPOINT,
      listNote,
      SCOPE_NOTE,
      CHANGE_NOTE_ENDPOINT,
    ]),
    input: Schema.Struct({ ...offerFields, reason: ReasonEndpoint, ...RequestIdField }),
    output: ChangeEndpointOutput,
  },
} as const;

const deferFields = {
  scope: SettingsScope,
  pattern: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      "The entry of the offered tools to remove, as settings_get shows it (a tool's name or a pattern)",
  }),
};

export const settingsToolDefer = {
  name: "settings_tool_defer",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description: paragraphs([
      `Defer a tool: remove one entry (exactly as settings_get lists it) from the offered tools, so the model loads the tools it names with tool_search instead of being shown them. ${Arr.join(ALWAYS_OFFERED_TOOL_NAMES, " and ")} stay offered whatever the list says. An entry that is a pattern covers many tools: remove it whole, or offer fewer by replacing it.`,
      "A tool that a conversation has loaded with tool_search stays offered to it.",
      listNote,
      SCOPE_NOTE,
      CHANGE_NOTE,
    ]),
    input: Schema.Struct({ ...deferFields, reason: Reason }),
    output: ChangeOutput,
  },
  endpoint: {
    description: paragraphs([
      "Defer a tool: remove one entry (exactly as settings_get lists it) from the offered tools, so the model loads the tools it names when it needs them instead of being shown them. The tools every conversation always has stay offered whatever the list says. An entry that is a pattern covers many tools: remove it whole, or offer fewer by replacing it.",
      "A tool that a conversation has loaded stays offered to it.",
      listNote,
      SCOPE_NOTE,
      CHANGE_NOTE_ENDPOINT,
    ]),
    input: Schema.Struct({ ...deferFields, reason: ReasonEndpoint, ...RequestIdField }),
    output: ChangeEndpointOutput,
  },
} as const;

// ─── settings_compaction_set ─────────────────────────────────────────────────

const compactionFields = {
  scope: SettingsScope,
  enabled: Schema.optionalKey(Schema.Boolean),
  reserve_tokens: Schema.optionalKey(Schema.Finite),
  keep_recent_tokens: Schema.optionalKey(Schema.Finite),
  background_tokens: Schema.optionalKey(Schema.Finite),
};

const compactionLines = [
  "Set automatic compaction: whether a conversation's context is summarized before it outgrows the model's window, and how. Give at least one of the settings; those left out stay as they are. Each is a setting of its own, overridden at an Environment by itself.",
  "`enabled` turns it on or off. `reserve_tokens` is the room kept free for the next answer (the window minus this triggers compaction), `keep_recent_tokens` how much of the latest messages a compaction keeps as they are, and `background_tokens` how far before the trigger a compaction may start in the background (0 turns that off). The token counts are whole numbers; reserve and keep above 0.",
];

export const settingsCompactionSet = {
  name: "settings_compaction_set",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description: paragraphs([...compactionLines, SCOPE_NOTE, CHANGE_NOTE]),
    input: Schema.Struct({ ...compactionFields, reason: Reason }),
    output: ChangeOutput,
  },
  endpoint: {
    description: paragraphs([...compactionLines, SCOPE_NOTE, CHANGE_NOTE_ENDPOINT]),
    input: Schema.Struct({ ...compactionFields, reason: ReasonEndpoint, ...RequestIdField }),
    output: ChangeEndpointOutput,
  },
} as const;

// ─── settings_branch_summary_set ─────────────────────────────────────────────

const branchSummaryFields = {
  scope: SettingsScope,
  skip_prompt: Schema.Boolean.annotate({
    description: "True: leave a branch without asking or summarizing",
  }),
};

export const settingsBranchSummarySet = {
  name: "settings_branch_summary_set",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description: paragraphs([
      "Set whether the web app asks, when the user moves to another point of a Session's tree, whether to carry a summary of the branch they leave (a model request on the Session's usage). With skip_prompt true it does not ask and carries no summary; false asks.",
      SCOPE_NOTE,
      CHANGE_NOTE,
    ]),
    input: Schema.Struct({ ...branchSummaryFields, reason: Reason }),
    output: ChangeOutput,
  },
  endpoint: {
    description: paragraphs([
      "Set whether the web app asks, when the owner moves to another point of a Session's tree, whether to carry a summary of the branch they leave (a model request on the Session's usage). With skip_prompt true it does not ask and carries no summary; false asks.",
      SCOPE_NOTE,
      CHANGE_NOTE_ENDPOINT,
    ]),
    input: Schema.Struct({ ...branchSummaryFields, reason: ReasonEndpoint, ...RequestIdField }),
    output: ChangeEndpointOutput,
  },
} as const;

// ─── settings_extension_set ──────────────────────────────────────────────────

const extensionFields = {
  scope: SettingsScope,
  extension: Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/^[^.]+$/)).annotate({
    description: "The extension's name, without dots, such as subagents",
  }),
  key: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "The option's name, such as readToolset",
  }),
  value: Schema.Json.annotate({
    description:
      "The option's value (JSON); null takes the option away at Global, or removes its Override at an Environment",
  }),
};

const extensionLine = `Set one option of one extension: the settings keep each extension's options under its name, and an extension reads the ones it knows. The subagents extension reads ${Arr.join(SUBAGENT_TOOLSET_OPTION_NAMES, ", ")} (lists of tool names or patterns with *: the tools a subagent is granted); an option no extension reads is saved and does nothing. Each option is a setting of its own. A value of null at Global takes the option away, back to the extension's default; at an Environment it removes the option's Override, so the option inherits Global (as settings_reset does).`;

export const settingsExtensionSet = {
  name: "settings_extension_set",
  annotations: WRITE_IDEMPOTENT,
  session: {
    description: paragraphs([
      extensionLine,
      "The subagent depth (subagents.maxSubagentDepth) and the Subagent Workspace limit (subagents.maxSubagentWorkspaces) are Limits: they are not set here, but with settings_subagent_depth_set and settings_subagent_workspaces_set, which ask the user for their Approval.",
      SCOPE_NOTE,
      CHANGE_NOTE,
    ]),
    input: Schema.Struct({ ...extensionFields, reason: Reason }),
    output: ChangeOutput,
  },
  endpoint: {
    description: paragraphs([
      extensionLine,
      "The subagent depth (subagents.maxSubagentDepth) and the Subagent Workspace limit (subagents.maxSubagentWorkspaces) are Limits: a call that names one is refused as unsupported, and nothing is changed. settings_subagent_depth_set and settings_subagent_workspaces_set ask the owner for them.",
      SCOPE_NOTE,
      CHANGE_NOTE_ENDPOINT,
    ]),
    input: Schema.Struct({ ...extensionFields, reason: ReasonEndpoint, ...RequestIdField }),
    output: ChangeEndpointOutput,
  },
} as const;

// ─── settings_reset ──────────────────────────────────────────────────────────

const resetFields = {
  scope: SettingsScope,
  field: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      "The setting to reset, as settings_get and the Agent changes name it, such as model, roles.small, compaction.enabled or extensions.subagents.readToolset",
  }),
};

/** The fields `settings_reset` takes, as its description and its refusal list them. */
export const RESET_FIELDS = Arr.join(OVERRIDE_FIELD_NAMES, ", ");

/**
 * The endpoint's answer to `settings_reset`: a change's, or, for a Limit, the ask's (`status` "pending" with the request,
 * or "unchanged"), with no changes made yet.
 */
export const SettingsResetEndpointOutput = Schema.Struct({
  ...ChangeEndpointOutput.fields,
  status: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'For a Limit, or an MCP field whose reset widens: "pending" when the owner was asked (approval_wait follows the request), "unchanged" when it is reset already; absent for any other field, which is reset at once',
    }),
  ),
  ...ApprovalRequestFields,
});

const resetLead = (fields: string) =>
  `Reset one setting at a Scope: with an Environment's id, remove the Environment's Override of the field, so it inherits Global again; with scope "${GLOBAL_SETTINGS_SCOPE}", put the field back to its default at Global (an Environment that overrides it keeps its Override). A field the Environment does not override, or that is at its default at Global, changes nothing. The fields: ${fields}. A Role is one field (its model and hint together), and so is each extension option.`;

const resetMcpNote =
  "An MCP server's field (mcp.servers.<name>.enabled, .exposure or .toolExposure) is reset only at an Environment, and only where it is an adjustment of a server Global or a Repo defines (settings_mcp_list shows the fields it holds); it is refused at \"*\", for a key of the Environment's own entry (use settings_mcp_disable or the exposure tools) and for mcp.servers.<name> itself (settings_mcp_remove removes a server).";

export const settingsReset = {
  name: "settings_reset",
  annotations: WRITE,
  session: {
    description: paragraphs([
      resetLead(RESET_FIELDS),
      `Resetting a Limit (${Arr.join(SETTINGS_LIMIT_FIELDS, ", ")}) waits for the user's Approval at either Scope, as the Limit tools do: ${APPROVAL_NOTE} Any other field is reset at once. ${resetMcpNote} A reset that would make a switched-off server or a hidden tool reachable again waits for the user's Approval, as settings_mcp_enable does.`,
      CHANGE_NOTE,
    ]),
    input: Schema.Struct({ ...resetFields, reason: Reason }),
    output: ChangeOutput,
  },
  endpoint: {
    description: paragraphs([
      resetLead(RESET_FIELDS),
      `Resetting a Limit (${Arr.join(SETTINGS_LIMIT_FIELDS, ", ")}) waits for the owner's Approval, as the Limit tools do: the call does not wait for them, but answers status "pending" with an approval_id, the url of the card the owner answers, and when the request expires; follow it with approval_wait. Any other field is reset at once. The Instructions are not a field here: settings_instructions_set with an empty text clears them, once the owner approves. ${resetMcpNote} A reset that would make a switched-off server or a hidden tool reachable again waits for the owner's Approval too, as settings_mcp_enable does, and answers the same way.`,
      CHANGE_NOTE_ENDPOINT,
    ]),
    input: Schema.Struct({ ...resetFields, reason: ReasonEndpoint, ...RequestIdField }),
    output: SettingsResetEndpointOutput,
  },
} as const;

/** The changing Settings tools the endpoint serves besides `settings_reset`, in the order the `settings` extension registers them. */
export const SETTINGS_CHANGE_TOOLS = {
  settings_model_set: settingsModelSet,
  settings_role_set: settingsRoleSet,
  settings_tool_offer: settingsToolOffer,
  settings_tool_defer: settingsToolDefer,
  settings_compaction_set: settingsCompactionSet,
  settings_branch_summary_set: settingsBranchSummarySet,
  settings_extension_set: settingsExtensionSet,
} as const;

export type SettingsChangeToolName = keyof typeof SETTINGS_CHANGE_TOOLS;
