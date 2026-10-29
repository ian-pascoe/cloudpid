// What the `settings` and `approval-tools` extensions give programs (`docs/architecture/agent-capabilities.md` → Values for
// programs): each tool's `structuredOutput`, declared as its `structuredOutputSchema` (`./outputs.ts`). The Settings'
// changing tools (and `settings_reset`) answer with `ChangeOutput`, the Scope, the Agent changes made, the fields that
// already had their value and the owner's Approval; `settings_get` answers with the Settings at a Scope, field by field,
// each with where its value comes from; `environment_delete` and `environment_secret_delete` say whether the delete was
// made. What can grow is cut as `./outputs.ts` says, with a `*_truncated` flag: the fields, the Environments that
// override one, the Instructions and a value too long to show (an Agent change's values are cut by `./outputs.ts`).
// @effect-diagnostics missingPipeableSignature:off
import type { AgentChange } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import { GLOBAL_ID, GLOBAL_NAME } from "./environment-secret-marks.ts";
import {
  ApprovalOutcome,
  asOutput,
  boundItems,
  boundText,
  ChangeOutput,
  changesOutput,
  MAX_LIST_BYTES,
  ScopeRef,
} from "./outputs.ts";
import type { SettingsView } from "./settings.ts";
import { storedBytes } from "./stored-bytes.ts";

/** The most a setting's value weighs stored in `settings_get`, which lists them all, before it is not shown. */
export const MAX_VALUE_BYTES = 32 * 1024;

/** The most one Scope's Instructions weigh stored in a value: more than the Settings page lets them be, in practice. */
const MAX_INSTRUCTIONS_OUTPUT_BYTES = 128 * 1024;

/** The most a note about the saved overrides weighs stored in a value. */
const MAX_PROBLEM_BYTES = 16 * 1024;

/** The most the list of the Environments that override one field weighs stored in a value. */
const MAX_OVERRIDDEN_IN_BYTES = 16 * 1024;

/** The owner's answer as `ChangeOutput` carries it. */
export type ApprovalValue = typeof ApprovalOutcome.Type;

/** The owner approved. */
export const APPROVED: ApprovalValue = { approved: true, reason: null };

/** The owner declined, with their reason if they gave one. */
export const declinedOutcome = (reason: string | undefined): ApprovalValue => ({
  approved: false,
  reason: reason ?? null,
});

/** The Scope of a view, by id and name. */
export const scopeRefOf = (view: SettingsView): typeof ScopeRef.Type =>
  "name" in view ? { id: view.scope, name: view.name } : { id: GLOBAL_ID, name: GLOBAL_NAME };

/**
 * What a Settings tool answers: `changes` made at `view`'s Scope, the `unchanged` fields that already had their value, and
 * the owner's `approval` (null for a change that does not wait for it, or that asked nobody).
 */
export const settingsChangeOutput = ({
  view,
  changes,
  unchanged,
  approval,
}: {
  readonly view: SettingsView;
  readonly changes: ReadonlyArray<AgentChange>;
  readonly unchanged: ReadonlyArray<string>;
  readonly approval: ApprovalValue;
}) =>
  asOutput(ChangeOutput, {
    scope: scopeRefOf(view),
    ...changesOutput(changes),
    unchanged,
    approval,
  });

/** Where a setting's value comes from. */
const SettingSource = Schema.Literals(["default", "global", "override", "inherited"]).annotate({
  description:
    'At Global: "default" (nobody sets it) or "global" (set at Global). At an Environment: "override" (set on purpose for it, even when equal to Global\'s) or "inherited" (from Global)',
});

/** One setting at a Scope: its value in force and where it comes from. */
export const SettingOutput = Schema.Struct({
  field: Schema.String.annotate({
    description:
      "The setting's name as settings_reset and the Agent changes name it, such as model, roles.small, compaction.enabled or extensions.subagents.readToolset",
  }),
  value: Schema.NullOr(Schema.Json).annotate({
    description:
      "The value in force at the Scope; null for none (or, with value_truncated, a value too long to show)",
  }),
  source: SettingSource,
  global_value: Schema.NullOr(Schema.Json).annotate({
    description:
      "At an Environment, Global's value, which an override replaces; null at Global, or for none",
  }),
  value_truncated: Schema.Boolean.annotate({
    description: "value or global_value was too long to show, and is null",
  }),
  overridden_in: Schema.Array(ScopeRef).annotate({
    description:
      "At Global, the Environments that override the field, whose Sessions a change at Global does not reach; empty at an Environment",
  }),
  overridden_in_truncated: Schema.Boolean.annotate({
    description: "overridden_in was cut: more Environments override the field",
  }),
});

/** One Scope's Instructions. */
const InstructionsOutput = Schema.Struct({
  text: Schema.String.annotate({ description: "The Instructions as Markdown; empty for none" }),
  bytes: Schema.Finite.annotate({ description: "Their size in bytes of UTF-8, whole" }),
  text_truncated: Schema.Boolean.annotate({ description: "text was cut" }),
});

/** `settings_get`: the Settings at a Scope. */
export const SettingsGetOutput = Schema.Struct({
  scope: ScopeRef,
  own_environment: Schema.NullOr(Schema.String).annotate({
    description:
      "The id of this Session's own Environment, whose Settings its requests run with; null when the Registry does not list it",
  }),
  is_own: Schema.Boolean.annotate({
    description: "This Scope is this Session's own Environment: these are the Settings it uses",
  }),
  settings: Schema.Array(SettingOutput).annotate({
    description:
      "The settings in force at the Scope: the model and thinking level, each role, compaction, the offered tools, the branch summary prompt, the Limits and the extensions' options",
  }),
  settings_truncated: Schema.Boolean.annotate({ description: "settings was cut" }),
  instructions: Schema.Struct({
    global: InstructionsOutput.annotate({
      description: "Global's Instructions, which every Environment's conversations are shown first",
    }),
    environment: Schema.NullOr(InstructionsOutput).annotate({
      description:
        "At an Environment, its own Instructions, which add to Global's and win where they disagree; null at Global",
    }),
  }),
  problem: Schema.NullOr(Schema.String).annotate({
    description:
      "Why some saved overrides were left out, when a later release no longer accepts them; null for none",
  }),
  problem_truncated: Schema.Boolean.annotate({ description: "problem was cut" }),
});

/** An Instructions text as a value gives it. */
export const instructionsOutput = (text: string, bytes: number) => {
  const bounded = boundText(text, MAX_INSTRUCTIONS_OUTPUT_BYTES);

  return { text: bounded.text, bytes, text_truncated: bounded.truncated };
};

/** The Environments that override a field, as many as fit. */
export const overriddenInOutput = (
  by: ReadonlyArray<{ readonly id: string; readonly name: string }>,
) => {
  const bounded = boundItems(
    Arr.map(by, ({ id, name }) => ({ id, name })),
    MAX_OVERRIDDEN_IN_BYTES,
  );

  return { overridden_in: bounded.items, overridden_in_truncated: bounded.truncated };
};

/** A setting's values as a value gives them: each as it is, unless one is too long to show. */
export const settingValues = (value: Schema.Json | null, global: Schema.Json | null) => {
  const tooLong = storedBytes(value) > MAX_VALUE_BYTES || storedBytes(global) > MAX_VALUE_BYTES;

  return tooLong
    ? { value: null, global_value: null, value_truncated: true }
    : { value, global_value: global, value_truncated: false };
};

/** `settings` cut to fit, and the Settings' `problem` cut as a note. */
export const settingsGetOutput = (
  output: Omit<typeof SettingsGetOutput.Type, "settings_truncated" | "problem_truncated"> & {
    readonly settings: ReadonlyArray<typeof SettingOutput.Type>;
  },
) => {
  const settings = boundItems(output.settings, MAX_LIST_BYTES);
  const problem = output.problem === null ? null : boundText(output.problem, MAX_PROBLEM_BYTES);

  return asOutput(SettingsGetOutput, {
    ...output,
    settings: settings.items,
    settings_truncated: settings.truncated,
    problem: problem === null ? null : problem.text,
    problem_truncated: problem?.truncated ?? false,
  });
};

/** What deleting an Environment took, as the owner was asked about it. */
export const FootprintOutput = Schema.Struct({
  workspaces: Schema.Finite.annotate({ description: "Its Workspaces, but its spare" }),
  sessions: Schema.Finite.annotate({ description: "The Sessions in them, archived ones too" }),
  secrets: Schema.Finite.annotate({ description: "The Secrets kept for it alone" }),
});

/** `environment_delete`: whether the Environment was deleted, and what that took. */
export const EnvironmentDeleteOutput = Schema.Struct({
  environment: ScopeRef,
  deleted: Schema.Boolean.annotate({
    description:
      "The Environment is deleted (false: the owner declined, or it was gone already when they approved)",
  }),
  footprint: Schema.NullOr(FootprintOutput).annotate({
    description: "What the delete took, as the owner approved it; null when nothing was deleted",
  }),
  approval: ApprovalOutcome,
});

/** `environment_secret_delete`: whether the kept Secret was deleted. */
export const EnvironmentSecretDeleteOutput = Schema.Struct({
  scope: ScopeRef.annotate({
    description: 'The Environment the Secret is kept for, or Global (id "*")',
  }),
  name: Schema.String.annotate({ description: "The Secret's name" }),
  deleted: Schema.Boolean.annotate({
    description:
      "The Secret is deleted (false: the owner declined, or it was gone already when they approved)",
  }),
  approval: ApprovalOutcome,
});
