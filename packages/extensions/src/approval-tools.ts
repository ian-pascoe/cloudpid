// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off
// The tools whose Agent changes wait for the owner's Approval (`docs/architecture/agent-changes.md` → Approval,
// ADR-0019): those that change a Limit (`settings_spend_limit_set`, `settings_subagent_depth_set`,
// `settings_subagent_workspaces_set`, `environment_container_size_limit_set`, and `settings_reset` of a Limit) and
// those no revert can undo (`environment_delete`, `environment_secret_delete`), and `settings_instructions_set`, since
// the Instructions steer every conversation unasked (ADR-0027). The Settings' Limits are kept at both Scopes
// (ADR-0027): their tools and `settings_reset` take a required `scope`, `*` for Global or an Environment's id, and ask
// at either. `settings_reset` lives here for its Limits, but a reset of any other
// field is made at once, without asking, as the `settings` tools make a change. Each checks what it can first and
// refuses without asking what it would refuse anyway; then it asks the owner (`withApproval`), and on Approve makes
// the change as the other tools do (applied, recorded with an approved mark, in the Run's Notification), provided the target still has the value the owner saw. A Decline
// changes nothing, and the result carries the owner's reason. The tools are the root conversation's only
// (`PARENT_ONLY_TOOL_PREFIXES` has `environment_` and `settings_`), run alone, and are replayed after an eviction: the
// rerun waits for the same request, or takes the answer given meanwhile. Each gives programs the outcome
// (`docs/architecture/agent-capabilities.md` → Values for programs) as a `structuredOutput`: the Scope or Environment,
// the Agent changes made, and the owner's Approval, approved or declined with their reason (null where no one was
// asked, as when the target has the value). The shapes are in `./settings-outputs.ts` (the Settings),
// `./environment-outputs.ts` (the Environments) and `./outputs.ts` (the parts they share). The Limit tools and
// `settings_instructions_set` are thin wrappers over cores (`./approval-cores.ts`, `./environment-size-limit.ts`;
// `docs/architecture/mcp-endpoint.md` → Approvals with no Session) that `approvedChange` runs between `withApproval` and the
// Session's after-steps. The deletes are wrappers over cores too (`./environment-deletes.ts`), which run its reads and
// checks one by one, since a rerun asks again for a target that is gone.
import {
  InstanceType,
  isMcpField,
  MAX_INSTRUCTIONS_BYTES,
  OVERRIDE_FIELD_NAMES,
  overrideFieldPath,
} from "@cloudpid/config";
import { defineEffectTool } from "@cloudpid/effect-durable";
import { DELETED_FIELD, keptSecretField, SecretName } from "@cloudpid/protocol";
import {
  GLOBAL_ID,
  GLOBAL_SETTINGS_SCOPE,
  idOrGlobal,
  SettingsScope,
} from "@cloudpid/protocol/harness-tools";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  type Applied,
  INSTRUCTIONS_FIELD,
  instructionsCore,
  limitOfField,
  resetLimitCore,
  SETTINGS_LIMITS,
  type SettingsCore,
  spendLimitCore,
  subagentDepthCore,
  subagentWorkspacesCore,
} from "./approval-cores.ts";
import {
  type ApprovalCall,
  Approvals,
  approvedChange,
  askedBefore,
  withApproval,
} from "./approvals.ts";
import {
  AgentChangeLog,
  type DeployCredentials,
  Environments,
  Id,
  MAX_CHANGE_REASON,
  plainTextCheck,
  recordContainerSettingChange,
} from "./environment.ts";
import {
  environmentDeleteCore,
  type EnvironmentRemovalService,
  secretDeleteCore,
} from "./environment-deletes.ts";
import { EnvironmentDeleteOutput, EnvironmentSecretDeleteOutput } from "./environment-outputs.ts";
import { notFound } from "./environment-describe.ts";
import { type HarnessAnswer, toolResult } from "./harness.ts";
import { SIZE_LIMIT_TOOL, sizeLimitCore } from "./environment-size-limit.ts";
import { ChangeOutput, EnvironmentChangeOutput, outputSchema } from "./outputs.ts";
import { Secrets } from "./secrets/store.ts";
import {
  type AppliedSettingsChange,
  CHANGE_NOTE,
  loggedChange,
  SCOPE_NOTE,
  SettingsAccess,
  SettingsAccessError,
  SettingsChanges,
  SettingsReload,
  type SettingsView,
} from "./settings.ts";
import type { SettingsMcpAccess } from "./settings-mcp-access.ts";
import { McpChanges } from "./settings-mcp-changes.ts";
import { resetPlain } from "./settings-reset.ts";
import { DEFAULT_MAX_SUBAGENT_DEPTH } from "./subagents/options.ts";
import { DEFAULT_MAX_SUBAGENT_WORKSPACES } from "./subagents/workspaces.ts";

export const extensionName = "approval-tools";

export {
  EnvironmentFootprint,
  type EnvironmentRemovalService,
  type KeptSecretMark,
  type SecretDeleted,
  type StepProgress,
} from "./environment-deletes.ts";

export class EnvironmentRemoval extends Context.Service<
  EnvironmentRemoval,
  EnvironmentRemovalService
>()("@cloudpid/extensions/approval-tools/EnvironmentRemoval") {}

/** The fields `settings_reset` takes, as its description and its refusal list them. */
const RESET_FIELDS = Arr.join(OVERRIDE_FIELD_NAMES, ", ");

const Reason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CHANGE_REASON),
).annotate({
  description:
    "Why you make the change, shown to the user on the Approval card and kept with the change, such as 'the test suite needs 12 GiB of memory'",
});

const APPROVAL =
  "The user is asked for their Approval on a card in the Session (and a notification): the call waits for the answer, with no deadline. On Approve the change is made and recorded as approved; on Decline nothing changes, and the result carries their reason. If the user changes the same setting meanwhile, the approval does not apply and you are told to ask again.";

/**
 * The tools that wait for the owner's Approval: over the Session's `Environments`, `EnvironmentRemoval` and
 * `SettingsAccess`, asking through its `Approvals`, refusing a reason or an Instructions text that holds a Secret
 * (`Secrets`) or a deploy-time credential (`DeployCredentials`), and telling the Session of each change for the Run's Notification (`AgentChangeLog`).
 */
export const ApprovalTools: Effect.Effect<
  Extension,
  never,
  | Approvals
  | Environments
  | EnvironmentRemoval
  | SettingsAccess
  | SettingsMcpAccess
  | SettingsReload
  | AgentChangeLog
  | DeployCredentials
  | Secrets
> = Effect.gen(function* () {
  const approvals = yield* Approvals;
  const environments = yield* Environments;
  const removal = yield* EnvironmentRemoval;
  const access = yield* SettingsAccess;
  const reload = yield* SettingsReload;
  const log = yield* AgentChangeLog;

  const plainText = yield* plainTextCheck;
  const settingsEngine = yield* SettingsChanges;
  const { reach } = settingsEngine;
  const mcp = yield* McpChanges;

  const plainReason = (reason: string) => plainText(reason, "the reason", "Say why without it.");

  const services = { access, plainText };

  const deleteCore = environmentDeleteCore({ environments, removal, plainText });

  const secretCore = secretDeleteCore({ environments, removal, plainText });

  /** A core's answer as the Session's result of a declined request has it. */
  const declinedResult = ({ text, structured, details }: HarnessAnswer) => ({
    output: [{ type: "text" as const, text }],
    details,
    structuredOutput: structured,
  });

  /**
   * The Session's after-steps of a Settings change made: the Run's Notification of each field, the reload and, for a Limit
   * (`reaching`: its field), what the change reaches.
   */
  const afterSettingsChange =
    (tool: string, reaching: string | undefined) =>
    (applied: Applied<SettingsView, AppliedSettingsChange>) =>
      Effect.gen(function* () {
        if (applied.result.status !== "changed") return { reach: "" };

        for (const made of applied.result.changes) {
          yield* log.record(loggedChange(applied.known, tool, made.field));
        }

        yield* reload.apply;

        return {
          reach: reaching === undefined ? "" : (yield* reach(applied.known, [reaching])).text,
        };
      });

  /** A Settings tool from its core: it asks, applies on Approve, and tells the Session. */
  const settingsTool =
    <Args extends { readonly scope: string; readonly reason: string }>(core: SettingsCore<Args>) =>
    (args: Args, api: ApprovalCall) =>
      approvedChange(approvals, api, core, args, afterSettingsChange(core.tool, core.limit?.field));

  const setSpend = settingsTool(spendLimitCore(services));

  const setDepth = settingsTool(subagentDepthCore(services));

  const setWorkspaces = settingsTool(subagentWorkspacesCore(services));

  const setInstructions = settingsTool(instructionsCore(services));

  const sizeCore = sizeLimitCore({ environments, plainText });

  const spendLimit = yield* defineEffectTool({
    name: "settings_spend_limit_set",
    description: Arr.join(
      [
        "Set the spend limit: the US dollars one Session (its root conversation and every subagent) may spend on model requests before it stops, or null for no limit. It is a Limit, so the user must approve the change, at either Scope.",
        SCOPE_NOTE,
        APPROVAL,
        CHANGE_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      scope: SettingsScope,
      per_session: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThan(0))).annotate({
        description: "US dollars per Session, more than 0; null turns the limit off",
      }),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(ChangeOutput),
    executionMode: "sequential",
    // The wait survives an eviction: the rerun finds the same request, or the answer given meanwhile.
    replay: "safe",
    execute: (args, api) => setSpend(args, api),
  });

  const subagentDepth = yield* defineEffectTool({
    name: "settings_subagent_depth_set",
    description: Arr.join(
      [
        `Set the subagent depth: how many levels of subagents may run below the root conversation (1: the root's children only; ${DEFAULT_MAX_SUBAGENT_DEPTH}, the default: their children too). A deeper tree can spend more at once. It is a Limit, so the user must approve the change, at either Scope. Subagents that run keep the depth they started with.`,
        SCOPE_NOTE,
        APPROVAL,
        CHANGE_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      scope: SettingsScope,
      depth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
        description: "Levels of subagents below the root, at least 1",
      }),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(ChangeOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: (args, api) => setDepth(args, api),
  });

  const subagentWorkspaces = yield* defineEffectTool({
    name: "settings_subagent_workspaces_set",
    description: Arr.join(
      [
        `Set the Subagent Workspace limit: how many Subagent Workspaces (subagent with workspace "new": a Workspace of its own, with its own Container) one Session may have at once, default ${DEFAULT_MAX_SUBAGENT_WORKSPACES}. Each runs a Container of its own, which costs while it runs. It is a Limit, so the user must approve the change, at either Scope. Subagent Workspaces that exist stay.`,
        SCOPE_NOTE,
        APPROVAL,
        CHANGE_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      scope: SettingsScope,
      limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
        description: "Subagent Workspaces one Session may have at once; 0 allows none",
      }),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(ChangeOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: (args, api) => setWorkspaces(args, api),
  });

  const reset = yield* defineEffectTool({
    name: "settings_reset",
    description: Arr.join(
      [
        `Reset one setting at a Scope: with an Environment's id, remove the Environment's Override of the field, so it inherits Global again; with scope "${GLOBAL_SETTINGS_SCOPE}", put the field back to its default at Global (an Environment that overrides it keeps its Override). A field the Environment does not override, or that is at its default at Global, changes nothing. The fields: ${RESET_FIELDS}. A Role is one field (its model and hint together), and so is each extension option.`,
        `Resetting a Limit (${Arr.join(
          Arr.map(SETTINGS_LIMITS, (limit) => limit.field),
          ", ",
        )}) waits for the user's Approval at either Scope, as the Limit tools do: ${APPROVAL} Any other field is reset at once. An MCP server's field (mcp.servers.<name>.enabled, .exposure or .toolExposure) is reset only at an Environment, and only where it is an adjustment of a server Global or a Repo defines (settings_mcp_list shows the fields it holds); it is refused at "*", for a key of the Environment's own entry (use settings_mcp_disable or the exposure tools) and for mcp.servers.<name> itself (settings_mcp_remove removes a server). A reset that would make a switched-off server or a hidden tool reachable again waits for the user's Approval, as settings_mcp_enable does.`,
        CHANGE_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      scope: SettingsScope,
      field: Schema.String.check(Schema.isMinLength(1)).annotate({
        description:
          "The setting to reset, as settings_get and the Agent changes name it, such as model, roles.small, compaction.enabled or extensions.subagents.readToolset",
      }),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(ChangeOutput),
    executionMode: "sequential",
    // A Limit's wait survives an eviction; a rerun of any other field's reset finds it reset, and changes nothing.
    replay: "safe",
    execute: ({ scope, field, reason }, api) =>
      Effect.gen(function* () {
        yield* plainReason(reason);

        // Clearing them steers every conversation as much as writing them: their own tool asks the owner first.
        if (field === INSTRUCTIONS_FIELD) {
          return yield* SettingsAccessError.make({
            message:
              "Nothing was asked or saved: settings_reset does not take the Instructions. settings_instructions_set with an empty text removes them, once the user approves.",
          });
        }

        if (overrideFieldPath(field) === undefined) {
          return yield* SettingsAccessError.make({
            message: `Nothing was asked or saved: ${field} is not a setting settings_reset takes. The settings are: ${RESET_FIELDS}.`,
          });
        }

        // An MCP server's adjustment: only at an Environment; one that falls back to something reachable waits for the user's Approval.
        if (isMcpField(field)) {
          return yield* mcp.resetField({ scope, field, reason, api });
        }

        const limit = limitOfField(field);

        // A Limit's reset waits for the owner's Approval.
        if (Option.isSome(limit)) {
          return yield* settingsTool(resetLimitCore(services, limit.value))({ scope, reason }, api);
        }

        const view = yield* access.get(scope);

        return yield* resetPlain(settingsEngine, {
          surface: "session",
          view,
          field,
          reason,
          conversation: api.conversationId,
        });
      }),
  });

  const instructions = yield* defineEffectTool({
    name: "settings_instructions_set",
    description: Arr.join(
      [
        `Set the user's Instructions at one Scope: Markdown that conversations' models (each Session's root and its subagents) are shown in their system prompt from the start of their Context Window, before the Project instructions of the AGENTS.md files. They are what the user wants of every Session (Global) or of every Session in one Environment; what only one repo needs belongs in its Project instructions (AGENTS.md). Give the whole text: it replaces that Scope's Instructions, and an empty text removes them. At most ${MAX_INSTRUCTIONS_BYTES / 1024} KiB of UTF-8 per Scope. settings_get shows them.`,
        "They steer conversations unasked, so the user must approve each change; set them only when the user asks. An approved change applies from each conversation's next Context Window (a new Session, a Handoff or a Rollover), never inside one: a context that has begun, this one included, keeps showing the Instructions it started with.",
        `Give scope "${GLOBAL_SETTINGS_SCOPE}" for the Global Instructions, which every Session's conversations are shown, or an Environment's id for its own, which its Sessions' conversations are shown after the Global ones. They add up rather than one replacing the other: where two disagree the nearer wins, the Environment's over the Global ones, and the Project instructions over both.`,
        APPROVAL,
        "The change is recorded with your reason, and the user can see it as a line diff and revert it on the Settings page.",
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      scope: SettingsScope,
      text: Schema.String.annotate({
        description: `The whole Instructions, as Markdown (at most ${MAX_INSTRUCTIONS_BYTES / 1024} KiB of UTF-8); empty removes them`,
      }),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(ChangeOutput),
    executionMode: "sequential",
    // The wait survives an eviction: the rerun finds the same request, or the answer given meanwhile.
    replay: "safe",
    execute: (args, api) => setInstructions(args, api),
  });

  const LimitId = idOrGlobal(
    "the size limit at Global, which each Environment that does not override it inherits",
  );

  const sizeLimit = yield* defineEffectTool({
    name: "environment_container_size_limit_set",
    description: Arr.join(
      [
        "Set an Environment's size limit (the one id names): the largest size its Containers may have, which bounds environment_container_resize and container_resize. A larger limit lets the agent run larger, costlier Containers, so it is a Limit and the user must approve the change. It cannot be below the Environment's own size: lower that first with environment_container_resize.",
        `With id "${GLOBAL_ID}" the limit at Global is set: each Environment that does not override it inherits it, and a limit that would leave such an Environment's size above it is refused. Setting an Environment's limit makes it the Environment's own; environment_setting_reset makes it inherit Global's again.`,
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: LimitId,
      size: InstanceType.annotate({ description: "The largest size the Environment allows" }),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(EnvironmentChangeOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: (args, api) =>
      approvedChange(
        approvals,
        api,
        sizeCore,
        args,
        recordContainerSettingChange(log, SIZE_LIMIT_TOOL, "maxInstance"),
      ),
  });

  const deleteEnvironment = yield* defineEffectTool({
    name: "environment_delete",
    description: Arr.join(
      [
        "Delete an Environment, as the user's delete on the Environments page does: its Workspaces with their Sessions (archived ones too) and everything not pushed in them, its spare Workspace, its Build, the Secrets kept for it, its Triggers and its Agent changes. No revert can bring it back, so the user must approve it. The default Environment and this Session's own Environment cannot be deleted.",
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: Id,
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(EnvironmentDeleteOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: (args, api) =>
      Effect.gen(function* () {
        const { id, reason } = args;

        yield* deleteCore.check(args);

        const found = yield* deleteCore.read(id);
        const rerun = yield* askedBefore(approvals, api);

        if (found === null && !rerun) return yield* notFound(id);

        // A rerun whose Environment is gone (deleted by this call before the Session restarted, or by the user) waits
        // for, or takes, the answer to the request it made: what it shows the owner is that request's.
        const known = {
          environment: found?.details ?? { id, name: id },
          footprint: found?.footprint ?? null,
        };

        return yield* withApproval(
          approvals,
          api,
          { ...deleteCore.card(known, reason), expected: known.footprint },
          (answer) =>
            Effect.gen(function* () {
              if (!answer.approved) {
                return declinedResult(deleteCore.declined(args, known, answer));
              }

              const applied = yield* deleteCore.apply(
                args,
                answer.expected,
                { conversation: api.conversationId, tool: deleteCore.tool, reason },
                known,
              );

              if (applied.result.status === "deleted") {
                yield* log.record({
                  tool: deleteCore.tool,
                  environmentName: applied.result.environment.name,
                  field: DELETED_FIELD,
                });
              }

              return toolResult(
                yield* deleteCore.render(args, answer.expected, applied, undefined),
              );
            }),
        );
      }),
  });

  const deleteSecret = yield* defineEffectTool({
    name: "environment_secret_delete",
    description: Arr.join(
      [
        `Delete a Secret kept for an Environment (the one id names; id "${GLOBAL_ID}" is a Secret kept Global), as the user's delete on the Environments page does: commands and Sessions no longer get it, nor Builds. The history keeps no value, so no revert brings it back, and the user must approve it. environment_get lists the Secrets kept (names only).`,
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: idOrGlobal("a Secret kept Global"),
      name: SecretName.annotate({ description: "The Secret's name, such as NPM_TOKEN" }),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(EnvironmentSecretDeleteOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: (args, api) =>
      Effect.gen(function* () {
        const { known, secret } = yield* secretCore.read(args);

        if (Option.isNone(secret) && !(yield* askedBefore(approvals, api))) {
          return yield* secretCore.notKept(args, known);
        }

        const { card, expected } = secretCore.card(args, known, secret);

        return yield* withApproval(approvals, api, { ...card, expected }, (answer) =>
          Effect.gen(function* () {
            if (!answer.approved) {
              return declinedResult(secretCore.declined(args, known, answer));
            }

            const applied = yield* secretCore.apply(
              args,
              answer.expected,
              { conversation: api.conversationId, tool: secretCore.tool, reason: args.reason },
              known,
            );

            if (applied.result.status === "deleted") {
              yield* log.record({
                tool: secretCore.tool,
                environmentName: applied.result.environment.name,
                field: keptSecretField(args.name),
              });
            }

            return toolResult(yield* secretCore.render(args, answer.expected, applied, undefined));
          }),
        );
      }),
  });

  return defineExtension({
    name: extensionName,
    tools: [
      spendLimit,
      subagentDepth,
      subagentWorkspaces,
      sizeLimit,
      deleteEnvironment,
      deleteSecret,
      reset,
      instructions,
    ],
  });
});
