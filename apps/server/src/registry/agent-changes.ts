// Agent changes (`docs/spec.md` → Agent changes, ADR-0019): what the agent changes in an Environment, applied as the
// owner's save is and recorded with when, the Session, the tool, the reason and the values before and after, so the
// owner can see each one and revert it. Synchronous over the Registry DO's SQLite, as the store is, so a change and its
// record are one step no other request lands in the middle of. The table is migration 17's (`store.ts`), and deleting
// an Environment deletes its changes.
// @effect-diagnostics missingPipeableSignature:off asyncFunction:off -- plain functions over SQLite, and a digest.
import {
  type ContainerSettings,
  containerOverridesFrom,
  DEFAULT_CONTAINER_SETTINGS,
} from "@cloudpid/config";
import { type AgentChange, MAX_AGENT_CHANGES } from "@cloudpid/protocol";
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
import { buildKey } from "../workspace/build-record.ts";
import { buildWanted } from "./builds.ts";
import type { EnvironmentRecord, RegistryStorage, RegistryStore } from "./store.ts";

/** Who made an Agent change: the Session, the conversation in it that called the tool, the tool, and why. */
export type AgentChangeAuthor = {
  readonly session: string;
  readonly conversation: number;
  readonly tool: string;
  readonly reason: string;
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
  | { readonly status: "missing" };

/** How the owner's revert of an Agent change went. */
export type AgentChangeRevert =
  | {
      readonly status: "reverted";
      /** The owner's change that wrote the value back. */
      readonly change: AgentChange;
      readonly state: EnvironmentSettingsState;
    }
  /** The field has changed since: it is `current` now, and nothing was written. */
  | {
      readonly status: "changed-since";
      readonly field: string;
      readonly current: Schema.Json | null;
    }
  | { readonly status: "refused"; readonly message: string }
  | { readonly status: "missing" };

const VARIABLE_FIELD = "variables.";

/** The field of variable `name`. */
export const variableField = (name: string): string => `${VARIABLE_FIELD}${name}`;

const SETTING_NAMES: ReadonlySet<string> = new Set<string>(Record.keys(DEFAULT_CONTAINER_SETTINGS));

const isSetting = (field: string): field is keyof ContainerSettings => SETTING_NAMES.has(field);

/** Whether `field` names a Container setting or one variable. */
const isContainerField = (field: string): boolean =>
  field.startsWith(VARIABLE_FIELD) || isSetting(field);

/** The value `field` has in `settings`: null for a variable that is not set. */
export const fieldValue = (settings: ContainerSettings, field: string): Schema.Json | null => {
  if (field.startsWith(VARIABLE_FIELD)) {
    return settings.variables[field.slice(VARIABLE_FIELD.length)] ?? null;
  }

  return isSetting(field) ? settings[field] : null;
};

/** The overrides that make `settings` into ones where `field` is `value` (null: its default, or a variable unset). */
const overridesWith = (
  settings: ContainerSettings,
  { field, value }: ContainerFieldChange,
): Schema.Json => {
  const overrides: Record<string, Schema.Json> = { ...containerOverridesFrom(settings) };

  if (field.startsWith(VARIABLE_FIELD)) {
    const name = field.slice(VARIABLE_FIELD.length);
    const { [name]: _replaced, ...others } = settings.variables;

    overrides.variables = value === null ? others : { ...others, [name]: value };
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
};

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

/** A stored value: JSON text, or null for none. Text that is not JSON (never written so) reads as none. */
const valueOf = (text: string | null): Schema.Json | null =>
  text === null ? null : Option.getOrNull(decodeJson(text));

const toChange = (row: AgentChangeRow): AgentChange => ({
  id: row.id,
  scope: row.scope,
  at: row.at,
  actor: row.actor === "owner" ? "owner" : "agent",
  session: row.session,
  conversation: row.conversation,
  tool: row.tool,
  reason: row.reason,
  field: row.field,
  before: valueOf(row.before),
  after: valueOf(row.after),
  reverts: row.reverts,
  revertedBy: row.reverted_by,
});

/** What a change records: everything but its number, which the table gives it. */
type NewAgentChange = Omit<AgentChange, "id" | "revertedBy">;

/** The Agent changes the Registry keeps, by scope (an Environment's id, or the Settings'). */
export type AgentChanges = {
  /** Record `change`, keeping only the newest `MAX_AGENT_CHANGES` of its scope; answers it as recorded. */
  readonly record: (change: NewAgentChange) => AgentChange;
  /** The changes of `scope`, newest first. */
  readonly list: (scope: string) => ReadonlyArray<AgentChange>;
  /** Change `id` of `scope`, or null. */
  readonly get: (scope: string, id: number) => AgentChange | null;
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
          `INSERT INTO agent_changes (scope, at, actor, session, conversation, tool, reason, field, before, after, reverts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
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
        )
        .toArray();

      sql.exec(
        `DELETE FROM agent_changes WHERE scope = ? AND id NOT IN (
           SELECT id FROM agent_changes WHERE scope = ? ORDER BY id DESC LIMIT ?
         )`,
        change.scope,
        change.scope,
        MAX_AGENT_CHANGES,
      );

      return { ...change, id: row?.id ?? 0, revertedBy: null };
    },
    list: (scope) =>
      Arr.map(
        sql
          .exec<AgentChangeRow>(
            `${SELECT_CHANGES} WHERE changes.scope = ? ORDER BY changes.id DESC`,
            scope,
          )
          .toArray(),
        toChange,
      ),
    get,
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
 * value records nothing.
 */
export const changeEnvironment = (
  storage: RegistryStorage,
  store: RegistryStore,
  changes: AgentChanges,
  {
    environment,
    change,
    author,
  }: {
    readonly environment: string;
    readonly change: ContainerFieldChange;
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

    if (sameJson(before, change.value)) {
      return { status: "unchanged", environment: known.record, value: before };
    }

    const saved = writeEnvironmentSettings(overridesWith(known.settings, change));

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
): AgentChangeRevert =>
  storage.transactionSync((): AgentChangeRevert => {
    const known = current(store, environment);
    const change = changes.get(environment, id);

    if (known === null || change === null) return { status: "missing" };

    if (change.actor === "owner") {
      return { status: "refused", message: "A revert is not undone: change the setting itself" };
    }

    const value = fieldValue(known.settings, change.field);

    if (!sameJson(value, change.after)) {
      return { status: "changed-since", field: change.field, current: value };
    }

    const saved = writeEnvironmentSettings(
      overridesWith(known.settings, { field: change.field, value: change.before }),
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
      reason: `Reverted change ${change.id}${Predicate.isNotNull(change.tool) ? ` (${change.tool})` : ""}`,
      field: change.field,
      before: value,
      after: fieldValue(saved.success.settings, change.field),
      reverts: change.id,
    });

    return { status: "reverted", change: recorded, state: saved.success };
  });
