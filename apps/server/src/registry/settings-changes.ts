// The Settings' Agent changes (`docs/architecture/agent-changes.md`, ADR-0019): what the agent changes in the Settings,
// applied as the owner's save is (`writeSettings`: the strict resolution, keeping only what differs from the defaults)
// and recorded, in the same table as an Environment's under the scope `settings`, with when, the Session, the tool,
// the reason and the values before and after, so the owner can see each one and revert it. A change names fields of the
// Settings (`settingsFieldPath`), and one call may change several, which are one write and one record each.
// Synchronous over the Registry DO's storage, as `changeEnvironment` is, so a change and its record are one step.
// A change at an Environment's Scope (ADR-0027) is to its Overrides, field by field (`overrideFieldPath`), and is
// recorded under the Environment's id with whether the field was inherited before and after it.
// @effect-diagnostics missingPipeableSignature:off
import {
  DEFAULT_SETTINGS,
  type OverrideFieldChange,
  overrideFieldPath,
  overrideValue,
  overridesWithFields,
  settingsFieldPath,
  settingsFieldValue,
  withOverrideFields,
} from "@cloudpid/config";
import { type AgentChange, SETTINGS_SCOPE, type SettingsOverridesState } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { AgentChangeAuthor, AgentChanges } from "./agent-changes.ts";
import {
  type DocumentStore,
  putSettingsOverrides,
  readSettings,
  readSettingsOverrides,
  type SettingsState,
  type SettingsStore,
  writeSettings,
} from "./settings.ts";

/** What the Settings' changes need of the Registry's storage. */
export type SettingsStorage = { readonly transactionSync: <A>(body: () => A) => A };

/**
 * One setting given a new value: `field` is a settings field, and a `value` of null takes an option away (Global) or
 * an extension's option's Override away (an Environment). With `reset`, the field goes back to the default (Global)
 * or to inheriting Global (an Environment). With `expected`, the setting is changed only while it has that value
 * (null: not set), and at an Environment only while it is inherited or not as `inherited` says: the one the owner saw
 * when they approved the change.
 */
export type SettingsFieldChange = {
  readonly field: string;
  readonly value: Schema.Json | null;
  readonly reset?: true | undefined;
  readonly expected?:
    | { readonly value: Schema.Json | null; readonly inherited?: boolean | undefined }
    | undefined;
};

/** How an Agent change to the Settings went. */
export type SettingsChange =
  | {
      readonly status: "changed";
      /** One record for each field that changed, in the order given. */
      readonly changes: ReadonlyArray<AgentChange>;
      readonly state: SettingsState | SettingsOverridesState;
      /**
       * What the saved overrides had that no longer applied, when they had: the write keeps what resolves, so these
       * are forgotten, as saving the owner's form forgets them.
       */
      readonly dropped?: string;
    }
  /** Every field already had its value: nothing was saved or recorded. */
  | { readonly status: "unchanged" }
  /** Not values the settings take, said as the owner's save says it: nothing was saved. */
  | { readonly status: "rejected"; readonly message: string }
  /**
   * A field no longer has the value it was approved against: it is `current` (at an Environment, `inherited` or not),
   * and nothing was saved.
   */
  | {
      readonly status: "changed-since";
      readonly field: string;
      readonly current: Schema.Json | null;
      readonly inherited?: boolean;
    }
  /** No Environment has the id. */
  | { readonly status: "missing" };

/** How the owner's revert of a Settings change went. */
export type SettingsChangeRevert =
  | {
      readonly status: "reverted";
      /** The owner's change that wrote the value back. */
      readonly change: AgentChange;
      readonly state: SettingsState | SettingsOverridesState;
    }
  /** The setting has changed since: it is `current` now, and nothing was written. */
  | {
      readonly status: "changed-since";
      readonly field: string;
      readonly current: Schema.Json | null;
    }
  | { readonly status: "refused"; readonly message: string }
  | { readonly status: "missing" };

const sameJson = Schema.toEquivalence(Schema.NullOr(Schema.Json));

/**
 * Apply the agent's `changes` to the Settings as the owner's save does, and record each field that changed as an Agent
 * change by `author`. Fields that already have their value record nothing; one that is not a setting, or a value the
 * settings do not take, refuses the whole call.
 */
export const changeSettings = (
  storage: SettingsStorage,
  documents: DocumentStore,
  changes: AgentChanges,
  {
    changes: given,
    author,
  }: { readonly changes: ReadonlyArray<SettingsFieldChange>; readonly author: AgentChangeAuthor },
  now: number,
): SettingsChange =>
  storage.transactionSync((): SettingsChange => {
    const known = readSettings(documents);

    const unknown = Arr.findFirst(given, (change) => settingsFieldPath(change.field) === undefined);

    // A reset at Global is the field back at its default.
    const wanted = Arr.map(given, (change) =>
      change.reset === true
        ? { ...change, value: settingsFieldValue(DEFAULT_SETTINGS, change.field) }
        : change,
    );

    if (Option.isSome(unknown)) {
      return { status: "rejected", message: `${unknown.value.field}: not a setting` };
    }

    const differing = Arr.filterMap(wanted, (change) => {
      const before = settingsFieldValue(known.settings, change.field);

      return sameJson(before, change.value)
        ? Result.failVoid
        : Result.succeed({ ...change, before });
    });

    if (differing.length === 0) return { status: "unchanged" };

    const moved = Arr.findFirst(
      differing,
      ({ expected, before }) => expected !== undefined && !sameJson(before, expected.value),
    );

    if (Option.isSome(moved)) {
      return { status: "changed-since", field: moved.value.field, current: moved.value.before };
    }

    const saved = writeSettings(
      documents,
      overridesWithFields(
        known.settings,
        Arr.map(differing, ({ field, value }) => ({ field, value })),
      ),
      now,
    );

    if (Result.isFailure(saved)) return { status: "rejected", message: saved.failure.message };

    const recorded = Arr.map(differing, ({ field, before }) =>
      changes.record({
        scope: SETTINGS_SCOPE,
        at: now,
        actor: "agent",
        session: author.session,
        conversation: author.conversation,
        tool: author.tool,
        reason: author.reason,
        field,
        before,
        after: settingsFieldValue(saved.success.settings, field),
        reverts: null,
        approved: author.approved,
      }),
    );

    return known.problem === undefined
      ? { status: "changed", changes: recorded, state: saved.success }
      : { status: "changed", changes: recorded, state: saved.success, dropped: known.problem };
  });

/**
 * The owner's revert of Settings change `id`: its `before` value written back and recorded as the owner's change.
 * Refused, saying what the setting is now, when it no longer has the change's `after` value; and for a revert, which is
 * not undone, and a change reverted already.
 */
export const revertSettingsChange = (
  storage: SettingsStorage,
  documents: DocumentStore,
  changes: AgentChanges,
  { id }: { readonly id: number },
  now: number,
): SettingsChangeRevert =>
  storage.transactionSync((): SettingsChangeRevert => {
    const change = changes.get(SETTINGS_SCOPE, id);

    if (change === null) return { status: "missing" };

    if (change.actor === "owner") {
      return { status: "refused", message: "A revert is not undone: change the setting itself" };
    }

    // Once only: the agent may give the setting the change's value again, which a second revert would undo unrecorded.
    if (change.revertedBy !== null) {
      return {
        status: "refused",
        message: `Change ${change.id} was reverted already, by change ${change.revertedBy}`,
      };
    }

    const known = readSettings(documents);
    const value = settingsFieldValue(known.settings, change.field);

    if (!sameJson(value, change.after)) {
      return { status: "changed-since", field: change.field, current: value };
    }

    const saved = writeSettings(
      documents,
      overridesWithFields(known.settings, [{ field: change.field, value: change.before }]),
      now,
    );

    if (Result.isFailure(saved)) return { status: "refused", message: saved.failure.message };

    const recorded = changes.record({
      scope: SETTINGS_SCOPE,
      at: now,
      actor: "owner",
      session: null,
      conversation: null,
      tool: null,
      reason: `Reverted change ${change.id}${Predicate.isNotNull(change.tool) ? ` (${change.tool})` : ""}`,
      field: change.field,
      before: value,
      after: settingsFieldValue(saved.success.settings, change.field),
      reverts: change.id,
    });

    return { status: "reverted", change: recorded, state: saved.success };
  });

/** The change of an Environment's Override `change` asks for. */
const asOverrideChange = (change: SettingsFieldChange): OverrideFieldChange =>
  change.reset === true
    ? { field: change.field, reset: true }
    : { field: change.field, value: change.value };

const sameOverride = Option.makeEquivalence(Schema.toEquivalence(Schema.Json));

/**
 * Apply the agent's `changes` to Environment `environment`'s Overrides, as the owner's `updateSettingsOverrides` does,
 * and record each field whose Override changed as an Agent change by `author` under the Environment's id: an Override
 * set, even to the Global value, or one reset. `before` and `after` are the field's values in force, with whether it was
 * inherited then. A field whose Override already is the value, or that inherits already for a reset, records nothing;
 * one that is not a field an Environment overrides, or a value the settings do not take, refuses the whole call.
 */
export const changeSettingsOverrides = (
  storage: SettingsStorage,
  store: SettingsStore,
  changes: AgentChanges,
  {
    environment,
    changes: wanted,
    author,
  }: {
    readonly environment: string;
    readonly changes: ReadonlyArray<SettingsFieldChange>;
    readonly author: AgentChangeAuthor;
  },
  now: number,
): SettingsChange =>
  storage.transactionSync((): SettingsChange => {
    const known = readSettingsOverrides(store, environment);

    if (known === null) return { status: "missing" };

    const next = withOverrideFields(
      known.overrides,
      Arr.map(wanted, asOverrideChange),
      known.settings,
    );

    if (Result.isFailure(next)) return { status: "rejected", message: next.failure.message };

    const differing = Arr.filterMap(wanted, (change) => {
      const before = overrideValue(known.overrides, change.field);

      return sameOverride(before, overrideValue(next.success, change.field))
        ? Result.failVoid
        : Result.succeed({
            ...change,
            before: settingsFieldValue(known.settings, change.field),
            beforeInherited: Option.isNone(before),
          });
    });

    if (differing.length === 0) return { status: "unchanged" };

    const moved = Arr.findFirst(
      differing,
      ({ expected, before, beforeInherited }) =>
        expected !== undefined &&
        (!sameJson(before, expected.value) || (expected.inherited ?? false) !== beforeInherited),
    );

    if (Option.isSome(moved)) {
      return {
        status: "changed-since",
        field: moved.value.field,
        current: moved.value.before,
        inherited: moved.value.beforeInherited,
      };
    }

    const saved = putSettingsOverrides(store, environment, next.success);

    if (saved === null) return { status: "missing" };

    if (Result.isFailure(saved)) return { status: "rejected", message: saved.failure.message };

    const recorded = Arr.map(differing, ({ field, before, beforeInherited }) =>
      changes.record({
        scope: environment,
        at: now,
        actor: "agent",
        session: author.session,
        conversation: author.conversation,
        tool: author.tool,
        reason: author.reason,
        field,
        before,
        after: settingsFieldValue(saved.success.settings, field),
        reverts: null,
        approved: author.approved,
        beforeInherited,
        afterInherited: Option.isNone(overrideValue(saved.success.overrides, field)),
      }),
    );

    return known.problem === undefined
      ? { status: "changed", changes: recorded, state: saved.success }
      : { status: "changed", changes: recorded, state: saved.success, dropped: known.problem };
  });

/** Whether Agent change field `field` is one of an Environment's Settings Overrides, not one of its Container settings. */
export const isOverrideField = (field: string): boolean => overrideFieldPath(field) !== undefined;

/**
 * The owner's revert of `change`, an Agent change of Environment `environment`'s Overrides, inside the caller's
 * transaction: the field set back to its `before` value, or reset when it was inherited before, and recorded as the
 * owner's change. Refused, saying what the field is now, when it no longer is as the change left it (its value, and
 * whether it is inherited).
 */
export const revertSettingsOverrideChange = (
  store: SettingsStore,
  changes: AgentChanges,
  environment: string,
  change: AgentChange,
  now: number,
): SettingsChangeRevert => {
  const known = readSettingsOverrides(store, environment);

  if (known === null) return { status: "missing" };

  const value = settingsFieldValue(known.settings, change.field);
  const inherited = Option.isNone(overrideValue(known.overrides, change.field));

  if (
    inherited !== (change.afterInherited ?? false) ||
    (!inherited && !sameJson(value, change.after))
  ) {
    return { status: "changed-since", field: change.field, current: value };
  }

  const next = withOverrideFields(
    known.overrides,
    [
      change.beforeInherited === true ||
      (change.before === null && change.field.startsWith("extensions."))
        ? { field: change.field, reset: true }
        : { field: change.field, value: change.before },
    ],
    known.settings,
  );

  const saved = Result.isFailure(next)
    ? next
    : putSettingsOverrides(store, environment, next.success);

  if (saved === null) return { status: "missing" };

  if (Result.isFailure(saved)) return { status: "refused", message: saved.failure.message };

  const recorded = changes.record({
    scope: environment,
    at: now,
    actor: "owner",
    session: null,
    conversation: null,
    tool: null,
    reason: `Reverted change ${change.id}${Predicate.isNotNull(change.tool) ? ` (${change.tool})` : ""}`,
    field: change.field,
    before: value,
    after: settingsFieldValue(saved.success.settings, change.field),
    reverts: change.id,
    beforeInherited: inherited,
    afterInherited: Option.isNone(overrideValue(saved.success.overrides, change.field)),
  });

  return { status: "reverted", change: recorded, state: saved.success };
};
