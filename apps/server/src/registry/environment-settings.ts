// An Environment's Container settings (`docs/spec.md` → Container and Toolchains → Container settings), kept as overrides in
// its Registry row. Reading is lenient and writing strict, as for the global settings, so what a Workspace is told
// always resolves. Each Workspace is told them when a Session readies it, and applies them at its next launch.
import {
  type ContainerSettings,
  containerOverridesFrom,
  instanceLimitProblem,
  resolveContainerSettings,
  resolveContainerSettingsLeniently,
} from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";

/** An Environment's Container settings in force, and the overrides they come from. */
export type EnvironmentSettingsState = {
  readonly settings: ContainerSettings;
  readonly overrides: Schema.Json;
  /** Why only some of the saved overrides applied, when a later release no longer accepts one. */
  readonly problem?: string;
};

/** The settings saved `overrides` give: those that no longer resolve are left out, and `problem` says which. */
export const readEnvironmentSettings = (overrides: Schema.Json): EnvironmentSettingsState => {
  const { settings, dropped } = resolveContainerSettingsLeniently(overrides);
  const kept = containerOverridesFrom(settings);

  return dropped.length === 0
    ? { settings, overrides: kept }
    : { settings, overrides: kept, problem: Arr.join(dropped, "\n") };
};

/**
 * The state to save for `overrides`, or why they do not resolve, one problem per line, or why the size is larger than
 * the size limit (`instanceLimitProblem`). Only what differs from the defaults is kept, so a setting left alone follows
 * later changes of the default.
 */
export const writeEnvironmentSettings = (
  overrides: Schema.Json,
): Result.Result<EnvironmentSettingsState, string> =>
  Result.flatMap(
    Result.mapError(resolveContainerSettings(overrides), (error) => error.message),
    (settings) => {
      const problem = instanceLimitProblem(settings);

      return problem === undefined
        ? Result.succeed({ settings, overrides: containerOverridesFrom(settings) })
        : Result.fail(problem);
    },
  );
