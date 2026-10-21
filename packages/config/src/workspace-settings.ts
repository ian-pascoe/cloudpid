// A Workspace's own settings (`docs/spec.md` → Container and Toolchains → Size and idle): the Container's instance
// size and how long it may sit unused before the Workspace stops it. Like the global settings, every field has a
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
 * The instance types a Container may start on under the `durable_object` scheduling policy, as Cloudflare's names for
 * them (custom `{ vcpu, memoryMib, diskMb }` sizes exist too, and are not offered). Smallest first.
 */
export const INSTANCE_TYPES = [
  "lite",
  "basic",
  "standard-1",
  "standard-2",
  "standard-3",
  "standard-4",
] as const;

export const InstanceType = Schema.Literals(INSTANCE_TYPES);

export type InstanceType = typeof InstanceType.Type;

/** What each instance type offers, from Cloudflare's Containers limits page, for the settings form to show. */
export const INSTANCE_DESCRIPTIONS: Readonly<Record<InstanceType, string>> = {
  lite: "1/16 vCPU, 256 MiB memory, 2 GB disk",
  basic: "1/4 vCPU, 1 GiB memory, 4 GB disk",
  "standard-1": "1/2 vCPU, 4 GiB memory, 8 GB disk",
  "standard-2": "1 vCPU, 6 GiB memory, 12 GB disk",
  "standard-3": "2 vCPU, 8 GiB memory, 16 GB disk",
  "standard-4": "4 vCPU, 12 GiB memory, 20 GB disk",
};

/** The longest idle time: a day. */
export const MAX_IDLE_MINUTES = 24 * 60;

const IdleMinutes = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1),
  Schema.isLessThanOrEqualTo(MAX_IDLE_MINUTES),
);

export const WorkspaceSettings = Schema.Struct({
  /** The instance type the Container starts on. */
  instance: InstanceType.pipe(Schema.withDecodingDefaultKey(Effect.succeed("standard-2"))),
  /** Minutes without a command on the Container before it is stopped (a disk snapshot is taken first). */
  idleMinutes: IdleMinutes.pipe(Schema.withDecodingDefaultKey(Effect.succeed(15))),
});

export type WorkspaceSettings = typeof WorkspaceSettings.Type;

/** What is stored: the settings that differ from the defaults. */
export type WorkspaceSettingsOverrides = typeof WorkspaceSettings.Encoded;

export class WorkspaceSettingsError extends Schema.TaggedError<
  WorkspaceSettingsError,
  { readonly brand: unique symbol }
>()("WorkspaceSettingsError", {
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

const decodeOverrides = Schema.decodeUnknownResult(WorkspaceSettings, {
  onExcessProperty: "error",
  errors: "all",
});

/** The settings `overrides` give over the defaults, or why they are not valid settings, one problem per line. */
export const resolveWorkspaceSettings = (
  overrides: Schema.Json,
): Result.Result<WorkspaceSettings, WorkspaceSettingsError> =>
  Result.mapError(decodeOverrides(overrides), (error) =>
    WorkspaceSettingsError.make({
      message: Arr.join(
        Arr.map(problemsOf(error), (problem) => problem.line),
        "\n",
      ),
    }),
  );

/** The settings with every field at its default. */
// @effect-diagnostics-next-line schemaSync:off -- the defaults are built once, at load, from a schema that cannot fail on `{}`.
export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = Schema.decodeSync(WorkspaceSettings)(
  {},
);

/** The overrides that make the defaults into `settings`: only what differs. What a settings form saves. */
export const workspaceOverridesFrom = (settings: WorkspaceSettings): WorkspaceSettingsOverrides => {
  const overrides: {
    -readonly [K in keyof WorkspaceSettingsOverrides]: WorkspaceSettingsOverrides[K];
  } = {};

  if (settings.instance !== DEFAULT_WORKSPACE_SETTINGS.instance) {
    overrides.instance = settings.instance;
  }

  if (settings.idleMinutes !== DEFAULT_WORKSPACE_SETTINGS.idleMinutes) {
    overrides.idleMinutes = settings.idleMinutes;
  }

  return overrides;
};

/** Settings resolved from overrides that may be partly stale, and what was left out to do it. */
export type LenientWorkspaceSettings = {
  readonly settings: WorkspaceSettings;
  /** One line per override dropped, as `resolveWorkspaceSettings` words it. */
  readonly dropped: ReadonlyArray<string>;
};

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Arr.isArray(value);

/**
 * The settings `overrides` give once every override that does not resolve is dropped, so a value a later release stops
 * accepting (an instance type Cloudflare retires) costs only itself. Reading what was saved is lenient and writing is
 * strict (`resolveWorkspaceSettings`), as for the global settings.
 */
export const resolveWorkspaceSettingsLeniently = (
  overrides: Schema.Json,
): LenientWorkspaceSettings => {
  if (!isJsonObject(overrides)) {
    return {
      settings: DEFAULT_WORKSPACE_SETTINGS,
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

  return { settings: DEFAULT_WORKSPACE_SETTINGS, dropped };
};
