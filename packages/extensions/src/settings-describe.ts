// Holds: the Settings view the Registry gives (`SettingsView`, `isGlobalView`), `SettingsAccessError`, the in-session
// describers (`describeSettings`, `scopeName`, `shown`) and `settingsOutput`, the value `settings_get` gives programs
// (`docs/architecture/mcp-endpoint.md` → Environment and Settings tools → Shared definitions and the core/wrapper split).
// A leaf of the extension: `settings.ts` re-exports it, and the read cores (`settings-reads.ts`, `settings-mcp-reads.ts`)
// and the wrappers both import it, so neither imports the other.
// @effect-diagnostics missingPipeableSignature:off
import {
  extensionField,
  MAX_INSTRUCTIONS_BYTES,
  overrideValue,
  ROLE_NAMES,
  type Settings,
  settingsFieldValue,
  type SettingsOverrides,
  textSize,
  utf8Bytes,
} from "@cloudpid/config";
import { GLOBAL_SETTINGS_SCOPE } from "@cloudpid/protocol/harness-tools";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import { formatScope } from "./instructions.ts";
import {
  instructionsOutput,
  SESSION_SETTINGS_BOUNDS,
  type SettingsBounds,
  settingOverriddenIn,
  scopeRefOf,
  settingsGetOutput,
  settingValues,
} from "./settings-outputs.ts";
import { DEFAULT_MAX_SUBAGENT_DEPTH } from "./subagents/options.ts";
import { DEFAULT_MAX_SUBAGENT_WORKSPACES } from "./subagents/workspaces.ts";

/**
 * The Settings of one Scope as the Registry holds them. At Global (`scope: "*"`): the settings in force, the overrides
 * of the defaults they come from, and by field the Environments that override it. At an Environment (its id): the
 * settings in force for its Sessions, its Overrides (the fields set on purpose for it; a field it does not hold is
 * inherited), the Global settings it inherits, and its name.
 */
export type SettingsView =
  | {
      readonly scope: typeof GLOBAL_SETTINGS_SCOPE;
      readonly settings: Settings;
      readonly overrides: SettingsOverrides;
      readonly overriddenIn: Readonly<
        Record<string, ReadonlyArray<{ readonly id: string; readonly name: string }>>
      >;
      /** Why some saved overrides were left out, when a later release no longer accepts them. */
      readonly problem?: string | undefined;
      /** How many MCP servers Global's own entries are; undefined when the Registry did not say. */
      readonly mcpServers?: number | undefined;
    }
  | {
      readonly scope: string;
      /** The Environment's name. */
      readonly name: string;
      readonly settings: Settings;
      readonly overrides: Schema.Json;
      readonly global: Settings;
      /** Why some saved Overrides were left out, when a later release no longer accepts them: those fields inherit. */
      readonly problem?: string | undefined;
      /** The Environment's own Instructions, empty for none: no Override, shown after Global's (ADR-0027). */
      readonly instructions: string;
      /** How many MCP servers its whole set has (Global's, its own and its Repos'); undefined when the Registry did not say. */
      readonly mcpServers?: number | undefined;
    };

/** The Global Settings' view. */
export type GlobalSettingsView = Extract<SettingsView, { readonly overriddenIn: unknown }>;

/** An Environment's Settings' view. */
export type EnvironmentSettingsView = Exclude<SettingsView, GlobalSettingsView>;

/** Whether `view` is Global's, not an Environment's. */
export const isGlobalView = (view: SettingsView): view is GlobalSettingsView =>
  view.scope === GLOBAL_SETTINGS_SCOPE;

/** Reaching the Settings failed; its message is what the model sees. */
export class SettingsAccessError extends Schema.TaggedError<
  SettingsAccessError,
  { readonly brand: unique symbol }
>()("SettingsAccessError", {
  message: Schema.String,
  /** Why a read was refused, for the endpoint's dispatcher; none for a refusal that is only a message. */
  code: Schema.optionalKey(Schema.Literals(["not_found", "invalid_argument"])),
}) {}

/** A Role's value, its model and hint. */
export const roleOf = (
  value: Schema.Json | null,
): Option.Option<{ readonly model: string; readonly hint: string }> =>
  Predicate.hasProperty(value, "model") &&
  Predicate.hasProperty(value, "hint") &&
  Predicate.isString(value.model) &&
  Predicate.isString(value.hint)
    ? Option.some({ model: value.model, hint: value.hint })
    : Option.none();

/** A value as a result says it: text bare, a list joined, a Role by model and hint, anything else as JSON. */
export const shown = (value: Schema.Json | null): string => {
  if (value === null) return "not set";

  if (Predicate.isString(value)) return value;

  if (Arr.isArray(value) && Arr.every(value, Predicate.isString)) {
    return value.length === 0 ? "none" : Arr.join(value, ", ");
  }

  return Option.match(roleOf(value), {
    onNone: () => JSON.stringify(value),
    onSome: ({ model, hint }) => `${model} with the hint ${JSON.stringify(hint)}`,
  });
};

/** The Scope as a result names it: Global, or the Environment by name and id. */
export const scopeName = (view: SettingsView): string =>
  isGlobalView(view) ? "Global" : `Environment ${JSON.stringify(view.name)} (${view.scope})`;

/** Whether `overrides` hold a value at `field`'s path. */
export const overridden = (overrides: SettingsOverrides, field: string): boolean =>
  Option.isSome(overrideValue(overrides, field));

/** A setting's value as `settings_get` shows it, read from settings: the Scope's own, or Global's at an Environment. */
type Shown = (settings: Settings) => string;

/** What `settings_get` says: the settings in force at the Scope, each with where its value comes from. */
export const describeSettings = (view: SettingsView, own: string | null): string => {
  const { settings } = view;

  /** Where `field`'s value comes from, and at Global the Environments that override it. */
  const source = (field: string, value: Shown): string => {
    if (isGlobalView(view)) {
      const set = overridden(view.overrides, field) ? "Global" : "default";
      const by = view.overriddenIn[field] ?? [];

      return by.length === 0
        ? set
        : `${set}; overridden in ${Arr.join(
            Arr.map(by, (each) => `${JSON.stringify(each.name)} (${each.id})`),
            ", ",
          )}`;
    }

    return Option.isSome(overrideValue(view.overrides, field))
      ? `overridden; Global: ${value(view.global)}`
      : "inherited from Global";
  };

  const line = (label: string, field: string, value: Shown) =>
    `${label}: ${value(settings)} (${source(field, value)})`;

  const field =
    (name: string): Shown =>
    (each) =>
      shown(settingsFieldValue(each, name));

  const options = Arr.flatMap(Record.toEntries(settings.extensions), ([extension, entries]) =>
    Arr.map(Record.keys(entries), (key) => {
      const name = extensionField(extension, key);

      return `  ${line(`${extension}.${key}`, name, field(name))}`;
    }),
  );

  const depthField = extensionField("subagents", "maxSubagentDepth");
  const workspacesField = extensionField("subagents", "maxSubagentWorkspaces");

  const cap = `at most ${MAX_INSTRUCTIONS_BYTES / 1024} KiB`;

  /** One Scope's Instructions: none, or their size and their text as the section shows them. */
  const instructionsOf = (text: string, source: string, scope: string) =>
    text === "" ? `none (${source})` : `${textSize(text)} (${source})\n${formatScope(scope, text)}`;

  // An Environment's settings carry Global's Instructions, and its own add to them: no Override (ADR-0027).
  const instructionsLine = isGlobalView(view)
    ? `Instructions (every conversation's model is shown them from the start of its Context Window, before its Environment's own and the Project instructions, which win where they disagree; settings_instructions_set changes them once the user approves): ${instructionsOf(
        settings.instructions,
        settings.instructions === "" ? "default" : `Global; ${cap}`,
        "Global",
      )}`
    : Arr.join(
        [
          `Instructions (they add up, never overridden: this Environment's conversations are shown the Global ones, then its own, from the start of each Context Window, before the Project instructions; where two disagree the nearer wins; settings_instructions_set changes either Scope's once the user approves):`,
          `  Global: ${instructionsOf(settings.instructions, "Global's", "Global")}`,
          `  This Environment's own: ${instructionsOf(view.instructions, cap, `Environment ${view.name}`)}`,
        ],
        "\n",
      );

  const header = isGlobalView(view)
    ? [
        `Global Settings (scope "${GLOBAL_SETTINGS_SCOPE}"): what each Environment inherits, field by field, unless it overrides the field. Each value says where it comes from: "default" (nobody sets it) or "Global" (set at Global), and names the Environments that override it, whose Sessions a change at Global does not reach.`,
        own === null
          ? "This Session's Environment is not one the Registry lists."
          : `This Session runs with the Settings of its own Environment (id ${own}): settings_get with scope "${own}" shows them.`,
      ]
    : [
        `Settings of ${scopeName(view)}: its Overrides over Global over the defaults. Each value is "overridden" (set on purpose for this Environment, kept even when equal to Global's, shown with the Global value it replaces) or "inherited from Global". settings_reset removes an Override, so the field inherits again.`,
        view.scope === own
          ? "This Session runs in this Environment: these are the Settings its requests use."
          : `This Session runs with the Settings of its own Environment${own === null ? "" : ` (id ${own})`}, not these.`,
      ];

  return Arr.join(
    [
      ...header,
      line("Default model", "model", field("model")),
      line("Default thinking level", "thinkingLevel", field("thinkingLevel")),
      "Roles (the model a subagent runs on, picked by name; the hint tells an agent when to pick it; a Role's model and hint are one field):",
      ...Arr.map(
        ROLE_NAMES,
        (role) =>
          `  ${line(role, `roles.${role}`, (each) => `${each.roles[role].model}; hint: ${each.roles[role].hint}`)}`,
      ),
      "Automatic compaction:",
      ...Arr.map(
        ["enabled", "reserveTokens", "keepRecentTokens", "backgroundTokens"] as const,
        (key) => `  ${line(key, `compaction.${key}`, field(`compaction.${key}`))}`,
      ),
      `${line("Offered tools (the rest are deferred: found with tool_search)", "tools.offered", field("tools.offered"))}. tool_search and context_rollover are offered whatever the list says.`,
      line(
        "Skip the branch summary prompt",
        "branchSummary.skipPrompt",
        field("branchSummary.skipPrompt"),
      ),
      `${line("Spend limit per Session (US dollars)", "spendLimit.perSession", field("spendLimit.perSession"))}. A Limit: settings_spend_limit_set changes it once the user approves, at either Scope.`,
      `${line("Subagent depth (levels of subagents below the root)", depthField, (each) =>
        shown(each.extensions.subagents?.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH),
      )}. A Limit: settings_subagent_depth_set changes it once the user approves, at either Scope.`,
      `${line(
        "Subagent Workspace limit (Subagent Workspaces one Session may have at once)",
        workspacesField,
        (each) =>
          shown(
            each.extensions.subagents?.maxSubagentWorkspaces ?? DEFAULT_MAX_SUBAGENT_WORKSPACES,
          ),
      )}. A Limit: settings_subagent_workspaces_set changes it once the user approves, at either Scope.`,
      `Extension options: ${options.length === 0 ? "none" : `\n${Arr.join(options, "\n")}`}`,
      view.mcpServers === undefined
        ? "MCP servers: the count is unavailable now; settings_mcp_list shows them"
        : `MCP servers: ${view.mcpServers} at this Scope; settings_mcp_list shows them`,
      instructionsLine,
      isGlobalView(view)
        ? "settings_reset puts a field back to its default at Global, or removes an Environment's Override of it; for a Limit it waits for the user's Approval."
        : "settings_reset with this Environment's id removes an Override; for a Limit it waits for the user's Approval.",
      ...(view.problem === undefined
        ? []
        : [
            isGlobalView(view)
              ? `Saved overrides left out, as they no longer apply: ${view.problem}`
              : `Saved Overrides left out, as they no longer apply (those fields inherit Global): ${view.problem}`,
          ]),
    ],
    "\n",
  );
};

/** What `settings_get` gives programs: the settings in force at the Scope, each with where its value comes from. */
export const settingsOutput = (
  view: SettingsView,
  own: string | null,
  bounds: SettingsBounds = SESSION_SETTINGS_BOUNDS,
) => {
  const { settings } = view;

  /** One setting: its value in force, read from the settings, and where it comes from. */
  const entry = (field: string, value: (each: Settings) => Schema.Json | null) => {
    if (isGlobalView(view)) {
      return {
        field,
        ...settingValues(value(settings), null, bounds.value),
        source: Option.isSome(overrideValue(view.overrides, field))
          ? ("global" as const)
          : ("default" as const),
        ...settingOverriddenIn(view.overriddenIn[field] ?? [], bounds.overriddenIn),
      };
    }

    return {
      field,
      ...settingValues(value(settings), value(view.global), bounds.value),
      source: Option.isSome(overrideValue(view.overrides, field))
        ? ("override" as const)
        : ("inherited" as const),
      ...settingOverriddenIn([], bounds.overriddenIn),
    };
  };

  const field =
    (name: string) =>
    (each: Settings): Schema.Json | null =>
      settingsFieldValue(each, name);

  const depthField = extensionField("subagents", "maxSubagentDepth");
  const workspacesField = extensionField("subagents", "maxSubagentWorkspaces");

  // The Limits show their defaults where they are not set; they are not listed again among the options.
  const options = Arr.flatMap(Record.toEntries(settings.extensions), ([extension, entries]) =>
    Arr.flatMap(Record.keys(entries), (key) => {
      const name = extensionField(extension, key);

      return name === depthField || name === workspacesField ? [] : [entry(name, field(name))];
    }),
  );

  const instructions = isGlobalView(view)
    ? {
        global: instructionsOutput(
          settings.instructions,
          utf8Bytes(settings.instructions),
          bounds.instructions,
        ),
        environment: null,
      }
    : {
        global: instructionsOutput(
          settings.instructions,
          utf8Bytes(settings.instructions),
          bounds.instructions,
        ),
        environment: instructionsOutput(
          view.instructions,
          utf8Bytes(view.instructions),
          bounds.instructions,
        ),
      };

  return settingsGetOutput(
    {
      scope: scopeRefOf(view),
      own_environment: own,
      is_own: !isGlobalView(view) && view.scope === own,
      settings: [
        entry("model", field("model")),
        entry("thinkingLevel", field("thinkingLevel")),
        ...Arr.map(ROLE_NAMES, (role) => entry(`roles.${role}`, field(`roles.${role}`))),
        ...Arr.map(
          ["enabled", "reserveTokens", "keepRecentTokens", "backgroundTokens"] as const,
          (key) => entry(`compaction.${key}`, field(`compaction.${key}`)),
        ),
        entry("tools.offered", field("tools.offered")),
        entry("branchSummary.skipPrompt", field("branchSummary.skipPrompt")),
        entry("spendLimit.perSession", field("spendLimit.perSession")),
        entry(
          depthField,
          (each) => each.extensions.subagents?.maxSubagentDepth ?? DEFAULT_MAX_SUBAGENT_DEPTH,
        ),
        entry(
          workspacesField,
          (each) =>
            each.extensions.subagents?.maxSubagentWorkspaces ?? DEFAULT_MAX_SUBAGENT_WORKSPACES,
        ),
        ...options,
      ],
      instructions,
      mcp_servers: view.mcpServers ?? null,
      problem: view.problem ?? null,
    },
    bounds,
  );
};
