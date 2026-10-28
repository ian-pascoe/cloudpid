// The Registry's Settings changes as the tests of the `settings` and `approval-tools` extensions fake them
// (`docs/architecture/agent-changes.md` → Settings changes, ADR-0027): Global's fields with the owner's strict
// resolution, a reset putting a field back to its default, and an Environment's Overrides field by field, kept even when
// equal to Global's; each checked against what the owner saw (`expected`) as the Registry checks it.
// @effect-diagnostics missingPipeableSignature:off preferEffectArray:off
import {
  DEFAULT_SETTINGS,
  type OverrideFieldChange,
  overrideValue,
  overridesFrom,
  overridesWithFields,
  resolveOverrides,
  resolveOverridesLeniently,
  resolveSettings,
  type Settings,
  settingsFieldValue,
  withOverrideFields,
} from "@cloudpid/config";
import type { AgentChange } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { AppliedSettingsChange, SettingsFieldChange } from "./settings.ts";

export const sameJson = Schema.toEquivalence(Schema.NullOr(Schema.Json));

/** Whether two Overrides of a field are the same: both none, or both the same value. */
export const sameOverride = (left: Option.Option<Schema.Json>, right: Option.Option<Schema.Json>) =>
  Option.isNone(left)
    ? Option.isNone(right)
    : Option.isSome(right) && sameJson(left.value, right.value);

/** What a fake change records of a field; the test adds the rest of the Agent change. */
export type RecordedField = {
  readonly scope: string;
  readonly field: string;
  readonly before: Schema.Json | null;
  readonly after: Schema.Json | null;
  readonly beforeInherited?: boolean;
  readonly afterInherited?: boolean;
};

/** A fake change of Global: the answer, and Global's overrides after it. */
export type GlobalChanged = {
  readonly answer: AppliedSettingsChange;
  readonly global: Schema.Json;
};

/** A fake change of an Environment's Overrides: the answer, and its Overrides after it. */
export type OverridesChanged = {
  readonly answer: AppliedSettingsChange;
  readonly overrides: Schema.Json;
};

/** Global's settings from its saved overrides, which a test gives valid. */
export const resolvedGlobal = (global: Schema.Json): Settings => {
  const result = resolveSettings(global);

  if (Result.isFailure(result)) throw new Error(result.failure.message);

  return result.success;
};

/** Global's fields changed as the Registry changes them: the answer, and Global's overrides after it. */
export const changeGlobalSettings = (
  global: Schema.Json,
  changes: ReadonlyArray<SettingsFieldChange>,
  record: (made: RecordedField) => AgentChange,
): GlobalChanged => {
  const before = resolvedGlobal(global);

  const differing = Arr.filter(
    Arr.map(changes, (each) =>
      each.reset === true
        ? { ...each, value: settingsFieldValue(DEFAULT_SETTINGS, each.field) }
        : each,
    ),
    (each) => !sameJson(settingsFieldValue(before, each.field), each.value),
  );

  if (differing.length === 0) return { answer: { status: "unchanged" }, global };

  const moved = differing.find(
    (each) =>
      each.expected !== undefined &&
      !sameJson(settingsFieldValue(before, each.field), each.expected.value),
  );

  if (moved !== undefined) {
    return {
      answer: {
        status: "changed-since",
        field: moved.field,
        current: settingsFieldValue(before, moved.field),
      },
      global,
    };
  }

  const next = resolveSettings(overridesWithFields(before, differing));

  if (Result.isFailure(next)) {
    return { answer: { status: "rejected", message: next.failure.message }, global };
  }

  return {
    answer: {
      status: "changed",
      changes: Arr.map(differing, (each) =>
        record({
          scope: "settings",
          field: each.field,
          before: settingsFieldValue(before, each.field),
          after: settingsFieldValue(next.success, each.field),
        }),
      ),
    },
    global: overridesFrom(next.success),
  };
};

/**
 * Environment `scope`'s Overrides changed as the Registry changes them, over Global's overrides `global`: the answer,
 * and the Overrides after it.
 */
export const changeSettingsOverrides = (
  global: Schema.Json,
  overrides: Schema.Json,
  scope: string,
  changes: ReadonlyArray<SettingsFieldChange>,
  record: (made: RecordedField) => AgentChange,
): OverridesChanged => {
  const known = resolveOverridesLeniently(global, overrides);

  const next = withOverrideFields(
    known.overrides,
    Arr.map(changes, (each): OverrideFieldChange =>
      each.reset === true
        ? { field: each.field, reset: true }
        : { field: each.field, value: each.value },
    ),
    known.settings,
  );

  if (Result.isFailure(next)) {
    return { answer: { status: "rejected", message: next.failure.message }, overrides };
  }

  const differing = Arr.filter(
    changes,
    (each) =>
      !sameOverride(
        overrideValue(known.overrides, each.field),
        overrideValue(next.success, each.field),
      ),
  );

  if (differing.length === 0) return { answer: { status: "unchanged" }, overrides };

  const inherited = (field: string) => Option.isNone(overrideValue(known.overrides, field));

  const moved = differing.find(
    ({ field, expected }) =>
      expected !== undefined &&
      (!sameJson(settingsFieldValue(known.settings, field), expected.value) ||
        (expected.inherited ?? false) !== inherited(field)),
  );

  if (moved !== undefined) {
    return {
      answer: {
        status: "changed-since",
        field: moved.field,
        current: settingsFieldValue(known.settings, moved.field),
        inherited: inherited(moved.field),
      },
      overrides,
    };
  }

  const after = resolveOverrides(global, next.success);

  if (Result.isFailure(after)) {
    return { answer: { status: "rejected", message: after.failure.message }, overrides };
  }

  return {
    answer: {
      status: "changed",
      changes: Arr.map(differing, ({ field }) =>
        record({
          scope,
          field,
          before: settingsFieldValue(known.settings, field),
          after: settingsFieldValue(after.success, field),
          beforeInherited: inherited(field),
          afterInherited: Option.isNone(overrideValue(next.success, field)),
        }),
      ),
    },
    overrides: next.success,
  };
};
