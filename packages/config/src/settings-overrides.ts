// An Environment's Settings Overrides (ADR-0027, `docs/architecture/overview.md` → Settings): exactly the fields the owner
// or the agent set on purpose for the Environment, even one equal to the Global value, kept until a reset removes it.
// They are the deep partial shape of the Global document, read field by field: a Role is one field (its model and hint
// as one value), an extension's option is one (`extensions.<extension>.<key>`), and every other setting is one by
// itself (`model`, `compaction.enabled`, `tools.offered`, `spendLimit.perSession`), replaced whole. An Environment's
// settings are its Overrides over Global over the defaults. The Instructions are no Override (`INSTRUCTIONS_ROOT`):
// they add up, Global's then the Environment's, so the Overrides do not hold them.
// @effect-diagnostics missingPipeableSignature:off
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import { isJsonObject } from "./json.ts";
import {
  isMcpFullEntry,
  MCP_ROOT,
  MCP_ADJUSTMENT_KEYS,
  mcpFieldPath,
  parseMcpField,
  type McpSettingsProblem,
  mcpServersOf,
  mcpSettingsProblems,
  mcpShadowedTwins,
  withMcpAdjustmentsFitted,
  withMcpLayerRead,
} from "./mcp-servers.ts";
import { type Patch, patchOf, sameJson } from "./patch.ts";
import { problemLines } from "./schema-problems.ts";
import {
  DEFAULT_SETTINGS,
  decodeSettingsLayer,
  overridesFrom,
  resolveLeniently,
  type Settings,
  SettingsError,
  settingsFieldValue,
  type SettingsProblem,
  withRenamedTools,
} from "./settings.ts";

/**
 * The Instructions' setting, which adds up rather than being overridden (ADR-0027): the model is shown Global's, then
 * the Environment's. It is no Override field, an Environment's Overrides may not hold it, and an Environment's settings
 * carry Global's value of it. An Environment's own Instructions are kept apart, beside its Overrides (`docs/architecture/
 * overview.md` → Settings).
 */
export const INSTRUCTIONS_ROOT = "instructions";

/** Why Overrides that hold the Instructions are refused. */
const INSTRUCTIONS_OVERRIDE_PROBLEM = `${INSTRUCTIONS_ROOT}: not an Override: an Environment's Instructions add to the Global ones, and are saved on their own`;

const SETTINGS_ROOTS: ReadonlySet<string> = new Set(
  Arr.filter(Record.keys(DEFAULT_SETTINGS), (root) => root !== INSTRUCTIONS_ROOT),
);

/** Whether `overrides` hold the Instructions. */
const holdsInstructions = (overrides: Schema.Json | undefined): boolean =>
  isJsonObject(overrides) && Predicate.hasProperty(overrides, INSTRUCTIONS_ROOT);

/** The defaults below a setting's root: an object for a section (`roles`, `compaction`), anything else for a value. */
const defaultsOf = (root: string): Settings[keyof Settings] | undefined =>
  Option.getOrUndefined(
    Option.map(
      Arr.findFirst(Record.toEntries(DEFAULT_SETTINGS), ([key]) => key === root),
      ([, defaults]) => defaults,
    ),
  );

/** `value` with `entries` given, each replacing what it held at its key. */
const withEntries = (
  value: Schema.JsonObject,
  entries: ReadonlyArray<readonly [string, Schema.Json]>,
): Schema.JsonObject => Record.fromEntries([...Record.toEntries(value), ...entries]);

/** Whether `value` is an MCP server adjustment: an object that is no full entry. */
const isAdjustment = (value: Schema.Json | undefined): boolean =>
  isJsonObject(value) && !isMcpFullEntry(value);

/**
 * Whether the keys `keys` lead to one Override field, given the `value` there: an extension's option is three keys
 * deep, a Role or a compaction setting two, a setting that is a value itself one, and an MCP server's entry three
 * (`mcp.servers.<name>`), unless it is an adjustment, whose `enabled`, `exposure` and `toolExposure` are each a field
 * at four (`docs/architecture/mcp-configuration.md` → Scopes, adjustments and the set).
 */
const isFieldAt = (keys: ReadonlyArray<string>, value: Schema.Json | undefined): boolean => {
  const [root, second] = keys;

  if (root === "extensions") return keys.length >= 3;

  if (root === MCP_ROOT) {
    if (second !== "servers") return keys.length >= 2;

    return keys.length >= 4 || (keys.length === 3 && !isAdjustment(value));
  }

  const defaults = root === undefined ? undefined : defaultsOf(root);

  return keys.length >= (Predicate.isObject(defaults) && !Arr.isArray(defaults) ? 2 : 1);
};

/**
 * The Override fields, as `settings_reset` lists them: each setting that is a value, each one below a section (a Role,
 * a compaction setting, `tools.offered`), and each extension's option as a pattern.
 */
export const OVERRIDE_FIELD_NAMES: ReadonlyArray<string> = Arr.flatMap(
  Record.toEntries(DEFAULT_SETTINGS),
  ([root, defaults]) => {
    if (root === INSTRUCTIONS_ROOT) return [];

    if (root === "extensions") return ["extensions.<extension>.<key>"];

    if (root === MCP_ROOT) {
      return [
        "mcp.servers.<name>",
        ...Arr.map(MCP_ADJUSTMENT_KEYS, (key) => `mcp.servers.<name>.${key}`),
      ];
    }

    // SAFETY: a setting of two keys is a section, whose defaults are a plain object of its settings by name.
    const section = defaults as Readonly<Record<string, unknown>>;

    return isFieldAt([root], undefined)
      ? [root]
      : Arr.map(Record.keys(section), (key) => `${root}.${key}`);
  },
);

/**
 * Whether giving Override field `field` the value `value` resets it rather than overriding it: null takes an extension's
 * option away (and an extension's options, given for the extension), so at an Environment it inherits again; and null
 * takes the `enabled`, `exposure` or `toolExposure` of an MCP server away: an adjustment's key is reset, and the key of
 * an Environment's own entry is dropped from it (the key it did not have).
 */
export const resetsOverride = (field: string, value: Schema.Json | null): boolean =>
  value === null && (field.startsWith("extensions.") || isMcpKeyField(field));

/** Whether `field` is one of an MCP server's keys an adjustment may hold: `mcp.servers.<name>.enabled|exposure|toolExposure`. */
const isMcpKeyField = (field: string): boolean => {
  const parsed = parseMcpField(field);

  return parsed !== null && parsed.key !== null;
};

/**
 * Whether Environment Overrides `overrides` leave `field` to be inherited: they hold no Override of it. An MCP server's key
 * inside the Environment's own full entry is never inherited (the entry replaces Global's whole), whether or not it is
 * written there, so a key an own entry does not write reads as its default, not as Global's
 * (`docs/architecture/mcp-configuration.md` → Records and revert).
 */
export const overrideInherited = (overrides: Schema.Json, field: string): boolean => {
  const keys = overrideFieldPath(field);

  if (keys !== undefined && isMcpKeyField(field)) {
    const entry = valueAt(overrides, keys.slice(0, 3));

    if (isJsonObject(entry) && isMcpFullEntry(entry)) return false;
  }

  return Option.isNone(overrideValue(overrides, field));
};

/**
 * The keys of Override field `field` (`model`, `roles.small`, `compaction.enabled`, `extensions.<extension>.<key>`, whose
 * key may hold dots, `mcp.servers.<name>` and its `enabled`, `exposure` and `toolExposure`), or undefined for a path that is not one: a setting the settings do not have, a part of a Role, a
 * whole section.
 */
export const overrideFieldPath = (field: string): ReadonlyArray<string> | undefined => {
  const parts = field.split(".");
  const [root, second, ...rest] = parts;

  if (root === undefined || !SETTINGS_ROOTS.has(root) || Arr.some(parts, (part) => part === "")) {
    return undefined;
  }

  if (root === "extensions") {
    return second === undefined || rest.length === 0
      ? undefined
      : [root, second, Arr.join(rest, ".")];
  }

  if (root === MCP_ROOT) return mcpFieldPath(parts);

  if (parts.length !== (isFieldAt([root], undefined) ? 1 : 2)) return undefined;

  return second === undefined || Predicate.hasProperty(defaultsOf(root), second)
    ? parts
    : undefined;
};

type OverrideEntry = { readonly keys: ReadonlyArray<string>; readonly value: Schema.Json };

const entriesBelow = (
  value: Schema.Json,
  keys: ReadonlyArray<string>,
): ReadonlyArray<OverrideEntry> =>
  isFieldAt(keys, value) || !isJsonObject(value)
    ? [{ keys, value }]
    : Arr.flatMap(Record.toEntries(value), ([key, entry]) => entriesBelow(entry, [...keys, key]));

/** Each field `overrides` hold, with its keys and its value, in the order they hold them; none that adds up. */
const overrideEntries = (overrides: Schema.Json): ReadonlyArray<OverrideEntry> =>
  isJsonObject(overrides)
    ? Arr.flatMap(Record.toEntries(overrides), ([root, value]) =>
        root === INSTRUCTIONS_ROOT ? [] : entriesBelow(value, [root]),
      )
    : [];

/** The fields an Environment's `overrides` override, as dotted paths (`overrideFieldPath`). */
export const overrideFields = (overrides: Schema.Json): ReadonlyArray<string> =>
  Arr.map(overrideEntries(overrides), ({ keys }) => Arr.join(keys, "."));

/** The Override `overrides` hold at `field`; none where the field inherits. An Override may be null (no spend limit). */
export const overrideValue = (
  overrides: Schema.Json,
  field: string,
): Option.Option<Schema.Json> => {
  const keys = overrideFieldPath(field);

  if (keys === undefined) return Option.none();

  let found: Schema.Json | undefined = overrides;

  for (const key of keys) {
    found = isJsonObject(found) ? found[key] : undefined;
  }

  return Option.fromUndefinedOr(found);
};

/** `value` with `leaf` at `keys`, objects made on the way. A null leaf is kept: it is an Override of nothing. */
const setAt = (
  value: Schema.JsonObject,
  keys: ReadonlyArray<string>,
  leaf: Schema.Json,
): Schema.JsonObject => {
  const [head, ...rest] = keys;

  if (head === undefined) return value;

  if (rest.length === 0) return withEntries(value, [[head, leaf]]);

  const held = value[head];

  return withEntries(value, [[head, setAt(isJsonObject(held) ? held : {}, rest, leaf)]]);
};

/** `value` without what lies at `keys`, and without an object that is left empty by it. */
const removeAt = (value: Schema.JsonObject, keys: ReadonlyArray<string>): Schema.JsonObject => {
  const [head, ...rest] = keys;

  if (head === undefined || value[head] === undefined) return value;

  const { [head]: held, ...others } = value;

  if (rest.length === 0 || !isJsonObject(held)) return rest.length === 0 ? others : value;

  const inner = removeAt(held, rest);

  return Record.isEmptyRecord(inner) ? others : { ...others, [head]: inner };
};

/** `base` with each field of `overrides` replaced by its Override. */
const overriding = (base: Schema.JsonObject, overrides: Schema.Json): Schema.JsonObject =>
  Arr.reduce(overrideEntries(overrides), base, (merged, { keys, value }) =>
    setAt(merged, keys, value),
  );

/**
 * The Overrides `overrides` become with `set` (a deep partial of the settings) given field by field, and the fields of
 * `reset` removed, so they inherit again. A Role set in part is completed from the Role in force (`current`, the
 * Environment's settings now), since a Role is one field; an extension's option set to null is reset (null takes an
 * option away), and so is each option of an extension set to null (`resetsOverride`). Refused for a `reset` that names
 * no field, or a `set` that is not an object; the strict resolution of the result says whether its values are valid.
 */
export const withOverrides = (
  overrides: Schema.Json,
  {
    set,
    reset = [],
  }: { readonly set?: Schema.Json | undefined; readonly reset?: ReadonlyArray<string> | undefined },
  current: Settings,
): Result.Result<Schema.Json, SettingsError> => {
  if (set !== undefined && !isJsonObject(set)) {
    return Result.fail(SettingsError.make({ message: "The Overrides to set are not an object" }));
  }

  if (holdsInstructions(set)) {
    return Result.fail(SettingsError.make({ message: INSTRUCTIONS_OVERRIDE_PROBLEM }));
  }

  const unknown = Arr.findFirst(reset, (field) => overrideFieldPath(field) === undefined);

  if (Option.isSome(unknown)) {
    return Result.fail(
      SettingsError.make({
        message: `${unknown.value}: not a setting an Environment overrides`,
      }),
    );
  }

  const changed = Arr.reduce(
    overrideEntries(set ?? {}),
    isJsonObject(overrides) ? overrides : {},
    (next, { keys, value }) => {
      const [root, name] = keys;

      if (resetsOverride(Arr.join(keys, "."), value)) return removeAt(next, keys);

      if (root === "roles" && name !== undefined && keys.length === 2 && isJsonObject(value)) {
        const role = settingsFieldValue(current, `roles.${name}`) ?? {};

        return setAt(
          next,
          keys,
          isJsonObject(role) ? withEntries(role, Record.toEntries(value)) : value,
        );
      }

      return setAt(next, keys, value);
    },
  );

  return Result.succeed(
    Arr.reduce(reset, changed, (next, field) => removeAt(next, overrideFieldPath(field) ?? [])),
  );
};

/** One field of an Environment's Overrides changed: given `value`, or reset to inherit. */
export type OverrideFieldChange =
  | { readonly field: string; readonly value: Schema.Json }
  | { readonly field: string; readonly reset: true };

/** `withOverrides` for changes given field by field (`overrideFieldPath`), as the agent's tools give them. */
export const withOverrideFields = (
  overrides: Schema.Json,
  changes: ReadonlyArray<OverrideFieldChange>,
  current: Settings,
): Result.Result<Schema.Json, SettingsError> => {
  const unknown = Arr.findFirst(changes, ({ field }) => overrideFieldPath(field) === undefined);

  if (Option.isSome(unknown)) {
    return Result.fail(
      SettingsError.make({
        message: `${unknown.value.field}: not a setting an Environment overrides`,
      }),
    );
  }

  return withOverrides(
    overrides,
    {
      set: Arr.reduce(changes, {}, (set: Schema.JsonObject, change) =>
        "reset" in change ? set : setAt(set, overrideFieldPath(change.field) ?? [], change.value),
      ),
      reset: Arr.filterMap(changes, (change) =>
        "reset" in change ? Result.succeed(change.field) : Result.failVoid,
      ),
    },
    current,
  );
};

/** A change to an Environment's Overrides, as `updateSettingsOverrides` takes it. */
export type OverridesPatch = Patch<Schema.JsonObject>;

/**
 * The change that makes an Environment's Overrides `before` into `after`: each field `after` holds that `before` does
 * not, or holds otherwise, set (a Role whole), and each field only `before` holds reset, so it inherits again. A field
 * both hold alike is left out, so a save of it keeps what the agent did to the others meanwhile.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a diff of two values, not a combinator.
export const overridesPatchBetween = (before: Schema.Json, after: Schema.Json): OverridesPatch => {
  const was = new Map(
    Arr.map(overrideEntries(before), ({ keys, value }) => [Arr.join(keys, "."), value] as const),
  );

  const set = Arr.reduce(overrideEntries(after), {}, (next: Schema.JsonObject, { keys, value }) => {
    const held = was.get(Arr.join(keys, "."));

    return held !== undefined && sameJson(held, value) ? next : setAt(next, keys, value);
  });

  const kept = new Set(overrideFields(after));
  const reset = Arr.filter([...was.keys()], (field) => !kept.has(field));

  return patchOf(set, reset);
};

/** Global's overrides as they apply: those that resolve, and only what differs from the defaults. */
const globalApplied = (global: Schema.Json) => {
  const { settings } = resolveLeniently(global);

  // SAFETY: `overridesFrom` answers the encoded deep partial of the settings: always a JSON object.
  return { settings, overrides: overridesFrom(settings) as Schema.JsonObject };
};

const NOT_AN_OBJECT = "The Environment's Overrides are not an object";

/**
 * The settings of an Environment whose Overrides are `overrides`, over `global` (the Global document as saved, read as
 * the Sessions read it), or why the Overrides are not valid. This is what a save checks.
 */
export const resolveOverrides = (
  global: Schema.Json,
  overrides: Schema.Json,
): Result.Result<Settings, SettingsError> => {
  if (!isJsonObject(overrides)) return Result.fail(SettingsError.make({ message: NOT_AN_OBJECT }));

  if (holdsInstructions(overrides)) {
    return Result.fail(SettingsError.make({ message: INSTRUCTIONS_OVERRIDE_PROBLEM }));
  }

  const renamed = withRenamedTools(overrides);

  return Result.mapError(
    decodeSettingsLayer(
      overriding(globalApplied(global).overrides, renamed),
      renamed,
      "environment",
    ),
    (problems) => SettingsError.make({ message: problemLines(problems) }),
  );
};

/** An Environment's settings resolved from Overrides that may be partly stale, and what was left out to do it. */
export type LenientOverrides = {
  readonly settings: Settings;
  /** The Global settings it inherits from. */
  readonly global: Settings;
  /** The Overrides that applied: those that resolve, renamed tools under their new names. */
  readonly overrides: Schema.JsonObject;
  /** One line per Override dropped: empty when every one resolved. */
  readonly dropped: ReadonlyArray<string>;
  /** The problems among them that lie in an MCP server's entry, structured, each in the layer it is in. */
  readonly mcpProblems: ReadonlyArray<McpSettingsProblem>;
};

/**
 * How many times a lenient read decodes again after dropping the fields with problems before it gives up on the
 * Overrides whole: each round drops every field the decode named, so more rounds only follow problems one hides.
 */
const MAX_LENIENT_ROUNDS = 8;

/** The value of `document` at `keys`; none where there is nothing. */
const valueAt = (document: Schema.Json, keys: ReadonlyArray<string>): Schema.Json | undefined => {
  let held: Schema.Json | undefined = document;

  for (const key of keys) {
    held = isJsonObject(held) ? held[key] : undefined;
  }

  return held;
};

/**
 * The keys of the field a problem lies in, in `overrides`: a problem with a Role's model drops the Role, one with an
 * MCP server's entry drops the entry, and one with a key of an adjustment drops that key.
 */
const fieldKeysOf = (overrides: Schema.Json, problem: SettingsProblem): ReadonlyArray<string> => {
  for (let length = 1; length <= problem.keys.length; length += 1) {
    const keys = Arr.take(problem.keys, length);

    if (isFieldAt(keys, valueAt(overrides, keys))) return keys;
  }

  return problem.keys;
};

/** Global's overrides without what an Environment's twin shadows, and a line for each. */
type InheritedWithoutTwins = {
  readonly overrides: Schema.JsonObject;
  readonly dropped: ReadonlyArray<string>;
  /** The Global servers left out, structured: each is a problem of Global's. */
  readonly problems: ReadonlyArray<SettingsProblem>;
};

/**
 * `inherited` (Global's overrides as they apply) without the MCP servers an Environment's own entry shadows by a twin
 * name, which differs from it only in case or in `-`/`_`: the Environment has the last word, as `resolveMcpServerSet`
 * has it, so a stale clash leaves the settings and the set of one mind. A save refuses such a clash instead
 * (`resolveOverrides`). `dropped` says which of Global's it left out.
 */
const withoutShadowedTwins = (
  inherited: Schema.JsonObject,
  overrides: Schema.JsonObject,
): InheritedWithoutTwins => {
  const own = mcpServersOf(overrides);
  const global = mcpServersOf(inherited);

  if (!isJsonObject(own) || !isJsonObject(global)) {
    return { overrides: inherited, dropped: [], problems: [] };
  }

  const fullNames = (servers: Schema.JsonObject) =>
    Arr.filterMap(Record.toEntries(servers), ([name, value]) =>
      isJsonObject(value) && isMcpFullEntry(value) ? Result.succeed(name) : Result.failVoid,
    );

  const shadowed = mcpShadowedTwins(fullNames(global), fullNames(own));

  return {
    overrides: Arr.reduce(shadowed, inherited, (left, { global: name }) =>
      removeAt(left, [MCP_ROOT, "servers", name]),
    ),
    dropped: Arr.map(shadowed, ({ global: name, text }) => `${MCP_ROOT}.servers.${name}: ${text}`),
    problems: Arr.map(shadowed, ({ global: name, text }) => ({
      keys: [MCP_ROOT, "servers", name],
      line: `${MCP_ROOT}.servers.${name}: ${text}`,
    })),
  };
};

/**
 * The settings an Environment's `overrides` give over `global` once every Override that does not resolve is dropped: a
 * value a release no longer takes costs only its own field, which then follows Global. Global's own stale overrides
 * are dropped as `resolveLeniently` drops them, and are Global's to report. An Environment with no Overrides resolves
 * as Global does.
 */
export const resolveOverridesLeniently = (
  global: Schema.Json,
  overrides: Schema.Json,
): LenientOverrides => {
  const inherited = globalApplied(global);
  const dropped: string[] = isJsonObject(overrides) ? [] : [NOT_AN_OBJECT];
  const found: SettingsProblem[] = [];
  const renamed = withRenamedTools(overrides);
  let rest: Schema.JsonObject = isJsonObject(renamed) ? renamed : {};

  if (holdsInstructions(rest)) {
    dropped.push(INSTRUCTIONS_OVERRIDE_PROBLEM);
    rest = removeAt(rest, [INSTRUCTIONS_ROOT]);
  }

  // The MCP servers are read as the MCP server set reads them (`readMcpLayer`): an entry, and a key of an adjustment, at a time.
  const read = withMcpLayerRead(rest, "environment");

  rest = read.document;

  for (const problem of read.problems) {
    dropped.push(problem.line);
    found.push(problem);
  }

  // An adjustment is held to the entry bound over the Global server it adjusts, key by key, as the set holds it.
  const fitted = withMcpAdjustmentsFitted(inherited.overrides, rest);

  rest = fitted.document;

  for (const problem of fitted.problems) {
    dropped.push(problem.line);
    found.push(problem);
  }

  // Dropping a field settles its problem; a few rounds cover Overrides with several.
  for (let round = 0; round < MAX_LENIENT_ROUNDS; round += 1) {
    const base = withoutShadowedTwins(inherited.overrides, rest);
    const result = decodeSettingsLayer(overriding(base.overrides, rest), rest, "environment");

    if (Result.isSuccess(result)) {
      return {
        settings: result.success,
        global: inherited.settings,
        overrides: rest,
        dropped: [...dropped, ...base.dropped],
        mcpProblems: [
          ...mcpSettingsProblems(found, "environment"),
          ...mcpSettingsProblems(base.problems, "global"),
        ],
      };
    }

    const problems = result.failure;

    for (const problem of problems) {
      dropped.push(problem.line);
      found.push(problem);
    }

    if (Arr.some(problems, (problem) => problem.keys.length === 0)) break;

    const given = rest;

    rest = Arr.reduce(problems, rest, (left, problem) =>
      removeAt(left, fieldKeysOf(given, problem)),
    );
  }

  return {
    settings: inherited.settings,
    global: inherited.settings,
    overrides: {},
    dropped,
    mcpProblems: mcpSettingsProblems(found, "environment"),
  };
};
