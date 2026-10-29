// @effect-diagnostics missingPipeableSignature:off -- comparisons and builders of plain values, not combinators.

// What every patch of settings is made of (ADR-0027; docs/architecture/client-and-protocol.md → Settings page → Saving):
// a comparison of two values as JSON, and a patch that sets some fields and resets others, each part left out when it
// holds nothing, as `updateSettingsOverrides`, `updateEnvironmentSettings` and `updateGlobalContainerSettings` take it.

/** Whether two values are the same, as JSON. */
export const sameJson = <V>(left: V, right: V): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** A change to some settings: the fields `set` holds set, and those `reset` names reset. */
export type Patch<Set> = {
  readonly set?: Set;
  readonly reset?: ReadonlyArray<string>;
};

/** The patch that sets `set` and resets `reset`, each left out when it holds nothing. */
export const patchOf = <Set extends object>(set: Set, reset: ReadonlyArray<string>): Patch<Set> => {
  const patch: { -readonly [K in keyof Patch<Set>]: Patch<Set>[K] } = {};

  // `Set` is an object type with optional keys, no `Record` to Effect's helpers.
  // @effect-diagnostics-next-line preferEffectRecord:off
  if (Object.keys(set).length > 0) patch.set = set;

  if (reset.length > 0) patch.reset = reset;

  return patch;
};
