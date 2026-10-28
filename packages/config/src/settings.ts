// The settings (`docs/architecture/overview.md` → Settings): one Effect `Schema` whose every field has a decoding default. Decoding the
// overrides, a JSON document that holds only what differs from the defaults, therefore gives the resolved settings, and
// the schema's `Encoded` side is the overrides' shape: a deep partial of the settings that rejects keys it does not know.
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

/** The models the model proxy serves, as `provider/modelId`: those of `~/.pi/agent/models.json` the Session registers. */
export const SUPPORTED_MODELS = [
  "anthropic/claude-fable-5-1",
  "anthropic/claude-opus-5-5",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-haiku-5-5",
] as const;

/** A model as `provider/modelId`, one the proxy serves: any other would fail the request that uses it. */
export const ModelId = Schema.Literals(SUPPORTED_MODELS);

export type ModelId = typeof ModelId.Type;

/** Whether `value` is a model the proxy serves. */
export const isModelId = Schema.is(ModelId);

/** pi-ai's thinking levels, `off` included. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export const ThinkingLevel = Schema.Literals(THINKING_LEVELS);

export type ThinkingLevel = typeof ThinkingLevel.Type;

/** The roles a model may be picked by when work is delegated (`GLOSSARY.md` → Role). */
export const ROLE_NAMES = ["small", "medium", "large", "xlarge"] as const;

export type RoleName = (typeof ROLE_NAMES)[number];

/** Split `provider/modelId` into the pair pi-durable's `ModelRef` holds. */
export const parseModelId = (id: ModelId) => {
  const slash = id.indexOf("/");

  return { provider: id.slice(0, slash), modelId: id.slice(slash + 1) };
};

/** The `provider/modelId` of a pi-durable `ModelRef`. */
export const formatModelId = (ref: {
  readonly provider: string;
  readonly modelId: string;
}): string => `${ref.provider}/${ref.modelId}`;

/** A model role: its model, and the hint that tells an agent when to pick it. */
const role = (model: ModelId, hint: string) =>
  Schema.Struct({
    model: ModelId.pipe(Schema.withDecodingDefaultKey(Effect.succeed(model))),
    hint: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(hint))),
  });

/** `{}` decodes to a struct whose fields all have defaults. */
const allDefaults = Effect.succeed({});

const positiveInt = Schema.Int.check(Schema.isGreaterThan(0));

const nonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Automatic compaction, as pi-durable's `CompactionPolicy` with its defaults. */
const Compaction = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  reserveTokens: positiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(16_384))),
  keepRecentTokens: positiveInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(20_000))),
  backgroundTokens: nonNegativeInt.pipe(Schema.withDecodingDefaultKey(Effect.succeed(32_768))),
});

/**
 * The tools a conversation's model is offered, by name, before it loads any with `tool_search`. Every other tool is
 * deferred: the model finds it by searching, and code mode scripts call it without loading it. This is the owner's local
 * pi exposure (`defaultTools` on top of pi's read, bash, edit and write: codemode, the file search tools, `tool_search`),
 * plus the context tools, which compaction depends on (the Rollover request tells the model to call `context_rollover`),
 * and `secret_ask`, so the prompt keeps its guidance not to ask the owner to paste a credential into the conversation.
 * `tool_search` and `context_rollover` are always offered, whatever is saved: without the first the model cannot reach
 * a deferred tool, and without the second Rollover turns itself off.
 */
export const DEFAULT_OFFERED_TOOLS: ReadonlyArray<string> = [
  "read",
  "write",
  "edit",
  "bash",
  "ls",
  "find",
  "grep",
  "codemode",
  "tool_search",
  "context_notes",
  "context_history",
  "context_rollover",
  "secret_ask",
];

/** What a name or pattern in the offered tools looks like: snake_case, with `*` for any run of characters. */
export const TOOL_PATTERN = /^[a-z0-9_*]+$/;

/**
 * Which tools are offered to the model and which are deferred (`GLOSSARY.md` → Offered tool). A name, or a pattern in
 * which `*` matches any run of characters (`context_*`), in snake_case; one that matches no tool does nothing.
 */
const Tools = Schema.Struct({
  offered: Schema.Array(Schema.String.check(Schema.isPattern(TOOL_PATTERN))).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_OFFERED_TOOLS)),
  ),
});

/**
 * What a Session may spend (`docs/architecture/overview.md` → Settings). A Session over it stops before its next model request. Off by
 * default: the amount a Session is worth depends on the work, and the model proxy's own key limits bound a runaway.
 */
const SpendLimit = Schema.Struct({
  /** US dollars one Session (its root conversation and every subagent) may spend on model requests; `null` for no limit. */
  perSession: Schema.Finite.check(Schema.isGreaterThan(0)).pipe(
    Schema.NullOr,
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
});

/**
 * Leaving a Session branch for another point of the Session tree (`GLOSSARY.md` → Session tree), as local pi's
 * `branchSummary`: with `skipPrompt`, the web app does not ask whether to summarize the branch left, and carries no
 * summary.
 */
const BranchSummary = Schema.Struct({
  skipPrompt: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});

/** The role hints are those of `~/.pi/agent/settings.json`. */
const Roles = Schema.Struct({
  small: role(
    "anthropic/claude-haiku-5-5",
    "Cheap and fast. Use for explore (locating code, tracing behavior, finding reusable patterns), web and docs research, summarizing, and mechanical edits. Medium thinking is usually enough.",
  ).pipe(Schema.withDecodingDefaultKey(allDefaults)),
  medium: role(
    "anthropic/claude-sonnet-5-5",
    "Default workhorse. Use for scoped implementation tasks with a settled approach, tests, refactors, and work that spans several concerns or fits no other tier.",
  ).pipe(Schema.withDecodingDefaultKey(allDefaults)),
  large: role(
    "anthropic/claude-opus-5-5",
    "Use for planning and design, independent correctness or spec review, and diagnosing failures. Use high thinking for plan and review; set xhigh thinking for debugging, regressions, and security audits.",
  ).pipe(Schema.withDecodingDefaultKey(allDefaults)),
  xlarge: role(
    "anthropic/claude-fable-5-1",
    "Most capable and most expensive. Use only when large has failed or the problem is unusually hard.",
  ).pipe(Schema.withDecodingDefaultKey(allDefaults)),
});

/**
 * The settings. Everything has a default, so each section may be left out of the overrides, or given in part.
 * `extensions` holds each extension's options by extension name, for the extension to read.
 */
export const Settings = Schema.Struct({
  /** The model a Session's root conversation runs with until the Session picks its own. */
  model: ModelId.pipe(Schema.withDecodingDefaultKey(Effect.succeed("anthropic/claude-opus-5-5"))),
  thinkingLevel: ThinkingLevel.pipe(Schema.withDecodingDefaultKey(Effect.succeed("high"))),
  roles: Roles.pipe(Schema.withDecodingDefaultKey(allDefaults)),
  compaction: Compaction.pipe(Schema.withDecodingDefaultKey(allDefaults)),
  tools: Tools.pipe(Schema.withDecodingDefaultKey(allDefaults)),
  spendLimit: SpendLimit.pipe(Schema.withDecodingDefaultKey(allDefaults)),
  branchSummary: BranchSummary.pipe(Schema.withDecodingDefaultKey(allDefaults)),
  extensions: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Json)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
});

export type Settings = typeof Settings.Type;

/** What is stored: the settings that differ from the defaults. A deep partial of `Settings`. */
export type SettingsOverrides = typeof Settings.Encoded;

/** Overrides that do not resolve; `message` lists every problem, one per line, for a person to read. */
export class SettingsError extends Schema.TaggedError<
  SettingsError,
  { readonly brand: unique symbol }
>()("SettingsError", {
  message: Schema.String,
}) {}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

const pathText = (path: ReadonlyArray<unknown> | undefined): string =>
  Arr.join(
    Arr.map(path ?? [], (key) => String(Predicate.hasProperty(key, "key") ? key.key : key)),
    ".",
  );

// @effect-diagnostics-next-line schemaSync:off -- a total encoder: the schema has no transformation that can fail on a `Settings`.
const encodeSettings = Schema.encodeSync(Settings);

const decodeOverrides = Schema.decodeUnknownResult(Settings, {
  onExcessProperty: "error",
  errors: "all",
});

/** One thing wrong with overrides: the keys that lead to it, and a line for a person to read. */
export type SettingsProblem = { readonly keys: ReadonlyArray<string>; readonly line: string };

const problemsOf = (error: Schema.SchemaError): ReadonlyArray<SettingsProblem> =>
  Arr.map(formatIssues(error.issue).issues, (issue) => {
    const path = pathText(issue.path);

    return {
      keys: Arr.map(issue.path ?? [], (key) =>
        String(Predicate.hasProperty(key, "key") ? key.key : key),
      ),
      line: path === "" ? issue.message : `${path}: ${issue.message}`,
    };
  });

const isJsonObject = (value: Schema.Json): value is Schema.JsonObject =>
  Predicate.isObject(value) && !Arr.isArray(value);

const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Arr.isArray(value);

/** Tools that were renamed, by their former name: an offered list that names one offers it under its new name. */
const RENAMED_TOOLS: ReadonlyMap<string, string> = new Map([
  ["restart_container", "container_restart"],
]);

/**
 * `overrides` with each renamed tool in `tools.offered` under its new name (once, where the list now names it twice), so
 * a list saved before a rename keeps offering the tool, is not reported, and is saved with the new name. Patterns are
 * left as they are.
 */
export const withRenamedTools = (overrides: Schema.Json): Schema.Json => {
  if (!isJsonObject(overrides)) return overrides;

  const tools = overrides["tools"];

  if (tools === undefined || !isJsonObject(tools)) return overrides;

  const offered = tools["offered"];

  if (offered === undefined || !isJsonArray(offered)) return overrides;

  const renamed: Schema.JsonArray = Arr.dedupe(
    Arr.map(offered, (entry) =>
      Predicate.isString(entry) ? (RENAMED_TOOLS.get(entry) ?? entry) : entry,
    ),
  );

  if (renamed.length === offered.length && Arr.every(offered, (entry, i) => entry === renamed[i])) {
    return overrides;
  }

  const renamedTools = Record.map(tools, (entry, key) => (key === "offered" ? renamed : entry));

  return Record.map(overrides, (entry, key) => (key === "tools" ? renamedTools : entry));
};

/** The settings `overrides` give over the defaults strictly, or every problem with the keys it lies at. */
export const decodeSettingsOverrides = (
  overrides: Schema.Json,
): Result.Result<Settings, ReadonlyArray<SettingsProblem>> =>
  Result.mapError(decodeOverrides(overrides), problemsOf);

/** The settings `overrides` give over the defaults, or why they are not valid settings. */
export const resolveSettings = (overrides: Schema.Json): Result.Result<Settings, SettingsError> =>
  Result.mapError(decodeOverrides(withRenamedTools(overrides)), (error) =>
    SettingsError.make({
      message: Arr.join(
        Arr.map(problemsOf(error), (problem) => problem.line),
        "\n",
      ),
    }),
  );

/** The settings with every field at its default. */
// @effect-diagnostics-next-line schemaSync:off -- the defaults are built once, at load, from a schema that cannot fail on `{}`.
export const DEFAULT_SETTINGS: Settings = Schema.decodeSync(Settings)({});

/** What of `value` differs from `base`; `undefined` when nothing does. A key `base` lacks is kept whole. */
const difference = (value: Schema.Json, base: Schema.Json): Schema.Json | undefined => {
  if (!isJsonObject(value) || !isJsonObject(base)) {
    return JSON.stringify(value) === JSON.stringify(base) ? undefined : value;
  }

  const changed = Record.filterMap(value, (entry, key) => {
    const baseEntry = base[key];
    const changes = baseEntry === undefined ? entry : difference(entry, baseEntry);

    return changes === undefined ? Result.failVoid : Result.succeed(changes);
  });

  return Record.isEmptyRecord(changed) ? undefined : changed;
};

/**
 * The overrides that make the defaults into `settings`: only what differs, so a setting left at its default keeps
 * following it. This is what a settings form saves.
 */
export const overridesFrom = (settings: Settings): SettingsOverrides =>
  // SAFETY: both sides are complete encodings of `Settings`, and the difference keeps only keys the first has.
  (difference(encodeSettings(settings), encodeSettings(DEFAULT_SETTINGS)) ??
    {}) as SettingsOverrides;

const SETTINGS_ROOTS: ReadonlySet<string> = new Set(Record.keys(DEFAULT_SETTINGS));

/** The field of one option of an extension: `extensions.<extension>.<key>`. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const extensionField = (extension: string, key: string): string =>
  `extensions.${extension}.${key}`;

/**
 * The keys a settings field leads through (`docs/architecture/agent-changes.md`): a setting's dotted path (`thinkingLevel`,
 * `roles.small.model`), or `extensions.<extension>.<key>` for an extension's option, whose key may hold dots (the
 * extension's name may not). Undefined for a path that does not start at a setting or has an empty part.
 */
export const settingsFieldPath = (field: string): ReadonlyArray<string> | undefined => {
  const parts = field.split(".");
  const [root, extension, ...key] = parts;

  if (root === undefined || !SETTINGS_ROOTS.has(root) || Arr.some(parts, (part) => part === "")) {
    return undefined;
  }

  if (root !== "extensions") return parts;

  return extension === undefined || key.length === 0
    ? undefined
    : [root, extension, Arr.join(key, ".")];
};

/** The value `field` has in `settings`: null where there is none (an option not set, a field that is not one). */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const settingsFieldValue = (settings: Settings, field: string): Schema.Json | null => {
  const keys = settingsFieldPath(field);

  if (keys === undefined) return null;

  let found: unknown = settings;

  for (const key of keys) {
    found = Predicate.hasProperty(found, key) ? found[key] : undefined;
  }

  // The settings are plain JSON data: what the path leads to is JSON, or nothing.
  return Option.getOrNull(decodeJson(found));
};

const decodeJson = Schema.decodeUnknownOption(Schema.Json);

const decodeJsonObject = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));

/** `value` with `leaf` at `keys`, objects made on the way; null takes the leaf away, and an object left empty with it. */
const withLeaf = (
  value: Schema.JsonObject,
  keys: ReadonlyArray<string>,
  leaf: Schema.Json | null,
): Schema.JsonObject => {
  const [head, ...rest] = keys;

  if (head === undefined) return value;

  const { [head]: held, ...others } = value;

  if (rest.length === 0) return leaf === null ? others : { ...others, [head]: leaf };

  const inner = withLeaf(held !== undefined && isJsonObject(held) ? held : {}, rest, leaf);

  return Record.isEmptyRecord(inner) ? others : { ...others, [head]: inner };
};

/**
 * The overrides that make `settings` into settings where each of `changes` has its value (`settingsFieldPath`; null: the
 * option is taken away), over what `settings` override already. A field that is not a setting changes nothing; the
 * strict resolution of the result says whether the values are valid.
 */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const overridesWithFields = (
  settings: Settings,
  changes: ReadonlyArray<{ readonly field: string; readonly value: Schema.Json | null }>,
): Schema.Json =>
  Arr.reduce(
    changes,
    Option.getOrElse(decodeJsonObject(overridesFrom(settings)), () => ({})),
    (overrides, change) => {
      const keys = settingsFieldPath(change.field);

      return keys === undefined ? overrides : withLeaf(overrides, keys, change.value);
    },
  );

/** `value` without what lies at `keys`, if anything does. */
const omitPath = (value: Schema.Json, keys: ReadonlyArray<string>): Schema.Json => {
  const [head, ...rest] = keys;

  if (head === undefined || !isJsonObject(value)) return value;

  if (rest.length === 0) return Record.filter(value, (_, key) => key !== head);

  // A problem inside a list (`tools.offered.2`) drops the whole list, whose other elements may shift or be stale too.
  return Record.filterMap(value, (entry, key) =>
    key !== head
      ? Result.succeed(entry)
      : Arr.isArray(entry)
        ? Result.failVoid
        : Result.succeed(omitPath(entry, rest)),
  );
};

/** Settings resolved from overrides that may be partly stale, and what was left out to do it. */
export type LenientSettings = {
  readonly settings: Settings;
  /** One line per setting dropped, as `resolveSettings` words it: empty when every override resolved. */
  readonly dropped: ReadonlyArray<string>;
};

/**
 * The settings `overrides` give once every override that does not resolve is dropped: a value a release no longer
 * accepts (a model that left `SUPPORTED_MODELS`) or a key it dropped costs only itself, and its siblings still apply.
 * Overrides that are not an object at all give the defaults. Writes stay strict (`resolveSettings`); this is for
 * reading what an earlier release saved.
 */
export const resolveLeniently = (overrides: Schema.Json): LenientSettings => {
  let rest = withRenamedTools(overrides);
  const dropped: string[] = [];

  // Dropping a path settles its problem; a few rounds cover a document with several.
  for (let round = 0; round < 8; round += 1) {
    const result = decodeOverrides(rest);

    if (Result.isSuccess(result)) return { settings: result.success, dropped };

    const problems = problemsOf(result.failure);

    for (const problem of problems) dropped.push(problem.line);

    if (Arr.some(problems, (problem) => problem.keys.length === 0)) break;

    rest = Arr.reduce(problems, rest, (left, problem) => omitPath(left, problem.keys));
  }

  return { settings: DEFAULT_SETTINGS, dropped };
};
