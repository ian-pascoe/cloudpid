// The settings overrides as the Registry keeps them (`docs/spec.md` → Settings): one JSON document in the store's
// document table. Reading falls back to the defaults and writing validates, so what Sessions read always resolves.
import {
  DEFAULT_SETTINGS,
  overridesFrom,
  resolveSettings,
  type Settings,
  SettingsError,
  type SettingsOverrides,
} from "@cloudpid/config";
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

/** The settings in force. Overrides that cannot be read or no longer resolve give the defaults, with the `problem`. */
export const readSettings = (documents: DocumentStore): SettingsState => {
  const body = documents.getDocument(SETTINGS_DOCUMENT);

  if (body === null) return defaults;

  const overrides = parseJson(body);

  if (Option.isNone(overrides)) {
    return { ...defaults, problem: "The saved settings overrides are not valid JSON." };
  }

  const resolved = resolveSettings(overrides.value);

  return Result.isSuccess(resolved)
    ? { settings: resolved.success, overrides: overridesFrom(resolved.success) }
    : { ...defaults, problem: resolved.failure.message };
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
