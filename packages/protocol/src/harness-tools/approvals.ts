// The tools whose change waits for the owner's Approval, as the MCP endpoint serves them, and the two endpoint-only tools
// that follow one (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools → Approvals with no Session;
// ADR-0050). On the endpoint nothing waits for the owner inside a call: an asking tool answers `pending` with the request's
// id and the url of its card, and `approval_wait` follows it. These declarations are the endpoint's only (`session` is
// absent): the in-session tools keep their own (`packages/extensions/src/approval-tools.ts`), which wait for the answer.
// The Self-use rule still reads their names (`HARNESS_TOOL_NAMES`), so a Session's own endpoint offers none of them.
// @effect-diagnostics missingPipeableSignature:off
import { InstanceType, MAX_INSTRUCTIONS_BYTES } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import { NextField } from "./field-page.ts";
import { MAX_CHANGE_REASON, RequestIdField } from "./reason.ts";
import { GLOBAL_ID, GLOBAL_SETTINGS_SCOPE, idOrGlobal, ScopeRef, SettingsScope } from "./scope.ts";
import { DESTRUCTIVE_IDEMPOTENT, READ_ONLY, WRITE } from "./surface.ts";

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

/** The asking tools the endpoint serves, by name. */
export const APPROVAL_ASK_TOOLS = {
  settings_spend_limit_set: settingsSpendLimitSet,
  settings_subagent_depth_set: settingsSubagentDepthSet,
  settings_subagent_workspaces_set: settingsSubagentWorkspacesSet,
  settings_instructions_set: settingsInstructionsSet,
  environment_container_size_limit_set: environmentContainerSizeLimitSet,
} as const;

export type ApprovalAskToolName = keyof typeof APPROVAL_ASK_TOOLS;

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
