// Agent changes (`docs/architecture/agent-changes.md`, ADR-0019): what the agent changes in an Environment, applied as the
// owner's save is and recorded with when, the Session, the tool, the reason and the values before and after, so the
// owner can see each one and revert it. Synchronous over the Registry DO's SQLite, as the store is, so a change and its
// record are one step no other request lands in the middle of. The table is migration 17's (`store.ts`), and deleting
// an Environment deletes its changes.
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- plain functions over SQLite, and a digest.
import {
  CONTAINER_SETTING_NAMES,
  type ContainerPatch,
  type ContainerSettings,
  type ContainerSettingsOverrides,
  currentFieldValue,
  DEFAULT_CONTAINER_SETTINGS,
  isContainerField,
  resolveEnvironmentContainerSettings,
} from "@cloudpid/config";
import {
  type AgentChange,
  CREATED_FIELD,
  fieldSecret,
  fieldSkill,
  fieldVariable,
  MAX_AGENT_CHANGES,
  unrevertableField,
} from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Types from "effect/Types";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { type EnvironmentSettingsState, patchEnvironmentSettings } from "./environment-settings.ts";
import type { EnvironmentRepo } from "@cloudpid/protocol";
import { buildKey, buildWanted } from "../workspace/build-record.ts";
import { isLifecycleField, revertLifecycleChange } from "./environment-lifecycle.ts";
import { environmentSettingsOf, globalSettingsOf, patchGlobal } from "./global.ts";
import { revertSecretBuild } from "./secret-changes.ts";
import { dropUnreferencedSkillFiles, revertSkillChange, type Skills } from "./skills.ts";
import {
  type EnvironmentRecord,
  GLOBAL_SCOPE,
  type RegistryStorage,
  type RegistryStore,
} from "./store.ts";

/** Who made an Agent change: the Session, the conversation in it that called the tool, the tool, and why. */
export type AgentChangeAuthor = {
  readonly session: string;
  readonly conversation: number;
  readonly tool: string;
  readonly reason: string;
  /** Set when the owner approved the change before it was made (GLOSSARY.md → Approval). */
  readonly approved?: true | undefined;
};

/**
 * One Container setting of an Environment or at Global, given a new value: `field` is a setting's name (`idleMinutes`)
 * or `variables.<NAME>` for one variable. A `value` of null resets it: an Environment's field then inherits Global's
 * (its variable is unset), and Global's takes the default.
 */
export type ContainerFieldChange = {
  readonly field: string;
  readonly value: Schema.Json | null;
};

/** How an Agent change to an Environment went. */
export type EnvironmentChange =
  | {
      readonly status: "changed";
      readonly environment: EnvironmentRecord;
      readonly change: AgentChange;
      /** The settings before it, and in force now. */
      readonly previous: ContainerSettings;
      readonly state: EnvironmentSettingsState;
    }
  /**
   * The field already had the value as its Override, or a reset found it inherited already (a variable unset that
   * was not set): nothing was saved or recorded. `value` is what it is in force.
   */
  | {
      readonly status: "unchanged";
      readonly environment: EnvironmentRecord;
      readonly value: Schema.Json | null;
    }
  /** The value is not one the setting takes, said as the owner's save says it: nothing was saved. */
  | { readonly status: "rejected"; readonly message: string }
  /** The field no longer has the value the change was approved against (`expected`): it is `current`, and nothing was saved. */
  | { readonly status: "changed-since"; readonly current: Schema.Json | null }
  | { readonly status: "missing" };

/** How an Agent change to a Container setting at Global went. */
export type GlobalChange =
  | {
      readonly status: "changed";
      readonly change: AgentChange;
      /** The Container settings at Global before it, and in force now. */
      readonly previous: ContainerSettings;
      readonly settings: ContainerSettings;
    }
  /** The field already had the value (a variable unset that was not set): nothing was saved or recorded. */
  | { readonly status: "unchanged"; readonly value: Schema.Json | null }
  /**
   * The value is not one the setting takes, or an Environment that inherits it would be left above its size limit or
   * with too many variables: nothing was saved.
   */
  | { readonly status: "rejected"; readonly message: string }
  /** The field no longer has the value the change was approved against (`expected`): it is `current`, and nothing was saved. */
  | { readonly status: "changed-since"; readonly current: Schema.Json | null };

/** How the owner's revert of an Agent change went. */
export type AgentChangeRevert =
  | {
      readonly status: "reverted";
      /** The owner's change that wrote the value back. */
      readonly change: AgentChange;
      /** The Container settings in force after it; none for a change to the Environment's name or Repos. */
      readonly state?: EnvironmentSettingsState;
    }
  /** The field has changed since: it is `current` now, and nothing was written. */
  | {
      readonly status: "changed-since";
      readonly field: string;
      readonly current: Schema.Json | null;
    }
  | { readonly status: "refused"; readonly message: string }
  | { readonly status: "missing" };

/** Why `change`, of one of the fields with no revert, is not reverted. */
const unrevertableMessage = ({ field, after }: AgentChange): string => {
  if (field === CREATED_FIELD) {
    return "Making an environment is not reverted: deleting one needs your approval, so delete it from its card's menu";
  }

  if (fieldSecret(field) === null) return "A Build asked for is not reverted";

  return after === null
    ? "A deleted secret is not brought back: the history holds no value, so keep it again in the Secrets section"
    : "Keeping a secret is not reverted: the history holds no value to bring back, so delete the secret itself in the Secrets section";
};

const SETTING_NAMES: ReadonlySet<string> = new Set<string>(CONTAINER_SETTING_NAMES);

const isSetting = (field: string): field is keyof ContainerSettings => SETTING_NAMES.has(field);

/** The value `field` has in `settings`: null for a variable that is not set. */
export const fieldValue = (settings: ContainerSettings, field: string): Schema.Json | null => {
  const variable = fieldVariable(field);

  if (variable !== null) return settings.variables[variable] ?? null;

  return isSetting(field) ? settings[field] : null;
};

/** The value `field` takes by default: null for a variable. */
const defaultValue = (field: string): Schema.Json | null =>
  fieldValue(DEFAULT_CONTAINER_SETTINGS, field);

/** An Environment's Override of `field`, or undefined when it has none and the field is inherited from Global. */
const overrideOf = (
  overrides: ContainerSettingsOverrides,
  field: string,
): Schema.Json | undefined => {
  const variable = fieldVariable(field);

  if (variable !== null) return overrides.variables?.[variable];

  return isSetting(field) ? overrides[field] : undefined;
};

/** What `field` is in an Environment's settings: its value in force, and whether it is inherited from Global. */
const fieldState = (state: EnvironmentSettingsState, field: string) => ({
  value: fieldValue(state.settings, field),
  inherited: overrideOf(state.overrides, field) === undefined,
});

/** The patch that gives `field` the value `value`, or resets it for null. */
const patchOf = ({ field, value }: ContainerFieldChange): ContainerPatch => {
  if (value === null) return { reset: [field] };

  const variable = fieldVariable(field);

  return { set: variable === null ? { [field]: value } : { variables: { [variable]: value } } };
};

/**
 * The Override a recorded value stands for: none for one marked inherited, and none for a variable recorded as not
 * set (null), as every change from before Global held Container settings recorded one.
 */
const recordedOverride = (
  value: Schema.Json | null,
  inherited: boolean | undefined,
): Schema.Json | undefined => (inherited === true || value === null ? undefined : value);

const sameJson = Schema.toEquivalence(Schema.NullOr(Schema.Json));

/** Whether two Overrides (undefined: none) are the same. */
const sameOverride = (left: Schema.Json | undefined, right: Schema.Json | undefined): boolean =>
  left === undefined || right === undefined ? left === right : sameJson(left, right);

type AgentChangeRow = {
  id: number;
  scope: string;
  at: number;
  actor: string;
  session: string | null;
  conversation: number | null;
  tool: string | null;
  reason: string;
  field: string;
  before: string | null;
  after: string | null;
  reverts: number | null;
  reverted_by: number | null;
  approved: number;
  dismissed: number;
  before_inherited: number | null;
  after_inherited: number | null;
};

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** A stored value: JSON text, or null for none. Text that is not JSON (never written so) reads as none. */
const valueOf = (text: string | null): Schema.Json | null =>
  text === null ? null : Option.getOrNull(decodeJson(text));

/**
 * The stored value of `field`: as `valueOf` reads it, with a size since renamed (`custom-2`) under its name now, so a
 * change from before the rename shows, and is reverted, as the size it named.
 */
const storedFieldValue = (field: string, text: string | null): Schema.Json | null =>
  currentFieldValue(field, valueOf(text));

const toChange = (row: AgentChangeRow): AgentChange => {
  const change: AgentChange = {
    id: row.id,
    scope: row.scope,
    at: row.at,
    actor: row.actor === "owner" ? "owner" : "agent",
    session: row.session,
    conversation: row.conversation,
    tool: row.tool,
    reason: row.reason,
    field: row.field,
    before: storedFieldValue(row.field, row.before),
    after: storedFieldValue(row.field, row.after),
    reverts: row.reverts,
    revertedBy: row.reverted_by,
  };

  return withMarks(change, {
    // Only a change the owner approved says so (`docs/architecture/agent-changes.md` → Approval).
    approved: row.approved === 1,
    beforeInherited: row.before_inherited === 1,
    afterInherited: row.after_inherited === 1,
  });
};

/** The marks a change may carry, each left out of it unless set. */
type Marks = {
  readonly approved?: boolean | undefined;
  readonly beforeInherited?: boolean | undefined;
  readonly afterInherited?: boolean | undefined;
};

/** `change` with each of `marks` that is set, and none of the others. */
const withMarks = (change: AgentChange, marks: Marks): AgentChange => {
  const marked: Types.Mutable<AgentChange> = { ...change };

  if (marks.approved === true) marked.approved = true;

  if (marks.beforeInherited === true) marked.beforeInherited = true;

  if (marks.afterInherited === true) marked.afterInherited = true;

  return marked;
};

/**
 * What a change records: everything but its number, which the table gives it, and its marks: whether the owner approved
 * it first, and whether its value before or after was inherited from Global (absent or false: not).
 */
type NewAgentChange = Omit<
  AgentChange,
  "id" | "revertedBy" | "approved" | "beforeInherited" | "afterInherited"
> &
  Marks;

/** `change` as it is recorded under `id`, with no revert yet, and only the marks that are set. */
export const asRecorded = (change: NewAgentChange, id: number): AgentChange => {
  const { approved, beforeInherited, afterInherited, ...made } = change;

  return withMarks(
    { ...made, id, revertedBy: null },
    { approved, beforeInherited, afterInherited },
  );
};

/** The Agent changes the Registry keeps, by scope (an Environment's id). */
export type AgentChanges = {
  /** Record `change`, keeping only the newest `MAX_AGENT_CHANGES` of its scope; answers it as recorded. */
  readonly record: (change: NewAgentChange) => AgentChange;
  /** The changes of `scope` the owner has not dismissed, newest first. */
  readonly list: (scope: string) => ReadonlyArray<AgentChange>;
  /** Change `id` of `scope`, dismissed or not, or null. */
  readonly get: (scope: string, id: number) => AgentChange | null;
  /**
   * Take change `id` of `scope` out of the list, leaving what it changed and its record: false when `scope` has no such
   * change. Dismissing one dismissed already changes nothing.
   */
  readonly dismiss: (scope: string, id: number) => boolean;
};

const SELECT_CHANGES = `SELECT changes.*, revert.id AS reverted_by FROM agent_changes AS changes
  LEFT JOIN agent_changes AS revert ON revert.reverts = changes.id`;

/** The Agent changes over the Registry's storage, once it is migrated (`openRegistryStore`). */
export const openAgentChanges = ({ sql }: Pick<RegistryStorage, "sql">): AgentChanges => {
  const get = (scope: string, id: number): AgentChange | null => {
    const [row] = sql
      .exec<AgentChangeRow>(
        `${SELECT_CHANGES} WHERE changes.scope = ? AND changes.id = ?`,
        scope,
        id,
      )
      .toArray();

    return row === undefined ? null : toChange(row);
  };

  return {
    record: (change) => {
      const [row] = sql
        .exec<{ id: number }>(
          `INSERT INTO agent_changes (scope, at, actor, session, conversation, tool, reason, field, before, after, reverts, approved, before_inherited, after_inherited)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
          change.scope,
          change.at,
          change.actor,
          change.session,
          change.conversation,
          change.tool,
          change.reason,
          change.field,
          change.before === null ? null : JSON.stringify(change.before),
          change.after === null ? null : JSON.stringify(change.after),
          change.reverts,
          change.approved === true ? 1 : 0,
          change.beforeInherited === true ? 1 : null,
          change.afterInherited === true ? 1 : null,
        )
        .toArray();

      const pruned = sql.exec(
        `DELETE FROM agent_changes WHERE scope = ? AND id NOT IN (
           SELECT id FROM agent_changes WHERE scope = ? ORDER BY id DESC LIMIT ?
         )`,
        change.scope,
        change.scope,
        MAX_AGENT_CHANGES,
      );

      // A Skill's files are kept for the changes that refer to them: those only the pruned ones did go with them.
      if (pruned.rowsWritten > 0) dropUnreferencedSkillFiles(sql);

      // SQLite answers the row it inserted; one that does not is a broken store, not a change to report.
      if (row === undefined) throw new Error("Recording an Agent change returned no id");

      return asRecorded(change, row.id);
    },
    list: (scope) =>
      Arr.map(
        sql
          .exec<AgentChangeRow>(
            `${SELECT_CHANGES} WHERE changes.scope = ? AND changes.dismissed = 0 ORDER BY changes.id DESC`,
            scope,
          )
          .toArray(),
        toChange,
      ),
    get,
    dismiss: (scope, id) => {
      const [row] = sql
        .exec<{ id: number }>(
          "UPDATE agent_changes SET dismissed = 1 WHERE scope = ? AND id = ? RETURNING id",
          scope,
          id,
        )
        .toArray();

      return row !== undefined;
    },
  };
};

/**
 * Whether a change from `previous` to `settings` makes the Environment want a Build of another key (`buildKey`), so
 * the Build upkeep after it asks for one: the image and the Secrets are what they were, so the settings decide.
 */
export const wantsNewBuild = async (
  repos: ReadonlyArray<EnvironmentRepo>,
  previous: ContainerSettings,
  settings: ContainerSettings,
): Promise<boolean> => {
  const key = (of: ContainerSettings) =>
    buildWanted(repos, of) ? buildKey({ repos, settings: of, image: undefined }) : null;

  const wanted = await key(settings);

  return wanted !== null && wanted !== (await key(previous));
};

/** An Environment as an Agent change to a Container setting at Global sees it: its Repos and its Overrides. */
export type ReachedEnvironment = {
  readonly id: string;
  readonly name: string;
  readonly repos: ReadonlyArray<EnvironmentRepo>;
  readonly overrides: ContainerSettingsOverrides;
};

/** Where an Agent change to a Container setting at Global goes. */
export type GlobalChangeReach = {
  /** The Environments that override the field (a variable: their own of the name wins), so the change does not reach them. */
  readonly overriddenIn: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** The Environments it reaches that want a Build of another key (`wantsNewBuild`). */
  readonly newBuilds: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** Whether it reaches the Environment `caller` names; undefined when none is named. */
  readonly own: boolean | undefined;
};

/**
 * Where a change of `field` at Global, from the Container settings `previous` to `settings`, goes: an Environment that
 * overrides the field is not reached, and one that is reached wants a new Build when its Build key changes with its
 * Overrides over the new settings.
 */
export const globalChangeReach = async (
  environments: ReadonlyArray<ReachedEnvironment>,
  field: string,
  previous: ContainerSettings,
  settings: ContainerSettings,
  caller: string | undefined,
): Promise<GlobalChangeReach> => {
  const overrides = ({ overrides: own }: ReachedEnvironment) =>
    overrideOf(own, field) !== undefined;

  const overriding = Arr.filter(environments, overrides);
  const reached = Arr.filter(environments, (environment) => !overrides(environment));

  const wantsBuild = await Promise.all(
    Arr.map(reached, ({ repos, overrides: own }) =>
      wantsNewBuild(
        repos,
        resolveEnvironmentContainerSettings(previous, own),
        resolveEnvironmentContainerSettings(settings, own),
      ),
    ),
  );

  const listed = ({ id, name: listedName }: ReachedEnvironment) => ({ id, name: listedName });

  return {
    overriddenIn: Arr.map(overriding, listed),
    newBuilds: Arr.map(
      Arr.filter(reached, (_, index) => wantsBuild[index] === true),
      listed,
    ),
    own: caller === undefined ? undefined : !Arr.some(overriding, ({ id }) => id === caller),
  };
};

/** The Container settings state of `environment`, and its record; null when it is not registered. */
const current = (store: RegistryStore, environment: string) => {
  const record = store.getEnvironment(environment);
  const state = environmentSettingsOf(store, environment);

  return record === null || state === null ? null : { record, state };
};

/** Save `patch` of `environment`'s Overrides as the owner's save does, or say why not. */
const patchEnvironment = (
  store: RegistryStore,
  environment: string,
  state: EnvironmentSettingsState,
  patch: ContainerPatch,
): Result.Result<EnvironmentSettingsState, string> => {
  const saved = patchEnvironmentSettings(state.overrides, patch, state.global);

  if (Result.isSuccess(saved)) store.putEnvironmentSettings(environment, saved.success.overrides);

  return saved;
};

/**
 * Apply the agent's `change` to `environment`'s Container Overrides as the owner's save does (`patchEnvironmentSettings`:
 * the same rules, one problem per line), and record it as an Agent change by `author`, with the field's value in force
 * before and after and whether each was inherited from Global. A value the field has as its Override already, or a
 * reset of a field that is inherited, records nothing; a value equal to the inherited one makes it an Override. With
 * `expected`, the change is made only while the field has that value in force: the one the owner saw when they
 * approved it.
 */
export const changeEnvironment = (
  storage: RegistryStorage,
  store: RegistryStore,
  changes: AgentChanges,
  {
    environment,
    change,
    expected,
    author,
  }: {
    readonly environment: string;
    readonly change: ContainerFieldChange;
    readonly expected?: { readonly value: Schema.Json | null } | undefined;
    readonly author: AgentChangeAuthor;
  },
  now: number,
): EnvironmentChange =>
  storage.transactionSync((): EnvironmentChange => {
    const known = current(store, environment);

    if (known === null) return { status: "missing" };

    if (!isContainerField(change.field)) {
      return { status: "rejected", message: `${change.field}: not a Container setting` };
    }

    const before = fieldState(known.state, change.field);
    const override = overrideOf(known.state.overrides, change.field);
    // An Approval asked for before the sizes were renamed may name an old one (`currentFieldValue`).
    const value = currentFieldValue(change.field, change.value);

    if (value === null ? override === undefined : sameOverride(override, value)) {
      return { status: "unchanged", environment: known.record, value: before.value };
    }

    if (
      expected !== undefined &&
      !sameJson(before.value, currentFieldValue(change.field, expected.value))
    ) {
      return { status: "changed-since", current: before.value };
    }

    const saved = patchEnvironment(
      store,
      environment,
      known.state,
      patchOf({ field: change.field, value }),
    );

    if (Result.isFailure(saved)) return { status: "rejected", message: saved.failure };

    const after = fieldState(saved.success, change.field);

    const recorded = changes.record({
      scope: environment,
      at: now,
      actor: "agent",
      session: author.session,
      conversation: author.conversation,
      tool: author.tool,
      reason: author.reason,
      field: change.field,
      before: before.value,
      after: after.value,
      reverts: null,
      approved: author.approved,
      beforeInherited: before.inherited,
      afterInherited: after.inherited,
    });

    return {
      status: "changed",
      environment: known.record,
      change: recorded,
      previous: known.state.settings,
      state: saved.success,
    };
  });

/**
 * Apply the agent's `change` of one Container setting at Global as the owner's save does (`patchGlobal`: the same
 * rules, and no Environment that inherits it may be left above its size limit or with too many variables), and record
 * it as an Agent change by `author` under the scope `*`. A field that already has the value records nothing. With
 * `expected`, the change is made only while the field has that value: the one the owner saw when they approved it.
 */
export const changeGlobal = (
  storage: RegistryStorage,
  store: RegistryStore,
  changes: AgentChanges,
  {
    change,
    expected,
    author,
  }: {
    readonly change: ContainerFieldChange;
    readonly expected?: { readonly value: Schema.Json | null } | undefined;
    readonly author: AgentChangeAuthor;
  },
  now: number,
): GlobalChange =>
  storage.transactionSync((): GlobalChange => {
    if (!isContainerField(change.field)) {
      return { status: "rejected", message: `${change.field}: not a Container setting` };
    }

    const previous = globalSettingsOf(store);
    const before = fieldValue(previous, change.field);
    const value = currentFieldValue(change.field, change.value);

    if (sameJson(before, value ?? defaultValue(change.field))) {
      return { status: "unchanged", value: before };
    }

    if (
      expected !== undefined &&
      !sameJson(before, currentFieldValue(change.field, expected.value))
    ) {
      return { status: "changed-since", current: before };
    }

    const saved = patchGlobal(store, patchOf({ field: change.field, value }), now);

    if (Result.isFailure(saved)) return { status: "rejected", message: saved.failure };

    const recorded = changes.record({
      scope: GLOBAL_SCOPE,
      at: now,
      actor: "agent",
      session: author.session,
      conversation: author.conversation,
      tool: author.tool,
      reason: author.reason,
      field: change.field,
      before,
      after: fieldValue(saved.success.settings, change.field),
      reverts: null,
      approved: author.approved,
    });

    return { status: "changed", change: recorded, previous, settings: saved.success.settings };
  });

/** What an owner's revert of `change` says it undid. */
const revertReason = (change: AgentChange): string =>
  `Reverted change ${change.id}${Predicate.isNotNull(change.tool) ? ` (${change.tool})` : ""}`;

/**
 * The owner's revert of Agent change `change` of a Container setting at Global: its `before` value written back, if
 * the field still has the change's `after` value.
 */
const revertGlobalField = (
  store: RegistryStore,
  changes: AgentChanges,
  change: AgentChange,
  now: number,
): AgentChangeRevert => {
  const value = fieldValue(globalSettingsOf(store), change.field);

  if (!sameJson(value, change.after)) {
    return { status: "changed-since", field: change.field, current: value };
  }

  const saved = patchGlobal(store, patchOf({ field: change.field, value: change.before }), now);

  if (Result.isFailure(saved)) return { status: "refused", message: saved.failure };

  const recorded = changes.record({
    scope: GLOBAL_SCOPE,
    at: now,
    actor: "owner",
    session: null,
    conversation: null,
    tool: null,
    reason: revertReason(change),
    field: change.field,
    before: value,
    after: fieldValue(saved.success.settings, change.field),
    reverts: change.id,
  });

  return { status: "reverted", change: recorded };
};

/**
 * The owner's revert of Agent change `id` of `environment`: its `before` value written back and recorded as the owner's
 * change. Refused, saying what the field is now, when it no longer has the change's `after` value; and for a revert,
 * which is not undone.
 */
export const revertAgentChange = (
  storage: RegistryStorage,
  store: RegistryStore,
  changes: AgentChanges,
  { environment, id }: { readonly environment: string; readonly id: number },
  now: number,
  /** The Skills a Skill brought back must fit with, for the revert of a Skill's change. */
  skills: Skills,
): AgentChangeRevert =>
  storage.transactionSync((): AgentChangeRevert => {
    // What is kept Global (Secrets, Container settings, Skills) has a history of its own, in the scope `*`.
    const isGlobal = environment === GLOBAL_SCOPE;
    const known = isGlobal ? null : current(store, environment);
    const change = changes.get(environment, id);

    if (change === null || (known === null && !isGlobal)) return { status: "missing" };

    if (change.actor === "owner") {
      return { status: "refused", message: "A revert is not undone: change the setting itself" };
    }

    // Once only: the agent may give the field the change's value again, which a second revert would undo unrecorded.
    if (change.revertedBy !== null) {
      return {
        status: "refused",
        message: `Change ${change.id} was reverted already, by change ${change.revertedBy}`,
      };
    }

    if (unrevertableField(change.field)) {
      return {
        status: "refused",
        message: unrevertableMessage(change),
      };
    }

    if (fieldSecret(change.field) !== null) {
      return revertSecretBuild(store, changes, environment, change, now);
    }

    if (isGlobal && isContainerField(change.field)) {
      return revertGlobalField(store, changes, change, now);
    }

    // A Skill's change reverts in either scope: an Environment's own Skills, and those kept Global.
    if (fieldSkill(change.field) !== null) {
      return revertSkillChange({ skills, store, changes, now }, environment, change);
    }

    if (known === null) return { status: "missing" };

    if (isLifecycleField(change.field)) {
      const reverted = revertLifecycleChange(store, changes, known.record, change, now);

      return reverted.status === "reverted"
        ? { status: "reverted", change: reverted.change }
        : reverted;
    }

    if (!isContainerField(change.field)) return { status: "missing" };

    const present = fieldState(known.state, change.field);

    // The field must still be as the change left it: the same Override, or still inherited.
    if (
      !sameOverride(
        overrideOf(known.state.overrides, change.field),
        recordedOverride(change.after, change.afterInherited),
      )
    ) {
      return { status: "changed-since", field: change.field, current: present.value };
    }

    // A value before that was inherited is a reset: the field inherits Global's again, whatever it is now.
    const back = recordedOverride(change.before, change.beforeInherited);

    const saved = patchEnvironment(
      store,
      environment,
      known.state,
      patchOf({ field: change.field, value: back ?? null }),
    );

    if (Result.isFailure(saved)) return { status: "refused", message: saved.failure };

    const after = fieldState(saved.success, change.field);

    const recorded = changes.record({
      scope: environment,
      at: now,
      actor: "owner",
      session: null,
      conversation: null,
      tool: null,
      reason: revertReason(change),
      field: change.field,
      before: present.value,
      after: after.value,
      reverts: change.id,
      beforeInherited: present.inherited,
      afterInherited: after.inherited,
    });

    return { status: "reverted", change: recorded, state: saved.success };
  });
