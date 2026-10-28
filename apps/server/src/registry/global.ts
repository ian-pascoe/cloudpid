// The variables kept Global (`docs/architecture/container.md` → Container settings, ADR-0023):
// one JSON document in the store's document table, as the settings are. Reading falls back to the defaults and writing
// validates, so what a Workspace is handed always resolves. The Registry merges them under each Environment's own
// variables when it hands settings over (`workspaceOverridesOf`), so the Workspace DO never knows of them.
import {
  type ContainerSettingsOverrides,
  containerOverridesFrom,
  DEFAULT_GLOBAL_SETTINGS,
  type GlobalSettings,
  globalOverridesFrom,
  mergedVariablesProblem,
  resolveGlobalSettings,
  resolveGlobalSettingsLeniently,
  withGlobalVariables,
} from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { readEnvironmentSettings } from "./environment-settings.ts";
import type { DocumentStore } from "./settings.ts";
import type { RegistryStore } from "./store.ts";

/** The name of the document holding the variables kept Global: its stored key keeps the old name, so no data moves. */
export const GLOBAL_DOCUMENT = "every-environment";

/** The settings kept Global in force, and the overrides they come from. */
export type GlobalState = {
  readonly settings: GlobalSettings;
  readonly overrides: Schema.Json;
  /** Why only some of the saved overrides applied, when a later release no longer accepts one. */
  readonly problem?: string;
};

const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

const defaults: GlobalState = {
  settings: DEFAULT_GLOBAL_SETTINGS,
  overrides: {},
};

/**
 * The settings kept Global in force. Saved overrides that no longer resolve cost only themselves, and
 * `problem` lists what was left out. Text that is not JSON gives the defaults, with the `problem`.
 */
export const readGlobal = (documents: DocumentStore): GlobalState => {
  const body = documents.getDocument(GLOBAL_DOCUMENT);

  if (body === null) return defaults;

  const saved = parseJson(body);

  if (Option.isNone(saved)) {
    return {
      ...defaults,
      problem: "The saved variables at Global are not valid JSON.",
    };
  }

  const { settings, dropped } = resolveGlobalSettingsLeniently(saved.value);
  const state = { settings, overrides: globalOverridesFrom(settings) };

  return dropped.length === 0 ? state : { ...state, problem: Arr.join(dropped, "\n") };
};

/** The variables kept Global in force. */
export const globalVariablesOf = (documents: DocumentStore): Readonly<Record<string, string>> =>
  readGlobal(documents).settings.variables;

/**
 * Replace the saved overrides with `overrides`, keeping only what differs from the defaults, or say why not, one
 * problem per line: they do not resolve, or an Environment would have more variables than it may with its own
 * (`mergedVariablesProblem`). Nothing is saved then.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a store operation, not a combinator.
export const writeGlobal = (
  store: DocumentStore & Pick<RegistryStore, "listEnvironments" | "getEnvironmentSettings">,
  overrides: Schema.Json,
  now: number,
): Result.Result<GlobalState, string> =>
  Result.flatMap(
    Result.mapError(resolveGlobalSettings(overrides), (error) => error.message),
    (settings) => {
      const problems = Arr.flatMap(store.listEnvironments(), ({ id, name }) => {
        const own = store.getEnvironmentSettings(id);

        const problem = mergedVariablesProblem(
          own === null ? {} : readEnvironmentSettings(own).settings.variables,
          settings.variables,
        );

        return problem === undefined
          ? []
          : [
              `variables: environment ${JSON.stringify(name)} (${id}) ${problem}; unset some there or here`,
            ];
      });

      if (problems.length > 0) return Result.fail(Arr.join(problems, "\n"));

      const kept = globalOverridesFrom(settings);

      store.putDocument(GLOBAL_DOCUMENT, JSON.stringify(kept), now);

      return Result.succeed({ settings, overrides: kept });
    },
  );

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
 * The overrides of `environment`'s settings with the variables kept Global under its own: what a
 * Workspace and a Build are handed. Null when the Environment is not registered.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a store operation, not a combinator.
export const workspaceOverridesOf = (
  store: DocumentStore & Pick<RegistryStore, "getEnvironmentSettings">,
  environment: string,
): WorkspaceOverrides | null => {
  const own = store.getEnvironmentSettings(environment);

  if (own === null) return null;

  const { settings } = readEnvironmentSettings(own);
  const every = globalVariablesOf(store);
  const problem = mergedVariablesProblem(settings.variables, every);
  const overrides = containerOverridesFrom(withGlobalVariables(settings, every));

  return problem === undefined ? { overrides } : { overrides, problem };
};
