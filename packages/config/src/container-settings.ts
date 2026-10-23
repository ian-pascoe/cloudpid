// A Machine's own settings (`docs/spec.md` → Container and Toolchains → Size and idle): the Container's instance
// size, how long it may sit unused before the Machine stops it, and the paths it keeps to itself on top of the
// built-in ones. Like the global settings, every field has a
// decoding default, so decoding the saved overrides gives the resolved settings and the schema's `Encoded` side is the
// overrides' shape. They live in the Workspace DO, which reads them at each Container launch.
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

/**
 * The sizes a Container may start on under the `durable_object` scheduling policy, as the names kept in a Machine's
 * settings. Cloudflare's named instance types are stored under their own names; the others are custom sizes
 * (`{ vcpu, memoryMib, diskMb }` in `ctx.container.start`), stored as `custom-<vCPU>` and mapped to their resources by
 * `containerInstance` at each launch. A stored name never changes meaning, so a new custom size gets a new name.
 * Smallest first.
 */
export const INSTANCE_TYPES = [
  "lite",
  "basic",
  "standard-1",
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
 * The custom sizes, by stored name. `custom-2` costs `standard-2`'s memory and disk with twice its CPU: Cloudflare bills
 * CPU only for active use, and memory and disk for as long as the Container runs. A custom size needs at least 3 GiB of
 * memory per vCPU.
 */
const CUSTOM_INSTANCES = {
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

const describeResources = ({ vcpu, memoryMib, diskMb }: ContainerResources): string =>
  `${vcpu} vCPU, ${memoryMib / 1024} GiB memory, ${diskMb / 1000} GB disk`;

/** What each size offers, for the settings form to show: Cloudflare's Containers limits page for its named types, the resources for the custom ones. */
export const INSTANCE_DESCRIPTIONS: Readonly<Record<InstanceType, string>> = {
  lite: "1/16 vCPU, 256 MiB memory, 2 GB disk",
  basic: "1/4 vCPU, 1 GiB memory, 4 GB disk",
  "standard-1": "1/2 vCPU, 4 GiB memory, 8 GB disk",
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

/** The most extra Container-only paths a Machine may have. */
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
    return "would keep the whole Machine on the Container";
  }

  return undefined;
};

const IgnorePattern = Schema.String.check(
  Schema.makeFilter((pattern: string) => {
    const problem = ignorePatternProblem(pattern);

    return problem === undefined ? undefined : `${JSON.stringify(pattern)} ${problem}`;
  }),
);

export const ContainerSettings = Schema.Struct({
  /** The instance type the Container starts on. */
  instance: InstanceType.pipe(Schema.withDecodingDefaultKey(Effect.succeed("custom-2"))),
  /** Minutes without a command on the Container before it is stopped (a disk snapshot is taken first). */
  idleMinutes: IdleMinutes.pipe(Schema.withDecodingDefaultKey(Effect.succeed(5))),
  /**
   * Paths the Container keeps to itself, out of the Machine, after the built-in ones (`TOOLCHAIN_IGNORE`), as
   * computer's `ignore` patterns: the last one that matches a path wins, so `!` keeps a built-in one synced.
   */
  ignore: Schema.Array(IgnorePattern)
    .check(Schema.isMaxLength(MAX_IGNORE_PATTERNS))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
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

  if (settings.idleMinutes !== DEFAULT_CONTAINER_SETTINGS.idleMinutes) {
    overrides.idleMinutes = settings.idleMinutes;
  }

  if (settings.ignore.length > 0) overrides.ignore = settings.ignore;

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
 * The settings `overrides` give once every override that does not resolve is dropped, so a value a later release stops
 * accepting (an instance type Cloudflare retires) costs only itself. Reading what was saved is lenient and writing is
 * strict (`resolveContainerSettings`), as for the global settings.
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

  // Dropping a key settles its problem; a round per key covers a document with several.
  for (let round = 0; round < 4; round += 1) {
    const result = decodeOverrides(rest);

    if (Result.isSuccess(result)) return { settings: result.success, dropped };

    const problems = problemsOf(result.failure);

    for (const problem of problems) dropped.push(problem.line);

    const bad = new Set(Arr.flatMap(problems, (problem) => Arr.take(problem.keys, 1)));

    if (bad.size === 0) break;

    rest = Record.filter(rest, (_, key) => !bad.has(key));
  }

  return { settings: DEFAULT_CONTAINER_SETTINGS, dropped };
};
