// The Settings' Agent changes (`docs/spec.md` → Agent changes, ADR-0019): what the agent changes in the Settings,
// applied as the owner's save is (`writeSettings`: the strict resolution, keeping only what differs from the defaults)
// and recorded, in the same table as an Environment's under the scope `settings`, with when, the Session, the tool,
// the reason and the values before and after, so the owner can see each one and revert it. A change names fields of the
// Settings (`settingsFieldPath`), and one call may change several, which are one write and one record each.
// Synchronous over the Registry DO's storage, as `changeEnvironment` is, so a change and its record are one step.
// @effect-diagnostics missingPipeableSignature:off
import { overridesWithFields, settingsFieldPath, settingsFieldValue } from "@cloudpid/config";
import { type AgentChange, SETTINGS_SCOPE } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { type AgentChangeAuthor, type AgentChanges, approvedMark } from "./agent-changes.ts";
import { type DocumentStore, readSettings, type SettingsState, writeSettings } from "./settings.ts";

/** What the Settings' changes need of the Registry's storage. */
export type SettingsStorage = { readonly transactionSync: <A>(body: () => A) => A };

/**
 * One setting given a new value: `field` is a settings field, and a `value` of null takes an option away. With
 * `expected`, the setting is changed only while it has that value (null: not set): the one the owner saw when they
 * approved the change.
 */
export type SettingsFieldChange = {
  readonly field: string;
  readonly value: Schema.Json | null;
  readonly expected?: { readonly value: Schema.Json | null } | undefined;
};

/** How an Agent change to the Settings went. */
export type SettingsChange =
  | {
      readonly status: "changed";
      /** One record for each field that changed, in the order given. */
      readonly changes: ReadonlyArray<AgentChange>;
      readonly state: SettingsState;
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
  /** A field no longer has the value it was approved against: it is `current`, and nothing was saved. */
  | {
      readonly status: "changed-since";
      readonly field: string;
      readonly current: Schema.Json | null;
    };

/** How the owner's revert of a Settings change went. */
export type SettingsChangeRevert =
  | {
      readonly status: "reverted";
      /** The owner's change that wrote the value back. */
      readonly change: AgentChange;
      readonly state: SettingsState;
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
    changes: wanted,
    author,
  }: { readonly changes: ReadonlyArray<SettingsFieldChange>; readonly author: AgentChangeAuthor },
  now: number,
): SettingsChange =>
  storage.transactionSync((): SettingsChange => {
    const known = readSettings(documents);

    const unknown = Arr.findFirst(
      wanted,
      (change) => settingsFieldPath(change.field) === undefined,
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
        ...approvedMark(author),
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
