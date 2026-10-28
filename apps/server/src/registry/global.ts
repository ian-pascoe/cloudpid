// The Container settings at Global (`docs/architecture/container.md` → Container settings, ADR-0023, ADR-0027): one JSON
// document in the store's document table, as the settings are, holding what differs from the defaults. Reading falls
// back to the defaults and writing validates, so what a Workspace is handed always resolves. An Environment's
// Overrides go over them when the Registry hands settings over (`workspaceOverridesOf`), so the Workspace DO and a
// Build only ever see one resolved set.
import {
  CONTAINER_SETTING_NAMES,
  type ContainerPatch,
  type ContainerSettings,
  type ContainerSettingsOverrides,
  containerOverridesFrom,
  DEFAULT_CONTAINER_SETTINGS,
  instanceLimitProblem,
  mergedVariablesProblem,
  patchContainerOverrides,
  resolveContainerOverridesLeniently,
  resolveContainerSettings,
  resolveContainerSettingsLeniently,
} from "@cloudpid/config";
import { type OverridingEnvironment, variableField } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  type EnvironmentSettingsState,
  inheritedSizeProblem,
  readEnvironmentSettings,
} from "./environment-settings.ts";
import type { DocumentStore } from "./settings.ts";
import type { RegistryStore } from "./store.ts";

/**
 * The name of the document holding the Container settings at Global: its stored key keeps the name it had when it
 * held only the variables, so no data moves.
 */
export const GLOBAL_DOCUMENT = "every-environment";

/** The Container settings at Global in force, and what is saved of them: what differs from the defaults. */
export type GlobalState = {
  readonly settings: ContainerSettings;
  readonly overrides: ContainerSettingsOverrides;
  /** Why only some of the saved overrides applied, when a later release no longer accepts one. */
  readonly problem?: string;
};

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const defaults: GlobalState = { settings: DEFAULT_CONTAINER_SETTINGS, overrides: {} };

/**
 * The Container settings at Global in force. Saved overrides that no longer resolve cost only themselves, and
 * `problem` lists what was left out. Text that is not JSON gives the defaults, with the `problem`.
 */
export const readGlobal = (documents: Pick<DocumentStore, "getDocument">): GlobalState => {
  const body = documents.getDocument(GLOBAL_DOCUMENT);

  if (body === null) return defaults;

  const saved = parseJson(body);

  if (Option.isNone(saved)) {
    return { ...defaults, problem: "The saved Container settings at Global are not valid JSON." };
  }

  const { settings, dropped } = resolveContainerSettingsLeniently(saved.value);
  const state = { settings, overrides: containerOverridesFrom(settings) };

  return dropped.length === 0 ? state : { ...state, problem: Arr.join(dropped, "\n") };
};

/** The Container settings at Global in force. */
export const globalSettingsOf = (
  documents: Pick<DocumentStore, "getDocument">,
): ContainerSettings => readGlobal(documents).settings;

/** The store as the Container settings at Global are read and saved with the Environments that inherit them. */
export type GlobalStore = DocumentStore & OverridesStore;

/** The store as the Environments' Overrides are read. */
type OverridesStore = Pick<RegistryStore, "listEnvironments" | "getEnvironmentSettings">;

/** `environment`'s saved Overrides that still resolve (none for one not registered). */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a store read, not a combinator.
export const overridesOf = (
  store: Pick<RegistryStore, "getEnvironmentSettings">,
  environment: string,
): ContainerSettingsOverrides =>
  resolveContainerOverridesLeniently(store.getEnvironmentSettings(environment) ?? {}).overrides;

/** Each Environment's Overrides that still resolve, with its id and name. */
const overridesOfEach = (store: OverridesStore) =>
  Arr.map(store.listEnvironments(), ({ id, name }) => ({
    id,
    name,
    overrides: overridesOf(store, id),
  }));

/**
 * Save `next` as the Container settings at Global, keeping only what differs from the defaults, or say why not, one
 * problem per line: they do not resolve; the size is above the size limit, checked when the save changes either; an
 * Environment whose size or size limit the save changes (one that inherits either) would then have a size above its
 * size limit; or an Environment would have more variables than it may with its own (`mergedVariablesProblem`). Each
 * Environment refused is named. Nothing is saved then.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a store operation, not a combinator.
export const writeGlobal = (
  store: GlobalStore,
  next: Schema.Json,
  now: number,
): Result.Result<GlobalState, string> =>
  Result.flatMap(
    Result.mapError(resolveContainerSettings(next), (error) => error.message),
    (settings) => {
      const previous = globalSettingsOf(store);

      const sizeChanged =
        settings.instance !== previous.instance || settings.maxInstance !== previous.maxInstance;

      const own = sizeChanged ? instanceLimitProblem(settings) : undefined;

      if (own !== undefined) return Result.fail(own);

      const problems = Arr.flatMap(overridesOfEach(store), ({ id, name, overrides }) => {
        const named = `environment ${JSON.stringify(name)} (${id})`;
        const variables = mergedVariablesProblem(overrides.variables ?? {}, settings.variables);

        const size = inheritedSizeProblem(overrides, previous, settings);

        return [
          ...(size === undefined
            ? []
            : [
                `instance: ${named}: ${size}; override its size or size limit there, or change them here`,
              ]),
          ...(variables === undefined
            ? []
            : [`variables: ${named} ${variables}; unset some there or here`]),
        ];
      });

      if (problems.length > 0) return Result.fail(Arr.join(problems, "\n"));

      const kept = containerOverridesFrom(settings);

      store.putDocument(GLOBAL_DOCUMENT, JSON.stringify(kept), now);

      return Result.succeed({ settings, overrides: kept });
    },
  );

/** Save the Container settings at Global once `patch` sets or resets some of them, or say why not (`writeGlobal`). */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a store operation, not a combinator.
export const patchGlobal = (
  store: GlobalStore,
  patch: ContainerPatch,
  now: number,
): Result.Result<GlobalState, string> =>
  Result.flatMap(patchContainerOverrides(readGlobal(store).overrides, patch), (next) =>
    writeGlobal(store, next, now),
  );

/**
 * The Environments that override each Container setting, by the field's path as an Agent change names it
 * (`idleMinutes`, `variables.<NAME>`), for the page's "Overridden in N environments". A field none overrides is left
 * out.
 */
export const overriddenIn = (
  store: OverridesStore,
): Record<string, ReadonlyArray<OverridingEnvironment>> => {
  const fields: Record<string, Array<OverridingEnvironment>> = {};

  for (const { id, name, overrides } of overridesOfEach(store)) {
    const paths = [
      ...Arr.filter(
        CONTAINER_SETTING_NAMES,
        (field) => field !== "variables" && overrides[field] !== undefined,
      ),
      ...Arr.map(Record.keys(overrides.variables ?? {}), variableField),
    ];

    for (const path of paths) (fields[path] ??= []).push({ id, name });
  }

  return fields;
};

/** `environment`'s Container settings state: its Overrides over Global's. Null when it is not registered. */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a store operation, not a combinator.
export const environmentSettingsOf = (
  store: Pick<DocumentStore, "getDocument"> & Pick<RegistryStore, "getEnvironmentSettings">,
  environment: string,
): EnvironmentSettingsState | null => {
  const stored = store.getEnvironmentSettings(environment);

  return stored === null ? null : readEnvironmentSettings(stored, globalSettingsOf(store));
};

/**
 * The overrides a Workspace of an Environment is handed, and why they were cut, when the set was too large to keep
 * whole.
 */
export type WorkspaceOverrides = {
  readonly overrides: ContainerSettingsOverrides;
  /** `mergedVariablesProblem`'s words, when the merged variables passed the limit and some were left out. */
  readonly problem?: string;
};

/**
 * What a Workspace and a Build of `environment` are handed: its settings in force (its Overrides over Global's) as
 * overrides of the defaults, the shape the Workspace DO keeps. Null when the Environment is not registered.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a store operation, not a combinator.
export const workspaceOverridesOf = (
  store: Pick<DocumentStore, "getDocument"> & Pick<RegistryStore, "getEnvironmentSettings">,
  environment: string,
): WorkspaceOverrides | null => {
  const state = environmentSettingsOf(store, environment);

  if (state === null) return null;

  const problem = mergedVariablesProblem(state.overrides.variables ?? {}, state.global.variables);
  const overrides = containerOverridesFrom(state.settings);

  return problem === undefined ? { overrides } : { overrides, problem };
};
