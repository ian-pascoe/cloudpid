// The settings overrides as the Registry keeps them (`docs/architecture/overview.md` → Settings): one JSON document in the store's
// document table. Reading falls back to the defaults and writing validates, so what Sessions read always resolves.
import {
  DEFAULT_SETTINGS,
  overridesFrom,
  resolveLeniently,
  resolveSettings,
  type Settings,
  SettingsError,
  type SettingsOverrides,
} from "@cloudpid/config";
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
  Saved: { readonly state: SettingsState };
  Rejected: { readonly message: string };
}>;

export const SettingsUpdate = Data.taggedEnum<SettingsUpdate>();

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
