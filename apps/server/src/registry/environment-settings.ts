// An Environment's Container settings (`docs/architecture/container.md` → Container settings, ADR-0027), kept as its
// Overrides of Global in its Registry row: exactly the fields set on purpose, even one equal to Global's. Reading is
// lenient and writing strict, as for the global settings, so what a Workspace is told always resolves. Each Workspace
// is told the settings in force (the Overrides over Global's) when a Session readies it, and applies them at its next
// launch.
import {
  compareInstances,
  type ContainerPatch,
  type ContainerSettings,
  type ContainerSettingsOverrides,
  instanceLimitProblem,
  mergedVariablesProblem,
  patchContainerOverrides,
  resolveContainerOverrides,
  resolveContainerOverridesLeniently,
  resolveEnvironmentContainerSettings,
} from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";

/** An Environment's Container settings in force, Global's it inherits from, and its Overrides. */
export type EnvironmentSettingsState = {
  /** The Overrides over `global`. */
  readonly settings: ContainerSettings;
  readonly global: ContainerSettings;
  readonly overrides: ContainerSettingsOverrides;
  /** Why only some of the saved Overrides applied, when a later release no longer accepts one. */
  readonly problem?: string;
};

/**
 * The state the saved `stored` Overrides give over Global's `global`: those that no longer resolve are left out (their
 * fields inherit Global's), and `problem` says which.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a read of stored values, not a combinator.
export const readEnvironmentSettings = (
  stored: Schema.Json,
  global: ContainerSettings,
): EnvironmentSettingsState => {
  const { overrides, dropped } = resolveContainerOverridesLeniently(stored);

  const state = {
    settings: resolveEnvironmentContainerSettings(global, overrides),
    global,
    overrides,
  };

  return dropped.length === 0 ? state : { ...state, problem: Arr.join(dropped, "\n") };
};

/** The size and size limit `overrides` give over `global`, before any raise: what a save checks. */
const sizesOf = (global: ContainerSettings, overrides: ContainerSettingsOverrides) => ({
  instance: overrides.instance ?? global.instance,
  maxInstance: overrides.maxInstance ?? global.maxInstance,
});

/**
 * The size limit an Environment saved larger than its limit before it had one runs with: its size, when `overrides`
 * have a size above Global's limit and no limit of their own (`withLimitAtLeastSize` raises it as they are read).
 */
const raisedLimit = (
  overrides: ContainerSettingsOverrides,
  global: ContainerSettings,
): ContainerSettingsOverrides["maxInstance"] =>
  overrides.maxInstance === undefined &&
  overrides.instance !== undefined &&
  compareInstances(overrides.instance, global.maxInstance) > 0
    ? overrides.instance
    : undefined;

/**
 * The state to save for the Overrides `next`, which replace `previous`, or why not, one problem per line: they do not
 * resolve; the size is larger than the size limit (`instanceLimitProblem`), checked when the save changes either; or
 * the variables with Global's are more than a Workspace takes (`mergedVariablesProblem`). Every field `next` holds is
 * kept, one equal to Global's too. A save that changes the size of an Environment whose limit was raised to its size
 * (saved larger before it had a limit) keeps that limit as its own, as a save of the whole settings did.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a store operation, not a combinator.
export const writeEnvironmentSettings = (
  previous: ContainerSettingsOverrides,
  next: Schema.Json,
  global: ContainerSettings,
): Result.Result<EnvironmentSettingsState, string> =>
  Result.flatMap(
    Result.mapError(resolveContainerOverrides(next), (error) => error.message),
    (resolved) => {
      const merged = mergedVariablesProblem(resolved.variables ?? {}, global.variables);

      const sizeChanged =
        resolved.instance !== previous.instance || resolved.maxInstance !== previous.maxInstance;

      const raised = raisedLimit(previous, global);

      const overrides =
        sizeChanged && raised !== undefined && resolved.maxInstance === undefined
          ? { ...resolved, maxInstance: raised }
          : resolved;

      const problem =
        (sizeChanged ? instanceLimitProblem(sizesOf(global, overrides)) : undefined) ??
        (merged === undefined ? undefined : `variables: ${merged}`);

      return problem === undefined
        ? Result.succeed({
            settings: resolveEnvironmentContainerSettings(global, overrides),
            global,
            overrides,
          })
        : Result.fail(problem);
    },
  );

/**
 * The state to save once `patch` sets or resets fields of the saved `stored` Overrides (read leniently, so one that no
 * longer resolves is dropped), or why not (`writeEnvironmentSettings`).
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a store operation, not a combinator.
export const patchEnvironmentSettings = (
  stored: Schema.Json,
  patch: ContainerPatch,
  global: ContainerSettings,
): Result.Result<EnvironmentSettingsState, string> => {
  const { overrides } = resolveContainerOverridesLeniently(stored);

  return Result.flatMap(patchContainerOverrides(overrides, patch), (next) =>
    writeEnvironmentSettings(overrides, next, global),
  );
};

/**
 * Why the Overrides `overrides` cannot have Global's settings change from `before` to `after` under them, or undefined:
 * their size would be above their size limit. Checked only when the size or size limit they inherit changes, and
 * before any raise, so an Environment saved larger than its limit before it had one is left as it ran by any other
 * change at Global, and checked against a new limit there as every Environment is.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a check, not a combinator.
export const inheritedSizeProblem = (
  overrides: ContainerSettingsOverrides,
  before: ContainerSettings,
  after: ContainerSettings,
): string | undefined => {
  const was = sizesOf(before, overrides);
  const is = sizesOf(after, overrides);

  return was.instance === is.instance && was.maxInstance === is.maxInstance
    ? undefined
    : instanceLimitProblem(is);
};
