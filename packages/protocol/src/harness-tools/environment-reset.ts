// `environment_setting_reset` for both surfaces (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools →
// The tools): take an Environment's Override of one Container setting back, so it inherits Global's again. The
// in-session description, parameters and output stay as they were (the snapshot in
// `packages/extensions/src/harness-session.test.ts` pins them). On the endpoint the reset of `maxInstance`, a Limit, asks
// the owner as `environment_container_size_limit_set` does (`./approvals.ts`) and answers `pending`; every other setting
// is reset at once.
// @effect-diagnostics missingPipeableSignature:off
import { CONTAINER_SETTING_NAMES, type ContainerSettings } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import { ApprovalRequestFields } from "./approvals.ts";
import { EnvironmentChangeEndpointOutput, EnvironmentChangeOutput } from "./change-output.ts";
import { MAX_CHANGE_REASON, RequestIdField } from "./reason.ts";
import { idDescription } from "./scope.ts";
import { WRITE } from "./surface.ts";

/** A Container setting an Environment may override and reset, but its variables (`environment_variable_unset`). */
export type ResettableSetting = Exclude<keyof ContainerSettings, "variables">;

/** The Container settings an Environment may override and reset. */
export const RESETTABLE_SETTINGS: ReadonlyArray<ResettableSetting> = Arr.filter(
  CONTAINER_SETTING_NAMES,
  (name): name is ResettableSetting => name !== "variables",
);

/** The setting whose reset waits for the owner's Approval: the size limit, a Limit. */
export const RESET_LIMIT_SETTING = "maxInstance" satisfies ResettableSetting;

/** The `id` of `environment_setting_reset`: an Environment's, never `*`, since Global inherits nothing. */
const ResetId = (surface: "session" | "endpoint") =>
  Schema.String.check(Schema.isMinLength(1)).annotate({
    description: `${idDescription(surface)}. Not "*": Global's settings are not reset here`,
  });

const Setting = Schema.Literals(RESETTABLE_SETTINGS).annotate({
  description: "The Container setting that inherits Global's value again",
});

const ResetReason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CHANGE_REASON),
).annotate({
  description:
    "Why you make the change, for the user to read in the Environment's Agent changes (and on the Approval card, for the size limit), such as 'the Global Setup Script now installs what this one did'",
});

const ResetReasonEndpoint = ResetReason.annotate({
  description:
    "Why you make the change, for the owner to read in the Environment's Agent changes, such as 'the Global Setup Script now installs what this one did'",
});

/**
 * The endpoint's answer to `environment_setting_reset`: a change's, or, for the size limit, the ask's (`status` "pending"
 * with the request, or "unchanged"), with no changes made yet.
 */
export const EnvironmentResetEndpointOutput = Schema.Struct({
  ...EnvironmentChangeEndpointOutput.fields,
  status: Schema.optionalKey(
    Schema.String.annotate({
      description: `For the size limit (${RESET_LIMIT_SETTING}): "pending" when the owner was asked (approval_wait follows the request), "unchanged" when the Environment does not override it; absent for any other setting, which is reset at once`,
    }),
  ),
  ...ApprovalRequestFields,
});

export const environmentSettingReset = {
  name: "environment_setting_reset",
  annotations: WRITE,
  session: {
    description: Arr.join(
      [
        "Reset one of an Environment's Container settings (the one id names): take its own value (its Override) back, so the setting inherits the value at Global again, and each later change of it at Global. environment_get shows which settings are the Environment's own (overridden here) and which are inherited from Global.",
        `The setting is one of ${Arr.join(RESETTABLE_SETTINGS, ", ")}. A variable of its own is taken back with environment_variable_unset, after which a variable at Global of the same name applies again.`,
        "A reset is refused as the user's save would refuse it, such as a size that would be above the size limit. Resetting the size limit (maxInstance) changes a Limit, so the user must approve it: the call waits for their answer on a card in the Session; on Decline nothing changes.",
        "The change is recorded with your reason, and the user can see and revert it on the Environments page. It applies at each Workspace's next Container start; for this Session's own Environment, container_restart applies it now.",
      ],
      "\n\n",
    ),
    input: Schema.Struct({
      id: ResetId("session"),
      setting: Setting,
      reason: ResetReason,
    }),
    output: EnvironmentChangeOutput,
  },
  endpoint: {
    description: Arr.join(
      [
        "Reset one of an Environment's Container settings (the one id names): take its own value (its Override) back, so the setting inherits the value at Global again, and each later change of it at Global. environment_get shows which settings are the Environment's own (overridden here) and which are inherited from Global.",
        `The setting is one of ${Arr.join(RESETTABLE_SETTINGS, ", ")}. A variable of its own is taken back with environment_variable_unset, after which a variable at Global of the same name applies again.`,
        `A reset is refused as the owner's save would refuse it, such as a size that would be above the size limit. Resetting the size limit (${RESET_LIMIT_SETTING}) changes a Limit, which waits for the owner's Approval: the call does not wait for them, but answers status "pending" with an approval_id, the url of the card the owner answers, and when the request expires; follow it with approval_wait.`,
        "The change is recorded with your reason, and the owner can see and revert it on the Environments page. It applies at each Workspace's next Container start: a Container that runs keeps what it started with.",
      ],
      "\n\n",
    ),
    input: Schema.Struct({
      id: ResetId("endpoint"),
      setting: Setting,
      reason: ResetReasonEndpoint,
      ...RequestIdField,
    }),
    output: EnvironmentResetEndpointOutput,
  },
} as const;
