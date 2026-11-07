// What the `settings` and `approval-tools` extensions give programs (`docs/architecture/agent-capabilities.md` → Values for
// programs): each tool's `structuredOutput`, declared as its `structuredOutputSchema` (`./outputs.ts`). The Settings'
// changing tools (and `settings_reset`) answer with `ChangeOutput`, the Scope, the Agent changes made, the fields that
// already had their value and the owner's Approval; `settings_get` answers with the Settings at a Scope, field by field,
// each with where its value comes from. What can grow is cut as `./outputs.ts` says, with a `*_truncated` flag: the fields, the Environments that
// override one, the Instructions and a value too long to show (an Agent change's values are cut by `./outputs.ts`).
// @effect-diagnostics missingPipeableSignature:off
import type { AgentChange } from "@cloudpid/protocol";
import {
  GLOBAL_ID,
  GLOBAL_NAME,
  SettingOutput,
  SettingsGetOutput,
} from "@cloudpid/protocol/harness-tools";
import type * as Schema from "effect/Schema";
import {
  ApprovalOutcome,
  asOutput,
  boundItems,
  boundText,
  ChangeOutput,
  changesOutput,
  MAX_PART_BYTES,
  overriddenInOutput,
  scopeRef,
} from "./outputs.ts";
import type { SettingsView } from "./settings-describe.ts";
import { storedBytes } from "./stored-bytes.ts";

/** The most a setting's value weighs stored in `settings_get`, which lists them all, before it is not shown. */
export const MAX_VALUE_BYTES = 32 * 1024;

/** The most one Scope's Instructions weigh stored in a value: more than the Settings page lets them be, in practice. */
const MAX_INSTRUCTIONS_OUTPUT_BYTES = 128 * 1024;

/** The most a note about the saved overrides weighs stored in a value. */
const MAX_PROBLEM_BYTES = 16 * 1024;

/** The most the list of the Environments that override one field weighs stored in a value. */
const MAX_OVERRIDDEN_IN_BYTES = 16 * 1024;

/** What each growable part of `settings_get`'s value weighs at most, stored. */
export type SettingsBounds = {
  /** A setting's value, which is not shown (null, `value_truncated`) when longer. */
  readonly value: number;
  /** One Scope's Instructions. */
  readonly instructions: number;
  /** The Environments that override one field. */
  readonly overriddenIn: number;
  /** The settings, together. */
  readonly settings: number;
  /** The note on the saved overrides. */
  readonly problem: number;
};

/** The in-session bounds. */
export const SESSION_SETTINGS_BOUNDS: SettingsBounds = {
  value: MAX_VALUE_BYTES,
  instructions: MAX_INSTRUCTIONS_OUTPUT_BYTES,
  overriddenIn: MAX_OVERRIDDEN_IN_BYTES,
  settings: MAX_PART_BYTES,
  problem: MAX_PROBLEM_BYTES,
};

/**
 * The endpoint's bounds, which keep the value near 47 KiB in its worst case: the settings 24 KiB together (a value over 3
 * KiB, and an overriding list over 0.5 KiB, is cut), the two Instructions 2 x 10, the note 2 and the small rest.
 * `field: "instructions"` reads an Instructions text whole.
 */
export const ENDPOINT_SETTINGS_BOUNDS: SettingsBounds = {
  value: 3 * 1024,
  instructions: 10 * 1024,
  overriddenIn: 512,
  settings: 24 * 1024,
  problem: 2 * 1024,
};

/** The Scope of a view, by id and name. */
export const scopeRefOf = (view: SettingsView) =>
  scopeRef(
    "name" in view ? { id: view.scope, name: view.name } : { id: GLOBAL_ID, name: GLOBAL_NAME },
  );

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
  readonly approval: typeof ApprovalOutcome.Type;
}) =>
  asOutput(ChangeOutput, {
    scope: scopeRefOf(view),
    ...changesOutput(changes),
    unchanged,
    approval,
  });

/** An Instructions text as a value gives it. */
export const instructionsOutput = (
  text: string,
  bytes: number,
  maxBytes: number = MAX_INSTRUCTIONS_OUTPUT_BYTES,
) => {
  const bounded = boundText(text, maxBytes);

  return { text: bounded.text, bytes, text_truncated: bounded.truncated };
};

/** The Environments that override a field, as many as fit. */
export const settingOverriddenIn = (
  by: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  maxBytes: number = MAX_OVERRIDDEN_IN_BYTES,
) => overriddenInOutput(by, maxBytes);

/** A setting's values as a value gives them: each as it is, unless one is too long to show. */
export const settingValues = (
  value: Schema.Json | null,
  global: Schema.Json | null,
  maxBytes: number = MAX_VALUE_BYTES,
) => {
  const tooLong = storedBytes(value) > maxBytes || storedBytes(global) > maxBytes;

  return tooLong
    ? { value: null, global_value: null, value_truncated: true }
    : { value, global_value: global, value_truncated: false };
};

/** `settings` cut to fit, and the Settings' `problem` cut as a note. */
export const settingsGetOutput = (
  output: Omit<typeof SettingsGetOutput.Type, "settings_truncated" | "problem_truncated"> & {
    readonly settings: ReadonlyArray<typeof SettingOutput.Type>;
  },
  bounds: SettingsBounds = SESSION_SETTINGS_BOUNDS,
): typeof SettingsGetOutput.Type => {
  const settings = boundItems(output.settings, bounds.settings);
  const problem = output.problem === null ? null : boundText(output.problem, bounds.problem);

  return {
    ...output,
    settings: settings.items,
    settings_truncated: settings.truncated,
    problem: problem === null ? null : problem.text,
    problem_truncated: problem?.truncated ?? false,
  };
};
