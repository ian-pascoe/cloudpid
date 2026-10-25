// An Environment's Container settings (`docs/spec.md` → Container and Toolchains → Container settings): the Container's
// instance size, how long it may sit unused before its Workspace stops it, the paths it keeps to itself on top of the
// built-in ones, the variables every command gets, the Environment's own Setup and Start Scripts, and its Toolchains (a
// mise.toml). Like the global settings, every field has a decoding default, so decoding the saved overrides gives
// the resolved settings and the schema's `Encoded` side is the overrides' shape. The Registry keeps them per
// Environment, and each Workspace DO holds a copy, which it reads at each Container launch.
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

/**
 * The sizes a Container may start on under the `durable_object` scheduling policy, as the names kept in an
 * Environment's settings. Cloudflare's named instance types are stored under their own names; the others are custom sizes
 * (`{ vcpu, memoryMib, diskMb }` in `ctx.container.start`), stored as `custom-<vCPU>` and mapped to their resources by
 * `containerInstance` at each launch. A stored name never changes meaning, so a new custom size gets a new name.
 * Smallest first.
 */
export const INSTANCE_TYPES = [
  "lite",
  "basic",
  "standard-1",
  "custom-1",
  "standard-2",
  "custom-2",
  "standard-3",
  "standard-4",
] as const;

export const InstanceType = Schema.Literals(INSTANCE_TYPES);

export type InstanceType = typeof InstanceType.Type;

/** What a Container is started with when it is not one of Cloudflare's named instance types. */
export type ContainerResources = {
  readonly vcpu: number;
  readonly memoryMib: number;
  readonly diskMb: number;
};

/**
 * The custom sizes, by stored name. Cloudflare bills CPU only for active use, and memory and disk for as long as the
 * Container runs, so memory is what a running Container costs: `custom-1` (the default) has `standard-2`'s vCPU with half
 * its memory, and `custom-2` has `standard-2`'s memory with twice its vCPU. A custom size needs at least 3 GiB of memory
 * per vCPU. Both keep `standard-2`'s 12 GB disk, which costs little, so a snapshot or Build taken on one restores on the
 * other.
 */
const CUSTOM_INSTANCES = {
  "custom-1": { vcpu: 1, memoryMib: 3072, diskMb: 12_000 },
  "custom-2": { vcpu: 2, memoryMib: 6144, diskMb: 12_000 },
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
  "custom-1": CUSTOM_INSTANCES["custom-1"],
  "standard-2": { vcpu: 1, memoryMib: 6144, diskMb: 12_000 },
  "custom-2": CUSTOM_INSTANCES["custom-2"],
  "standard-3": { vcpu: 2, memoryMib: 8192, diskMb: 16_000 },
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
  "custom-1": describeResources(CUSTOM_INSTANCES["custom-1"]),
  "standard-2": "1 vCPU, 6 GiB memory, 12 GB disk",
  "custom-2": describeResources(CUSTOM_INSTANCES["custom-2"]),
  "standard-3": "2 vCPU, 8 GiB memory, 16 GB disk",
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
  instance: InstanceType.pipe(Schema.withDecodingDefaultKey(Effect.succeed("custom-1"))),
  /**
   * The size limit: the largest size the Environment's size may be, and the agent's `container_resize` may restart a
   * Container at, ordered by `compareInstances`. A Limit (GLOSSARY.md). The schema does not check `instance` against it:
   * a save does (`instanceLimitProblem`), and a lenient read raises it to `instance` for an Environment saved before it.
   */
  maxInstance: InstanceType.pipe(Schema.withDecodingDefaultKey(Effect.succeed("custom-2"))),
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
   * (`toolchainEnv`) and what a caller passes. Plain: the agent can read them.
   */
  variables: Schema.Record(Schema.String, VariableValue)
    .check(Schema.isMaxProperties(MAX_VARIABLES), Schema.makeFilter(variableNamesProblem))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  /** The Environment's own Setup Script (bash), run in `/workspace` before the repos' when it is due. Empty: none. */
  setupScript: Script.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  /** The Environment's Start Script (bash), run in `/workspace` at each Container start before the repos'. Empty: none. */
  startScript: Script.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  /**
   * The Environment's Toolchains: the text of the `mise.toml` the bootstrap writes as `/workspace/mise.toml` where the
   * Workspace has none, or has the one it last wrote. Empty: the image's base Toolchains (`BASE_MISE_TOML`).
   */
  toolchains: Toolchains.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
});

export type ContainerSettings = typeof ContainerSettings.Type;

/** What is stored: the settings that differ from the defaults. */
export type ContainerSettingsOverrides = typeof ContainerSettings.Encoded;

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

const decodeOverrides = Schema.decodeUnknownResult(ContainerSettings, {
  onExcessProperty: "error",
  errors: "all",
});

/** The settings `overrides` give over the defaults, or why they are not valid settings, one problem per line. */
export const resolveContainerSettings = (
  overrides: Schema.Json,
): Result.Result<ContainerSettings, ContainerSettingsError> =>
  Result.mapError(decodeOverrides(overrides), (error) =>
    ContainerSettingsError.make({
      message: Arr.join(
        Arr.map(problemsOf(error), (problem) => problem.line),
        "\n",
      ),
    }),
  );

/** The settings with every field at its default. */
// @effect-diagnostics-next-line schemaSync:off -- the defaults are built once, at load, from a schema that cannot fail on `{}`.
export const DEFAULT_CONTAINER_SETTINGS: ContainerSettings = Schema.decodeSync(ContainerSettings)(
  {},
);

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

  return overrides;
};

/** Settings resolved from overrides that may be partly stale, and what was left out to do it. */
export type LenientContainerSettings = {
  readonly settings: ContainerSettings;
  /** One line per override dropped, as `resolveContainerSettings` words it. */
  readonly dropped: ReadonlyArray<string>;
};

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Arr.isArray(value);

/**
 * `settings` with the size limit raised to the size where it is smaller: an Environment saved with a size above the
 * default limit before there was one keeps its size, and its size is its limit.
 */
const withLimitAtLeastSize = (settings: ContainerSettings): ContainerSettings =>
  instanceLimitProblem(settings) === undefined
    ? settings
    : { ...settings, maxInstance: settings.instance };

/**
 * The settings `overrides` give once every override that does not resolve is dropped, so a value a later release stops
 * accepting (an instance type Cloudflare retires) costs only itself. Reading what was saved is lenient and writing is
 * strict (`resolveContainerSettings`), as for the global settings. A size limit below the size is raised to it
 * (`withLimitAtLeastSize`).
 */
export const resolveContainerSettingsLeniently = (
  overrides: Schema.Json,
): LenientContainerSettings => {
  if (!isJsonObject(overrides)) {
    return {
      settings: DEFAULT_CONTAINER_SETTINGS,
      dropped: Result.isSuccess(decodeOverrides(overrides)) ? [] : ["not an object"],
    };
  }

  let rest: Schema.JsonObject = overrides;
  const dropped: string[] = [];

  // Dropping a key settles its problem; a round per key, and one for what is left, covers a document with several.
  for (let round = 0; round <= Record.size(overrides); round += 1) {
    const result = decodeOverrides(rest);

    if (Result.isSuccess(result))
      return { settings: withLimitAtLeastSize(result.success), dropped };

    const problems = problemsOf(result.failure);

    for (const problem of problems) dropped.push(problem.line);

    const bad = new Set(Arr.flatMap(problems, (problem) => Arr.take(problem.keys, 1)));

    if (bad.size === 0) break;

    rest = Record.filter(rest, (_, key) => !bad.has(key));
  }

  return { settings: DEFAULT_CONTAINER_SETTINGS, dropped };
};
