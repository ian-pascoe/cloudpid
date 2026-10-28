// The Settings as the Registry keeps them (`docs/architecture/overview.md` → Settings, ADR-0027): Global's overrides of the
// defaults, one JSON document in the store's document table, and each Environment's Overrides of Global, in its row.
// Reading falls back to what resolves and writing validates, so what Sessions read always resolves.
// @effect-diagnostics missingPipeableSignature:off -- store operations, not combinators.
import {
  DEFAULT_SETTINGS,
  overrideFields,
  overridesFrom,
  resolveLeniently,
  resolveOverrides,
  resolveOverridesLeniently,
  resolveSettings,
  type Settings,
  SettingsError,
  type SettingsOverrides,
  withOverrides,
  withRenamedTools,
} from "@cloudpid/config";
import type { OverridingEnvironment, SettingsOverridesState } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/** The name of the settings overrides document. */
export const SETTINGS_DOCUMENT = "settings";

/** The Registry store's document table, as far as the settings use it. */
export type DocumentStore = {
  /** The document's JSON text, or null. */
  readonly getDocument: (name: string) => string | null;
  readonly putDocument: (name: string, body: string, now: number) => void;
};

/** The settings in force, and the overrides they come from. */
export type SettingsState = {
  readonly settings: Settings;
  readonly overrides: SettingsOverrides;
  /** Why the saved overrides were not used, when they no longer resolve: the settings are then the defaults. */
  readonly problem?: string;
};

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const defaults: SettingsState = { settings: DEFAULT_SETTINGS, overrides: {} };

/**
 * The settings in force. Saved overrides that no longer resolve (a model a release dropped, a setting it renamed) cost
 * only themselves: the rest still apply, and `problem` lists what was left out, so saving the form that shows the
 * survivors is the user's choice to forget the rest. Text that is not JSON gives the defaults, with the `problem`.
 */
export const readSettings = (documents: DocumentStore): SettingsState => {
  const body = documents.getDocument(SETTINGS_DOCUMENT);

  if (body === null) return defaults;

  const saved = parseJson(body);

  if (Option.isNone(saved)) {
    return { ...defaults, problem: "The saved settings overrides are not valid JSON." };
  }

  const { settings, dropped } = resolveLeniently(saved.value);
  const state = { settings, overrides: overridesFrom(settings) };

  return dropped.length === 0
    ? state
    : {
        ...state,
        problem: `These saved overrides no longer apply and are ignored:\n${Arr.join(dropped, "\n")}`,
      };
};

/**
 * What saving overrides came to, as the Registry DO answers it: plain data, since a Durable Object's RPC does not
 * carry error classes.
 */
export type SettingsUpdate = Data.TaggedEnum<{
  Saved: { readonly state: SettingsAnswer };
  Rejected: { readonly message: string };
}>;

export const SettingsUpdate = Data.taggedEnum<SettingsUpdate>();

/** The Global Settings as the Registry answers them: with, by field, the Environments that override it. */
export type SettingsAnswer = SettingsState & {
  readonly overriddenIn: Readonly<Record<string, ReadonlyArray<OverridingEnvironment>>>;
};

/**
 * Replace the saved overrides with `overrides`, keeping only what differs from the defaults. Overrides that do not
 * resolve fail with a readable `SettingsError`, and nothing is saved.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a store operation, not a combinator.
export const writeSettings = (
  documents: DocumentStore,
  overrides: Schema.Json,
  now: number,
): Result.Result<SettingsState, SettingsError> =>
  Result.map(resolveSettings(overrides), (settings) => {
    const normalized = overridesFrom(settings);

    documents.putDocument(SETTINGS_DOCUMENT, JSON.stringify(normalized), now);

    return { settings, overrides: normalized };
  });

/** The Global document as saved: `{}` before anything is, and text that is not JSON reads as none. */
export const savedGlobalSettings = (documents: DocumentStore): Schema.Json => {
  const body = documents.getDocument(SETTINGS_DOCUMENT);

  return body === null ? {} : Option.getOrElse(parseJson(body), () => ({}));
};

/** The Registry store as the Settings at both Scopes use it. */
export type SettingsStore = DocumentStore & {
  readonly getSettingsOverrides: (environment: string) => Schema.Json | null;
  readonly putSettingsOverrides: (environment: string, overrides: Schema.Json) => boolean;
  readonly listSettingsOverrides: () => ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly overrides: Schema.Json;
  }>;
};

/** The settings of an Environment with Overrides `saved`, over Global as the store has it. */
const overridesState = (
  store: SettingsStore,
  environment: string,
  saved: Schema.Json,
): SettingsOverridesState => {
  const { settings, global, overrides, dropped } = resolveOverridesLeniently(
    savedGlobalSettings(store),
    saved,
  );

  const state = { environment, settings, global, overrides };

  return dropped.length === 0
    ? state
    : {
        ...state,
        problem: `These saved Overrides no longer apply and are ignored, so their fields inherit Global:\n${Arr.join(dropped, "\n")}`,
      };
};

/**
 * Environment `environment`'s Settings: its Overrides that resolve over Global, those that no longer do left out and
 * listed in `problem` (their fields inherit). Null when no Environment has the id.
 */
export const readSettingsOverrides = (
  store: SettingsStore,
  environment: string,
): SettingsOverridesState | null => {
  const saved = store.getSettingsOverrides(environment);

  return saved === null ? null : overridesState(store, environment, saved);
};

/**
 * Save Environment `environment`'s Overrides, `overrides`, once they resolve strictly over Global; renamed tools are
 * saved under their new names. Answers its Settings, why the Overrides are not valid (saving nothing), or null when no
 * Environment has the id.
 */
export const putSettingsOverrides = (
  store: SettingsStore,
  environment: string,
  overrides: Schema.Json,
): Result.Result<SettingsOverridesState, SettingsError> | null => {
  const checked = resolveOverrides(savedGlobalSettings(store), overrides);

  if (Result.isFailure(checked)) return Result.fail(checked.failure);

  const renamed = withRenamedTools(overrides);

  return store.putSettingsOverrides(environment, renamed)
    ? Result.succeed(overridesState(store, environment, renamed))
    : null;
};

/**
 * The owner's change of Environment `environment`'s Overrides (`updateSettingsOverrides`): `set` given field by field
 * over the Overrides that resolve, then `reset` removed. Saved overrides that no longer resolve are forgotten, as
 * saving Global's form forgets them.
 */
export const updateSettingsOverrides = (
  storage: { readonly transactionSync: <A>(body: () => A) => A },
  store: SettingsStore,
  environment: string,
  change: {
    readonly set?: Schema.Json | undefined;
    readonly reset?: ReadonlyArray<string> | undefined;
  },
): Result.Result<SettingsOverridesState, SettingsError> | null =>
  storage.transactionSync(() => {
    const known = readSettingsOverrides(store, environment);

    if (known === null) return null;

    const next = withOverrides(known.overrides, change, known.settings);

    return Result.isFailure(next)
      ? Result.fail(next.failure)
      : putSettingsOverrides(store, environment, next.success);
  });

/** What a Session resolves its Settings from (`sessionSettings`). */
export type SessionSettingsSource = {
  /** Global's overrides of the defaults that apply. */
  readonly global: Schema.Json;
  /** The Session's Environment, or null for a Session the Registry does not list. */
  readonly environment: string | null;
  /** The Environment's Overrides as saved: `{}` for none. */
  readonly overrides: Schema.Json;
};

/**
 * What Session `session` resolves its Settings from (ADR-0027): Global's overrides that apply, and the Overrides of the
 * Environment its Workspace was made from, as saved. A Session the store does not list has no Environment, and Global's.
 */
export const sessionSettingsSource = (
  store: SettingsStore & {
    readonly getSession: (id: string) => { readonly environment: string } | null;
  },
  session: string,
): SessionSettingsSource => {
  const global = readSettings(store).overrides;
  const known = store.getSession(session);
  const overrides = known === null ? null : store.getSettingsOverrides(known.environment);

  return known === null || overrides === null
    ? { global, environment: null, overrides: {} }
    : { global, environment: known.environment, overrides };
};

/**
 * By field, the Environments that override it (`SettingsState.overriddenIn`), newest first: each one's Overrides that
 * resolve over Global.
 */
export const overriddenIn = (store: SettingsStore): SettingsAnswer["overriddenIn"] => {
  const global = savedGlobalSettings(store);
  const fields: Record<string, Array<OverridingEnvironment>> = {};

  for (const { id, name, overrides } of store.listSettingsOverrides()) {
    for (const field of overrideFields(resolveOverridesLeniently(global, overrides).overrides)) {
      (fields[field] ??= []).push({ id, name });
    }
  }

  return fields;
};
