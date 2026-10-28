// Agent changes (`docs/spec.md` → Agent changes, ADR-0019): what the agent changes in an Environment, applied as the
// owner's save is and recorded with when, the Session, the tool, the reason and the values before and after, so the
// owner can see each one and revert it. Synchronous over the Registry DO's SQLite, as the store is, so a change and its
// record are one step no other request lands in the middle of. The table is migration 17's (`store.ts`), and deleting
// an Environment deletes its changes.
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- plain functions over SQLite, and a digest.
import {
  type ContainerSettings,
  containerOverridesFrom,
  currentFieldValue,
  DEFAULT_CONTAINER_SETTINGS,
  withEveryEnvironmentVariables,
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
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  type EnvironmentSettingsState,
  readEnvironmentSettings,
  writeEnvironmentSettings,
} from "./environment-settings.ts";
import type { EnvironmentRepo } from "@cloudpid/protocol";
import { buildKey, buildWanted } from "../workspace/build-record.ts";
import { isLifecycleField, revertLifecycleChange } from "./environment-lifecycle.ts";
import { everyVariablesOf, writeEveryEnvironment } from "./every-environment.ts";
import { revertSecretBuild } from "./secret-changes.ts";
import { dropUnreferencedSkillFiles, type KeptSkills, revertSkillChange } from "./skills.ts";
import {
  type EnvironmentRecord,
  EVERY_ENVIRONMENT_SCOPE,
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
 * One Container setting of an Environment, given a new value: `field` is a setting's name (`idleMinutes`) or
 * `variables.<NAME>` for one variable, and a `value` of null takes the setting back to its default (a variable: unset).
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
  /** The field already had the value (a variable unset that was not set): nothing was saved or recorded. */
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

/** How an Agent change to the variables kept for every Environment went. */
export type EveryEnvironmentChange =
  | {
      readonly status: "changed";
      readonly change: AgentChange;
      /** The variable's name. */
      readonly name: string;
      /** The variables kept for every Environment before it, and in force now. */
      readonly previous: Readonly<Record<string, string>>;
      readonly variables: Readonly<Record<string, string>>;
    }
  /** The variable already had the value (one unset that was not set): nothing was saved or recorded. */
  | { readonly status: "unchanged"; readonly value: Schema.Json | null }
  /** The value is not one a variable takes, or some Environment would have too many variables: nothing was saved. */
  | { readonly status: "rejected"; readonly message: string };

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

const SETTING_NAMES: ReadonlySet<string> = new Set<string>(Record.keys(DEFAULT_CONTAINER_SETTINGS));

const isSetting = (field: string): field is keyof ContainerSettings => SETTING_NAMES.has(field);

/** Whether `field` names a Container setting or one variable. */
const isContainerField = (field: string): boolean =>
  fieldVariable(field) !== null || isSetting(field);

/** The value `field` has in `settings`: null for a variable that is not set. */
export const fieldValue = (settings: ContainerSettings, field: string): Schema.Json | null => {
  const variable = fieldVariable(field);

  if (variable !== null) return settings.variables[variable] ?? null;

  return isSetting(field) ? settings[field] : null;
};

/** `variables` with `name` set to `value`, or taken out for null. */
const withVariable = (
  variables: Readonly<Record<string, string>>,
  name: string,
  value: Schema.Json | null,
): Record<string, Schema.Json> => {
  const { [name]: _replaced, ...others } = variables;

  return value === null ? others : { ...others, [name]: value };
};

/** The overrides that make `settings` into ones where `field` is `value` (null: its default, or a variable unset). */
const overridesWith = (
  settings: ContainerSettings,
  { field, value }: ContainerFieldChange,
): Schema.Json => {
  const overrides: Record<string, Schema.Json> = { ...containerOverridesFrom(settings) };

  const name = fieldVariable(field);

  if (name !== null) {
    overrides.variables = withVariable(settings.variables, name, value);
  } else if (value === null) {
    delete overrides[field];
  } else {
    overrides[field] = value;
  }

  return overrides;
};

const sameJson = Schema.toEquivalence(Schema.NullOr(Schema.Json));

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

  // Only a change the owner approved says so (`docs/spec.md` → Approval).
  return row.approved === 1 ? { ...change, approved: true } : change;
};

/**
 * What a change records: everything but its number, which the table gives it, and whether the owner approved it first
 * (absent or false: not).
 */
type NewAgentChange = Omit<AgentChange, "id" | "revertedBy" | "approved"> & {
  readonly approved?: boolean | undefined;
};

/** `change` as it is recorded under `id`, with no revert yet; marked approved only when the owner approved it. */
export const asRecorded = (change: NewAgentChange, id: number): AgentChange => {
  const { approved, ...made } = change;
  const recorded: AgentChange = { ...made, id, revertedBy: null };

  return approved === true ? { ...recorded, approved: true } : recorded;
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
          `INSERT INTO agent_changes (scope, at, actor, session, conversation, tool, reason, field, before, after, reverts, approved)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
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

/** An Environment as an Agent change to the variables kept for every Environment sees it. */
export type ReachedEnvironment = {
  readonly id: string;
  readonly name: string;
  readonly repos: ReadonlyArray<EnvironmentRepo>;
  readonly settings: ContainerSettings;
};

/** Where an Agent change to a variable kept for every Environment goes. */
export type EveryChangeReach = {
  /** The Environments whose own variable of the name wins, so the change does not reach them. */
  readonly overriddenIn: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** The Environments it reaches that want a Build of another key (`wantsNewBuild`). */
  readonly newBuilds: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** Whether it reaches the Environment `caller` names; undefined when none is named. */
  readonly own: boolean | undefined;
};

/**
 * Where a change of variable `name` kept for every Environment, from the variables `previous` to `variables`, goes: an
 * Environment with its own variable of the name is not reached, and one that is reached wants a new Build when its
 * Build key changes with the merged variables.
 */
export const everyChangeReach = async (
  environments: ReadonlyArray<ReachedEnvironment>,
  name: string,
  previous: Readonly<Record<string, string>>,
  variables: Readonly<Record<string, string>>,
  caller: string | undefined,
): Promise<EveryChangeReach> => {
  const overriding = Arr.filter(environments, ({ settings }) =>
    Record.has(settings.variables, name),
  );

  const reached = Arr.filter(environments, ({ settings }) => !Record.has(settings.variables, name));

  const wantsBuild = await Promise.all(
    Arr.map(reached, ({ repos, settings }) =>
      wantsNewBuild(
        repos,
        withEveryEnvironmentVariables(settings, previous),
        withEveryEnvironmentVariables(settings, variables),
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

/** The settings in force for `environment`, and its record; null when it is not registered. */
const current = (store: RegistryStore, environment: string) => {
  const record = store.getEnvironment(environment);
  const overrides = store.getEnvironmentSettings(environment);

  return record === null || overrides === null
    ? null
    : { record, settings: readEnvironmentSettings(overrides).settings };
};

/**
 * Apply the agent's `change` to `environment`'s Container settings as the owner's save does (`writeEnvironmentSettings`:
 * the same rules, one problem per line), and record it as an Agent change by `author`. A field that already has the
 * value records nothing. With `expected`, the change is made only while the field has that value: the one the owner
 * saw when they approved it.
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

    const before = fieldValue(known.settings, change.field);

    // An Approval asked for before the sizes were renamed may name an old one (`currentFieldValue`).
    if (sameJson(before, currentFieldValue(change.field, change.value))) {
      return { status: "unchanged", environment: known.record, value: before };
    }

    if (
      expected !== undefined &&
      !sameJson(before, currentFieldValue(change.field, expected.value))
    ) {
      return { status: "changed-since", current: before };
    }

    const saved = writeEnvironmentSettings(
      overridesWith(known.settings, change),
      everyVariablesOf(store),
    );

    if (Result.isFailure(saved)) return { status: "rejected", message: saved.failure };

    store.putEnvironmentSettings(environment, saved.success.overrides);

    const recorded = changes.record({
      scope: environment,
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

    return {
      status: "changed",
      environment: known.record,
      change: recorded,
      previous: known.settings,
      state: saved.success,
    };
  });

/**
 * Apply the agent's `change` of one variable kept for every Environment as the owner's save does
 * (`writeEveryEnvironment`: the same rules, and no Environment may be left with too many variables), and record it as
 * an Agent change by `author` under the scope `*`. A variable that already has the value records nothing.
 */
export const changeEveryEnvironment = (
  storage: RegistryStorage,
  store: RegistryStore,
  changes: AgentChanges,
  { change, author }: { readonly change: ContainerFieldChange; readonly author: AgentChangeAuthor },
  now: number,
): EveryEnvironmentChange =>
  storage.transactionSync((): EveryEnvironmentChange => {
    const name = fieldVariable(change.field);

    if (name === null) {
      return {
        status: "rejected",
        message: `${change.field}: only variables are kept for every Environment`,
      };
    }

    const previous = everyVariablesOf(store);
    const before = previous[name] ?? null;

    if (sameJson(before, change.value)) return { status: "unchanged", value: before };

    const saved = writeEveryEnvironment(
      store,
      { variables: withVariable(previous, name, change.value) },
      now,
    );

    if (Result.isFailure(saved)) return { status: "rejected", message: saved.failure };

    const variables = saved.success.settings.variables;

    const recorded = changes.record({
      scope: EVERY_ENVIRONMENT_SCOPE,
      at: now,
      actor: "agent",
      session: author.session,
      conversation: author.conversation,
      tool: author.tool,
      reason: author.reason,
      field: change.field,
      before,
      after: variables[name] ?? null,
      reverts: null,
      approved: author.approved,
    });

    return { status: "changed", change: recorded, name, previous, variables };
  });

/** What an owner's revert of `change` says it undid. */
const revertReason = (change: AgentChange): string =>
  `Reverted change ${change.id}${Predicate.isNotNull(change.tool) ? ` (${change.tool})` : ""}`;

/**
 * The owner's revert of Agent change `change` of the variable `name` kept for every Environment: its `before` value
 * written back, if the variable still has the change's `after` value.
 */
const revertEveryVariable = (
  store: RegistryStore,
  changes: AgentChanges,
  change: AgentChange,
  name: string,
  now: number,
): AgentChangeRevert => {
  const variables = everyVariablesOf(store);
  const value = variables[name] ?? null;

  if (!sameJson(value, change.after)) {
    return { status: "changed-since", field: change.field, current: value };
  }

  const saved = writeEveryEnvironment(
    store,
    { variables: withVariable(variables, name, change.before) },
    now,
  );

  if (Result.isFailure(saved)) return { status: "refused", message: saved.failure };

  const recorded = changes.record({
    scope: EVERY_ENVIRONMENT_SCOPE,
    at: now,
    actor: "owner",
    session: null,
    conversation: null,
    tool: null,
    reason: revertReason(change),
    field: change.field,
    before: value,
    after: saved.success.settings.variables[name] ?? null,
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
  /** The Skills, and the bundle a Skill brought back must fit with, for the revert of a Skill's change. */
  kept: KeptSkills,
): AgentChangeRevert =>
  storage.transactionSync((): AgentChangeRevert => {
    // The Secrets and variables kept for every Environment have a history of their own, in the scope `*`.
    const every = environment === EVERY_ENVIRONMENT_SCOPE;
    const known = every ? null : current(store, environment);
    const change = changes.get(environment, id);

    if (change === null || (known === null && !every)) return { status: "missing" };

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

    const variable = fieldVariable(change.field);

    if (every && variable !== null)
      return revertEveryVariable(store, changes, change, variable, now);

    // A Skill's change reverts in either scope: an Environment's own Skills, and those kept for every Environment.
    if (fieldSkill(change.field) !== null) {
      return revertSkillChange({ ...kept, store, changes, now }, environment, change);
    }

    if (known === null) return { status: "missing" };

    if (isLifecycleField(change.field)) {
      const reverted = revertLifecycleChange(store, changes, known.record, change, now);

      return reverted.status === "reverted"
        ? { status: "reverted", change: reverted.change }
        : reverted;
    }

    const value = fieldValue(known.settings, change.field);

    if (!sameJson(value, change.after)) {
      return { status: "changed-since", field: change.field, current: value };
    }

    const saved = writeEnvironmentSettings(
      overridesWith(known.settings, { field: change.field, value: change.before }),
      everyVariablesOf(store),
    );

    if (Result.isFailure(saved)) return { status: "refused", message: saved.failure };

    store.putEnvironmentSettings(environment, saved.success.overrides);

    const recorded = changes.record({
      scope: environment,
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

    return { status: "reverted", change: recorded, state: saved.success };
  });
