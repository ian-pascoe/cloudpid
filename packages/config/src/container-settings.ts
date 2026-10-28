// An Environment's Container settings (`docs/architecture/container.md` → Container settings): the Container's
// instance size, how long it may sit unused before its Workspace stops it, the paths it keeps to itself on top of the
// built-in ones, the variables every command gets, the Environment's own Setup and Start Scripts, and its Toolchains (a
// mise.toml), and whether it keeps a Spare Workspace. Like the global settings, every field has a decoding default, so
// decoding the saved overrides gives the resolved settings and the schema's `Encoded` side is the overrides' shape. The
// Registry keeps them per Environment, and each Workspace DO holds a copy, which it reads at each Container launch.
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

/**
 * The sizes a Container may start on under the `durable_object` scheduling policy, as the names kept in an
 * Environment's settings. Cloudflare's named instance types are stored under their own names; the others are custom sizes
 * (`{ vcpu, memoryMib, diskMb }` in `ctx.container.start`), mapped to their resources by `containerInstance` at each
 * launch, in two families named by what they are built around: `cpu-<vCPU>`, the most vCPU Cloudflare allows for its
 * memory, and `mem-<GiB>`, more memory for few vCPU. A stored name never changes meaning, so a new custom size gets a
 * new name; a renamed one keeps its old name readable (`RENAMED_INSTANCE_TYPES`). Smallest first, by `compareInstances`.
 */
export const INSTANCE_TYPES = [
  "lite",
  "basic",
  "cpu-1",
  "standard-1",
  "mem-4",
  "standard-2",
  "cpu-2",
  "mem-8",
  "standard-3",
  "cpu-3",
  "mem-12",
  "standard-4",
] as const;

export const InstanceType = Schema.Literals(INSTANCE_TYPES);

export type InstanceType = typeof InstanceType.Type;

/**
 * The names sizes were stored under before they were renamed, and the name each has now (the resources are the same):
 * the `custom-<vCPU>` sizes became `cpu-<vCPU>`. Saved settings, launch records, resizes, usage and Agent changes may
 * still hold an old name, so every read of a stored size takes it through `currentInstanceName`.
 */
export const RENAMED_INSTANCE_TYPES = {
  "custom-1": "cpu-1",
  "custom-2": "cpu-2",
  "custom-3": "cpu-3",
} as const satisfies Readonly<Record<string, InstanceType>>;

const RenamedInstanceType = Schema.Literals(Record.keys(RENAMED_INSTANCE_TYPES));

/** The old name of a renamed size. */
export type RenamedInstanceType = typeof RenamedInstanceType.Type;

/** A size name as storage may hold it: a name of today, or the old name of a renamed size. */
export type StoredInstanceType = InstanceType | RenamedInstanceType;

/** Whether `value` is the old name of a renamed size. */
export const isRenamedInstance = Schema.is(RenamedInstanceType);

/** The name the size stored as `name` has now: a renamed size's new name, any other as it is. */
export const currentInstanceName = (name: StoredInstanceType): InstanceType =>
  isRenamedInstance(name) ? RENAMED_INSTANCE_TYPES[name] : name;

/** The settings fields that hold a size name. */
const isInstanceField = Schema.is(Schema.Literals(["instance", "maxInstance"]));

/**
 * `value`, the stored value of the settings field `field` (an Agent change's before or after, the value an Approval
 * was asked against), with a renamed size's old name as its new one; anything else as it is.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a plain mapping of one stored value, not a combinator.
export const currentFieldValue = (field: string, value: Schema.Json): Schema.Json =>
  isInstanceField(field) && isRenamedInstance(value) ? currentInstanceName(value) : value;

/** What a Container is started with when it is not one of Cloudflare's named instance types. */
export type ContainerResources = {
  readonly vcpu: number;
  readonly memoryMib: number;
  readonly diskMb: number;
};

/**
 * The custom sizes, by stored name. Cloudflare bills CPU only for active use, and memory and disk for as long as the
 * Container runs, so memory is what a running Container costs. A custom size needs 1 to 4 vCPU, at most 12 GiB of
 * memory and at least 3 GiB of it per vCPU, and at most 20 GB of disk (Cloudflare's Containers limits page).
 *
 * - `cpu-<vCPU>` has 3 GiB per vCPU, the least memory its vCPU allow: `cpu-1` (the default) has `standard-2`'s vCPU with
 *   half its memory, `cpu-2` has `standard-2`'s memory with twice its vCPU, and `cpu-3` sits between `standard-3` and
 *   `standard-4`. No `cpu-4`: it would be `standard-4` with less disk.
 * - `mem-<GiB>` has more memory per vCPU, for work that needs memory more than cores (a single-threaded `tsc`, a tool
 *   that starts a worker per core): `mem-4` is `cpu-1` with a GiB more, `mem-8` has `standard-3`'s memory on 1 vCPU,
 *   and `mem-12` has `standard-4`'s on 2. No 6 GiB one: on 1 vCPU it would be `standard-2`.
 *
 * All keep `standard-2`'s 12 GB disk, which costs little, so a snapshot or Build taken on one restores on the others.
 */
const CUSTOM_INSTANCES = {
  "cpu-1": { vcpu: 1, memoryMib: 3072, diskMb: 12_000 },
  "mem-4": { vcpu: 1, memoryMib: 4096, diskMb: 12_000 },
  "cpu-2": { vcpu: 2, memoryMib: 6144, diskMb: 12_000 },
  "mem-8": { vcpu: 1, memoryMib: 8192, diskMb: 12_000 },
  "cpu-3": { vcpu: 3, memoryMib: 9216, diskMb: 12_000 },
  "mem-12": { vcpu: 2, memoryMib: 12_288, diskMb: 12_000 },
} as const satisfies Partial<Record<InstanceType, ContainerResources>>;

type CustomInstanceType = keyof typeof CUSTOM_INSTANCES;

/** The instance types that are Cloudflare's own names. */
export type NamedInstanceType = Exclude<InstanceType, CustomInstanceType>;

const isCustomInstance = (type: InstanceType): type is CustomInstanceType =>
  type in CUSTOM_INSTANCES;

/** What `ctx.container.start({ instance })` takes for the stored `type`: a named type as it is, a custom size as its resources. */
export const containerInstance = (type: InstanceType): NamedInstanceType | ContainerResources =>
  isCustomInstance(type) ? CUSTOM_INSTANCES[type] : type;

/** The resources of every size: Cloudflare's limits page for its named types, `containerInstance`'s for the custom ones. */
export const INSTANCE_RESOURCES: Readonly<Record<InstanceType, ContainerResources>> = {
  lite: { vcpu: 1 / 16, memoryMib: 256, diskMb: 2_000 },
  basic: { vcpu: 1 / 4, memoryMib: 1024, diskMb: 4_000 },
  "standard-1": { vcpu: 1 / 2, memoryMib: 4096, diskMb: 8_000 },
  "cpu-1": CUSTOM_INSTANCES["cpu-1"],
  "mem-4": CUSTOM_INSTANCES["mem-4"],
  "standard-2": { vcpu: 1, memoryMib: 6144, diskMb: 12_000 },
  "cpu-2": CUSTOM_INSTANCES["cpu-2"],
  "mem-8": CUSTOM_INSTANCES["mem-8"],
  "standard-3": { vcpu: 2, memoryMib: 8192, diskMb: 16_000 },
  "cpu-3": CUSTOM_INSTANCES["cpu-3"],
  "mem-12": CUSTOM_INSTANCES["mem-12"],
  "standard-4": { vcpu: 4, memoryMib: 12_288, diskMb: 20_000 },
};

/**
 * How size `left` compares with size `right`, for a sort and the size limit: by memory, then by vCPU (negative when
 * `left` is smaller). Memory first, since it is what a running Container costs and what a command runs out of.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a comparator for `Array.sort`, not a combinator.
export const compareInstances = (left: InstanceType, right: InstanceType): -1 | 0 | 1 => {
  const a = INSTANCE_RESOURCES[left];
  const b = INSTANCE_RESOURCES[right];
  const difference = a.memoryMib - b.memoryMib || a.vcpu - b.vcpu;

  return difference < 0 ? -1 : difference > 0 ? 1 : 0;
};

/**
 * Why an Environment cannot have the size `instance` under its size limit `maxInstance` (a Limit: the agent raises it
 * only with the owner's Approval), or undefined when it can. A save of the settings is refused for it.
 */
export const instanceLimitProblem = ({
  instance,
  maxInstance,
}: {
  readonly instance: InstanceType;
  readonly maxInstance: InstanceType;
}): string | undefined =>
  compareInstances(instance, maxInstance) > 0
    ? `The size ${instance} is larger than the size limit ${maxInstance}: raise the limit to ${instance} or more, or pick a size up to ${maxInstance}`
    : undefined;

const describeResources = ({ vcpu, memoryMib, diskMb }: ContainerResources): string =>
  `${vcpu} vCPU, ${memoryMib / 1024} GiB memory, ${diskMb / 1000} GB disk`;

/** What each size offers, for the settings form to show: Cloudflare's Containers limits page for its named types, the resources for the custom ones. */
export const INSTANCE_DESCRIPTIONS: Readonly<Record<InstanceType, string>> = {
  lite: "1/16 vCPU, 256 MiB memory, 2 GB disk",
  basic: "1/4 vCPU, 1 GiB memory, 4 GB disk",
  "standard-1": "1/2 vCPU, 4 GiB memory, 8 GB disk",
  "cpu-1": describeResources(CUSTOM_INSTANCES["cpu-1"]),
  "mem-4": describeResources(CUSTOM_INSTANCES["mem-4"]),
  "standard-2": "1 vCPU, 6 GiB memory, 12 GB disk",
  "cpu-2": describeResources(CUSTOM_INSTANCES["cpu-2"]),
  "mem-8": describeResources(CUSTOM_INSTANCES["mem-8"]),
  "standard-3": "2 vCPU, 8 GiB memory, 16 GB disk",
  "cpu-3": describeResources(CUSTOM_INSTANCES["cpu-3"]),
  "mem-12": describeResources(CUSTOM_INSTANCES["mem-12"]),
  "standard-4": "4 vCPU, 12 GiB memory, 20 GB disk",
};

/** The longest idle time: a day. */
export const MAX_IDLE_MINUTES = 24 * 60;

const IdleMinutes = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(MAX_IDLE_MINUTES),
);

/** The most extra Container-only paths an Environment may have. */
export const MAX_IGNORE_PATTERNS = 50;

/** The longest extra Container-only path. */
const MAX_IGNORE_PATTERN_LENGTH = 255;

/**
 * Why `pattern` cannot be an extra Container-only path, or undefined when it can: the rules of `@cloudflare/computer`
 * 0.6.0's `ignore` (`checkIgnorePatterns`), which refuses a bad pattern when the Container backend is built, and so
 * would keep the Container from starting. A pattern starts with `/` (from the mount's root) or with `**` and a slash
 * (at any depth), may start with `!` to keep a path synced again, and has only `*` and `**` (a whole segment) as wildcards.
 */
export const ignorePatternProblem = (pattern: string): string | undefined => {
  if (pattern.trim() !== pattern) return "has spaces around it";

  if (pattern.length > MAX_IGNORE_PATTERN_LENGTH) {
    return `is longer than ${MAX_IGNORE_PATTERN_LENGTH} characters`;
  }

  const body = pattern.startsWith("!") ? pattern.slice(1) : pattern;

  if (!body.startsWith("/") && !body.startsWith("**/")) {
    return 'must start with "/" (from /workspace) or "**/" (at any depth)';
  }

  if (/[{}[\]?\\]/.test(body)) return 'uses syntax that is not supported: only "*" and "**"';

  if (body.includes(",")) return "contains a comma";

  // computer reads a path under its mount point as one from the mount's root, so `/workspace/data` would be `/data`.
  if (body === "/workspace" || body.startsWith("/workspace/")) {
    return 'starts at /workspace already: write "/data" for /workspace/data';
  }

  const trimmed = body.replace(/^\/+|\/+$/g, "");
  const parts = trimmed === "" ? [] : trimmed.split("/");

  if (parts.includes("")) return "contains an empty path segment";

  if (Arr.some(parts, (part) => part === "." || part === ".."))
    return 'contains a "." or ".." segment';

  if (Arr.some(parts, (part) => part !== "**" && part.includes("**"))) {
    return 'uses "**" inside a segment: it must be a whole one';
  }

  if (Arr.every(parts, (part) => part === "**" || part === "*")) {
    return "would keep the whole Workspace on the Container";
  }

  return undefined;
};

const IgnorePattern = Schema.String.check(
  Schema.makeFilter((pattern: string) => {
    const problem = ignorePatternProblem(pattern);

    return problem === undefined ? undefined : `${JSON.stringify(pattern)} ${problem}`;
  }),
);

/** The most variables an Environment may have. */
export const MAX_VARIABLES = 50;

/** The longest variable name. */
const MAX_VARIABLE_NAME_LENGTH = 128;

/** The longest variable value. */
export const MAX_VARIABLE_VALUE_LENGTH = 4096;

/**
 * The names a variable may not have: what the Container sets for every command itself (`toolchainEnv` in
 * `@cloudpid/sandbox-image/toolchains`, which this package cannot import: a test there checks each of its names is here,
 * and what computerd starts a command with),
 * which a variable would otherwise override, and `CLOUDPID_`'s prefix, which is cloudpid's own.
 */
const RESERVED_VARIABLES: ReadonlySet<string> = new Set([
  "MISE_GLOBAL_CONFIG_FILE",
  "MISE_TRUSTED_CONFIG_PATHS",
  "MISE_YES",
  "GIT_TERMINAL_PROMPT",
  "TURBO_CACHE_DIR",
  "BASH_ENV",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "PATH",
  "HOME",
  "PWD",
  "SHELL",
  "USER",
]);

const RESERVED_PREFIX = "CLOUDPID_";

/** Why `name` cannot be a variable's, or undefined when it can: a name a shell can export, and not one the Container sets. */
export const variableNameProblem = (name: string): string | undefined => {
  if (name === "") return "is empty";

  if (name.length > MAX_VARIABLE_NAME_LENGTH) {
    return `is longer than ${MAX_VARIABLE_NAME_LENGTH} characters`;
  }

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return "must be letters, digits and _, and not start with a digit";
  }

  if (RESERVED_VARIABLES.has(name)) return "is reserved: the Container sets it itself";

  if (name.startsWith(RESERVED_PREFIX))
    return `is reserved: ${RESERVED_PREFIX} names are cloudpid's`;

  return undefined;
};

/**
 * Why the names of `variables` cannot all be variables', one problem per name. A check of the record, not a key
 * schema: a key that fails the record's key schema is reported as an excess property, which would hide why.
 */
const variableNamesProblem = (variables: Readonly<Record<string, string>>): string | undefined => {
  const problems = Arr.flatMap(Record.keys(variables), (name) => {
    const problem = variableNameProblem(name);

    return problem === undefined ? [] : [`${JSON.stringify(name)} ${problem}`];
  });

  return problems.length === 0 ? undefined : Arr.join(problems, "; ");
};

/** Whether `text` has a NUL, which neither an environment variable nor a bash script can hold. */
const hasNul = (text: string): boolean => text.includes("\u0000");

const VariableValue = Schema.String.check(
  Schema.isMaxLength(MAX_VARIABLE_VALUE_LENGTH),
  Schema.makeFilter((value: string) => (hasNul(value) ? "contains a NUL character" : undefined)),
);

/** An Environment's variables, and the ones kept for every Environment (`EveryEnvironmentSettings`): the same rules. */
export const ContainerVariables = Schema.Record(Schema.String, VariableValue).check(
  Schema.isMaxProperties(MAX_VARIABLES),
  Schema.makeFilter(variableNamesProblem),
);

/**
 * The largest Setup or Start Script, in bytes of UTF-8. The bootstrap passes one to the Container base64-encoded in the
 * text of a bash command, and Linux takes one argument of at most 128 KiB.
 */
export const MAX_SCRIPT_BYTES = 64 * 1024;

const utf8 = new TextEncoder();

/** Why `script` cannot be an Environment's Setup or Start Script, or undefined when it can. */
export const scriptProblem = (script: string): string | undefined => {
  if (hasNul(script)) return "contains a NUL character";

  // A character is at most 3 bytes of UTF-8 (a pair of surrogates 4): only a long script needs encoding.
  if (script.length > MAX_SCRIPT_BYTES / 3 && utf8.encode(script).length > MAX_SCRIPT_BYTES) {
    return `is longer than ${MAX_SCRIPT_BYTES / 1024} KiB`;
  }

  return undefined;
};

const Script = Schema.String.check(Schema.makeFilter(scriptProblem));

/**
 * The largest Toolchains setting (a mise.toml), in bytes of UTF-8. The bootstrap passes it to the Container
 * base64-encoded in its own text, beside the rest of the bootstrap.
 */
export const MAX_TOOLCHAINS_BYTES = 16 * 1024;

/** Why `toml` cannot be an Environment's Toolchains (its mise.toml), or undefined when it can. Its TOML is mise's to read. */
export const toolchainsProblem = (toml: string): string | undefined => {
  if (hasNul(toml)) return "contains a NUL character";

  if (toml.length > MAX_TOOLCHAINS_BYTES / 3 && utf8.encode(toml).length > MAX_TOOLCHAINS_BYTES) {
    return `is longer than ${MAX_TOOLCHAINS_BYTES / 1024} KiB`;
  }

  return undefined;
};

const Toolchains = Schema.String.check(Schema.makeFilter(toolchainsProblem));

export const ContainerSettings = Schema.Struct({
  /** The instance type the Container starts on. */
  instance: InstanceType.pipe(Schema.withDecodingDefaultKey(Effect.succeed("cpu-1"))),
  /**
   * The size limit: the largest size the Environment's size may be, and the agent's `container_resize` may restart a
   * Container at, ordered by `compareInstances`. A Limit (GLOSSARY.md). The schema does not check `instance` against it:
   * a save does (`instanceLimitProblem`), and a lenient read raises it to `instance` for an Environment saved before it.
   */
  maxInstance: InstanceType.pipe(Schema.withDecodingDefaultKey(Effect.succeed("cpu-2"))),
  /** Minutes without a command on the Container before it is stopped (a disk snapshot is taken first). */
  idleMinutes: IdleMinutes.pipe(Schema.withDecodingDefaultKey(Effect.succeed(2))),
  /**
   * Paths the Container keeps to itself, out of the Workspace's Durable Object, after the built-in ones (`TOOLCHAIN_IGNORE`), as
   * computer's `ignore` patterns: the last one that matches a path wins, so `!` keeps a built-in one synced.
   */
  ignore: Schema.Array(IgnorePattern)
    .check(Schema.isMaxLength(MAX_IGNORE_PATTERNS))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /**
   * Environment variables every command on the Container gets, and its bootstrap and scripts, under the Container's own
   * (`toolchainEnv`) and what a caller passes. Plain: the agent can read them. A Workspace is handed them merged with
   * the ones kept for every Environment (`withEveryEnvironmentVariables`), so its copy of these settings holds both.
   */
  variables: ContainerVariables.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  /** The Environment's own Setup Script (bash), run in `/workspace` before the repos' when it is due. Empty: none. */
  setupScript: Script.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  /** The Environment's Start Script (bash), run in `/workspace` at each Container start before the repos'. Empty: none. */
  startScript: Script.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  /**
   * The Environment's Toolchains: the text of the `mise.toml` the bootstrap writes as `/workspace/mise.toml` where the
   * Workspace has none, or has the one it last wrote. Empty: the image's base Toolchains (`BASE_MISE_TOML`).
   */
  toolchains: Toolchains.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  /**
   * Whether the Environment keeps a Spare Workspace made ahead (GLOSSARY.md), so a new Session does not wait for the
   * clones and the Setup Scripts. Off: no spare is prepared, the one there is is removed, and a new Session's Workspace
   * is made when it is asked for, which saves the Container time each spare's preparation takes.
   */
  spareWorkspace: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});

export type ContainerSettings = typeof ContainerSettings.Type;

/**
 * The name of the Spare Workspace setting, as an Agent change's field: a change to it keeps or removes the
 * Environment's spare, so the spares' upkeep runs after it.
 */
export const SPARE_WORKSPACE_FIELD = "spareWorkspace" satisfies keyof ContainerSettings;

/** What is stored: the settings that differ from the defaults. */
export type ContainerSettingsOverrides = typeof ContainerSettings.Encoded;

/**
 * The settings kept for every Environment, under each Environment's own (`withEveryEnvironmentVariables`): the
 * variables, for now. A struct so another setting can join them. Like the rest, every field has a decoding default.
 */
export const EveryEnvironmentSettings = Schema.Struct({
  variables: ContainerVariables.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
});

export type EveryEnvironmentSettings = typeof EveryEnvironmentSettings.Type;

/** What is stored: the settings that differ from the defaults. */
export type EveryEnvironmentSettingsOverrides = typeof EveryEnvironmentSettings.Encoded;

export class ContainerSettingsError extends Schema.TaggedError<
  ContainerSettingsError,
  { readonly brand: unique symbol }
>()("ContainerSettingsError", {
  message: Schema.String,
}) {}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

type Problem = { readonly keys: ReadonlyArray<string>; readonly line: string };

const problemsOf = (error: Schema.SchemaError): ReadonlyArray<Problem> =>
  Arr.map(formatIssues(error.issue).issues, (issue) => {
    const keys = Arr.map(issue.path ?? [], (key) =>
      String(Predicate.hasProperty(key, "key") ? key.key : key),
    );

    const path = Arr.join(keys, ".");

    return { keys, line: path === "" ? issue.message : `${path}: ${issue.message}` };
  });

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Arr.isArray(value);

const decodeCurrentOverrides = Schema.decodeUnknownResult(ContainerSettings, {
  onExcessProperty: "error",
  errors: "all",
});

/**
 * `overrides` with a renamed size's old name (`RENAMED_INSTANCE_TYPES`) as its new one, so settings saved before the
 * rename, and an Agent change's value from then that a revert writes back, keep their size.
 */
const withCurrentInstanceNames = (overrides: Schema.Json): Schema.Json =>
  isJsonObject(overrides)
    ? Record.map(overrides, (value, key) => currentFieldValue(key, value))
    : overrides;

const decodeOverrides = (overrides: Schema.Json) =>
  decodeCurrentOverrides(withCurrentInstanceNames(overrides));

const decodeEveryOverrides = Schema.decodeUnknownResult(EveryEnvironmentSettings, {
  onExcessProperty: "error",
  errors: "all",
});

const settingsError = (error: Schema.SchemaError): ContainerSettingsError =>
  ContainerSettingsError.make({
    message: Arr.join(
      Arr.map(problemsOf(error), (problem) => problem.line),
      "\n",
    ),
  });

/** The settings `overrides` give over the defaults, or why they are not valid settings, one problem per line. */
export const resolveContainerSettings = (
  overrides: Schema.Json,
): Result.Result<ContainerSettings, ContainerSettingsError> =>
  Result.mapError(decodeOverrides(overrides), settingsError);

/** The settings kept for every Environment that `overrides` give, or why they are not valid, one problem per line. */
export const resolveEveryEnvironmentSettings = (
  overrides: Schema.Json,
): Result.Result<EveryEnvironmentSettings, ContainerSettingsError> =>
  Result.mapError(decodeEveryOverrides(overrides), settingsError);

/** The settings with every field at its default. */
// @effect-diagnostics-next-line schemaSync:off -- the defaults are built once, at load, from a schema that cannot fail on `{}`.
export const DEFAULT_CONTAINER_SETTINGS: ContainerSettings = Schema.decodeSync(ContainerSettings)(
  {},
);

/** The settings kept for every Environment with every field at its default. */
// @effect-diagnostics-next-line schemaSync:off -- the defaults are built once, at load, from a schema that cannot fail on `{}`.
export const DEFAULT_EVERY_ENVIRONMENT_SETTINGS: EveryEnvironmentSettings = Schema.decodeSync(
  EveryEnvironmentSettings,
)({});

/** The overrides that make the defaults into `settings`: only what differs. What a settings form saves. */
export const containerOverridesFrom = (settings: ContainerSettings): ContainerSettingsOverrides => {
  const overrides: {
    -readonly [K in keyof ContainerSettingsOverrides]: ContainerSettingsOverrides[K];
  } = {};

  if (settings.instance !== DEFAULT_CONTAINER_SETTINGS.instance) {
    overrides.instance = settings.instance;
  }

  if (settings.maxInstance !== DEFAULT_CONTAINER_SETTINGS.maxInstance) {
    overrides.maxInstance = settings.maxInstance;
  }

  if (settings.idleMinutes !== DEFAULT_CONTAINER_SETTINGS.idleMinutes) {
    overrides.idleMinutes = settings.idleMinutes;
  }

  if (settings.ignore.length > 0) overrides.ignore = settings.ignore;

  if (!Record.isEmptyRecord(settings.variables)) overrides.variables = settings.variables;

  if (settings.setupScript !== "") overrides.setupScript = settings.setupScript;

  if (settings.startScript !== "") overrides.startScript = settings.startScript;

  if (settings.toolchains !== "") overrides.toolchains = settings.toolchains;

  if (!settings.spareWorkspace) overrides.spareWorkspace = false;

  return overrides;
};

/** The overrides that make the defaults into `settings`: `{}` when there are no variables. What the Registry stores. */
export const everyEnvironmentOverridesFrom = (
  settings: EveryEnvironmentSettings,
): EveryEnvironmentSettingsOverrides =>
  Record.isEmptyRecord(settings.variables) ? {} : { variables: settings.variables };

/** Settings resolved from overrides that may be partly stale, and what was left out to do it. */
type Lenient<Settings> = {
  readonly settings: Settings;
  /** One line per override dropped, as the strict resolve words it. */
  readonly dropped: ReadonlyArray<string>;
};

/**
 * An Environment's Container settings resolved from overrides that may be partly stale, and what was left out to do it.
 */
export type LenientContainerSettings = Lenient<ContainerSettings>;

/**
 * `settings` with the size limit raised to the size where it is smaller: an Environment saved with a size above the
 * default limit before there was one keeps its size, and its size is its limit.
 */
const withLimitAtLeastSize = (settings: ContainerSettings): ContainerSettings =>
  instanceLimitProblem(settings) === undefined
    ? settings
    : { ...settings, maxInstance: settings.instance };

/**
 * The settings kept for every Environment, resolved from overrides that may be partly stale, and what was left out to
 * do it.
 */
export type LenientEveryEnvironmentSettings = Lenient<EveryEnvironmentSettings>;

const resolveLeniently = <Settings>(
  decode: (overrides: Schema.Json) => Result.Result<Settings, Schema.SchemaError>,
  defaults: Settings,
  overrides: Schema.Json,
): Lenient<Settings> => {
  if (!isJsonObject(overrides)) {
    return {
      settings: defaults,
      dropped: Result.isSuccess(decode(overrides)) ? [] : ["not an object"],
    };
  }

  let rest: Schema.JsonObject = overrides;
  const dropped: string[] = [];

  // Dropping a key settles its problem; a round per key, and one for what is left, covers a document with several.
  for (let round = 0; round <= Record.size(overrides); round += 1) {
    const result = decode(rest);

    if (Result.isSuccess(result)) return { settings: result.success, dropped };

    const problems = problemsOf(result.failure);

    for (const problem of problems) dropped.push(problem.line);

    const bad = new Set(Arr.flatMap(problems, (problem) => Arr.take(problem.keys, 1)));

    if (bad.size === 0) break;

    rest = Record.filter(rest, (_, key) => !bad.has(key));
  }

  return { settings: defaults, dropped };
};

/**
 * The settings `overrides` give once every override that does not resolve is dropped, so a value a later release stops
 * accepting (an instance type Cloudflare retires) costs only itself. Reading what was saved is lenient and writing is
 * strict (`resolveContainerSettings`), as for the global settings. A size limit below the size is raised to it
 * (`withLimitAtLeastSize`).
 */
export const resolveContainerSettingsLeniently = (
  overrides: Schema.Json,
): LenientContainerSettings => {
  const { settings, dropped } = resolveLeniently(
    decodeOverrides,
    DEFAULT_CONTAINER_SETTINGS,
    overrides,
  );

  return { settings: withLimitAtLeastSize(settings), dropped };
};

/**
 * The settings kept for every Environment that `overrides` give once every override that does not resolve is dropped:
 * lenient like `resolveContainerSettingsLeniently`.
 */
export const resolveEveryEnvironmentSettingsLeniently = (
  overrides: Schema.Json,
): LenientEveryEnvironmentSettings =>
  resolveLeniently(decodeEveryOverrides, DEFAULT_EVERY_ENVIRONMENT_SETTINGS, overrides);

/**
 * Why an Environment with the variables `own` cannot also have the ones kept for every Environment, `every`, or
 * undefined when it can: a Workspace is handed both as one set (`withEveryEnvironmentVariables`), and the Workspace DO
 * refuses more than `MAX_VARIABLES` of them. Counts each name once: an Environment's own wins over the one for every
 * Environment. The words go after a prefix the caller adds.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- a check for callers' own messages, not a combinator.
export const mergedVariablesProblem = (
  own: Readonly<Record<string, string>>,
  every: Readonly<Record<string, string>>,
): string | undefined => {
  const inherited = Arr.filter(Record.keys(every), (name) => !Record.has(own, name)).length;
  const total = Record.size(own) + inherited;

  return total > MAX_VARIABLES
    ? `with the ${inherited} ${inherited === 1 ? "variable" : "variables"} for every Environment it does not override, it would have ${total}: at most ${MAX_VARIABLES}`
    : undefined;
};

/**
 * `settings` with the variables kept for every Environment under its own: what a Workspace and a Build are handed. An
 * Environment's variable of the same name wins. At most `MAX_VARIABLES` are kept, the Environment's own first and then
 * the others by name, for a set that `mergedVariablesProblem` refuses (a save never makes one). Answers `settings`
 * itself when `every` is empty.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off -- called with both arguments at the places that hand settings over.
export const withEveryEnvironmentVariables = (
  settings: ContainerSettings,
  every: Readonly<Record<string, string>>,
): ContainerSettings => {
  if (Record.isEmptyRecord(every)) return settings;

  const inherited = Arr.sort(
    Arr.filter(Record.keys(every), (name) => !Record.has(settings.variables, name)),
    Order.String,
  );

  const kept = new Set(
    Arr.take(inherited, Math.max(0, MAX_VARIABLES - Record.size(settings.variables))),
  );

  return {
    ...settings,
    variables: { ...Record.filter(every, (_, name) => kept.has(name)), ...settings.variables },
  };
};
