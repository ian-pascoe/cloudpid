// The `settings` extension (`docs/spec.md` → Agent changes, ADR-0019): the agent's tools for the Settings the owner edits
// on the Settings page, one tool for each thing it may change: `settings_get`, `settings_model_set`,
// `settings_role_set`, `settings_tool_offer`, `settings_tool_defer`, `settings_compaction_set`,
// `settings_branch_summary_set` and `settings_extension_set`. The Limits (`spendLimit.perSession` and the subagent
// depth) are not among them: they wait for the owner's Approval. Each change is an Agent change: the Registry applies it
// as the owner's save is applied and records it, the Session reads the Settings again at once, and the Run's end
// notifies the owner of the changes it made (`AgentChangeLog`). They are the root conversation's only
// (`PARENT_ONLY_TOOL_PREFIXES`), as `secret_ask` is. Values are plain: a change is refused when its reason or its text
// holds a Secret the Session holds or the GitHub token.
// @effect-diagnostics missingPipeableSignature:off
import {
  extensionField,
  ModelId,
  ROLE_NAMES,
  type Settings,
  SUPPORTED_MODELS,
  type SettingsOverrides,
  THINKING_LEVELS,
  ThinkingLevel,
} from "@cloudpid/config";
import { defineEffectTool } from "@cloudpid/effect-durable";
import type { AgentChange } from "@cloudpid/protocol";
import type { JsonValue } from "@earendil-works/chord";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Record from "effect/Record";
import * as Schema from "effect/Schema";
import {
  AgentChangeLog,
  type ChangeAuthor,
  DeployCredentials,
  MAX_CHANGE_REASON,
} from "./environment.ts";
import { matchesPattern } from "./patterns.ts";
import { Redactions } from "./secrets/redaction.ts";
import { holdsPlaceholder } from "./secrets/references.ts";
import { Secrets } from "./secrets/store.ts";
import { SUBAGENT_TOOLSET_OPTIONS } from "./subagents/options.ts";
import { ALWAYS_OFFERED } from "./tool-search.ts";

export const extensionName = "settings";

/** The prefix of every tool of the extension: all of them are the root conversation's only. */
export const SETTINGS_TOOL_PREFIX = "settings_";

/** The Settings as the Registry holds them: the resolved settings, the overrides they come from, and any problem. */
export type SettingsView = {
  readonly settings: Settings;
  readonly overrides: SettingsOverrides;
  /** Why some saved overrides were left out, when a later release no longer accepts them. */
  readonly problem?: string | undefined;
};

/**
 * One setting given a new value: a settings field (`model`, `roles.small.hint`, …); null takes an option away. With
 * `expected`, it is changed only while it has that value (null: not set), the one the owner saw when they approved it.
 */
export type SettingsFieldChange = {
  readonly field: string;
  readonly value: Schema.Json | null;
  readonly expected?: { readonly value: Schema.Json | null } | undefined;
};

/** How an Agent change to the Settings went, as the Session reports it. */
export type AppliedSettingsChange =
  | {
      readonly status: "changed";
      /** One record for each field that changed, with the values before and after. */
      readonly changes: ReadonlyArray<AgentChange>;
      /** What the saved overrides had that no longer applied, when they had: the write forgot it. */
      readonly dropped?: string | undefined;
    }
  /** Every field already had its value: nothing was saved or recorded. */
  | { readonly status: "unchanged" }
  /** Not values the settings take, said as the owner's save says it: nothing was saved. */
  | { readonly status: "rejected"; readonly message: string }
  /** A field no longer has the value it was approved against: it is `current`, and nothing was saved. */
  | {
      readonly status: "changed-since";
      readonly field: string;
      readonly current: Schema.Json | null;
    };

/** Reaching the Settings failed; its message is what the model sees. */
export class SettingsAccessError extends Schema.TaggedError<
  SettingsAccessError,
  { readonly brand: unique symbol }
>()("SettingsAccessError", { message: Schema.String }) {}

/** The Settings, as the Session reaches them through the Registry. */
export type SettingsAccessService = {
  readonly get: Effect.Effect<SettingsView, SettingsAccessError>;
  /** Apply `changes` as the owner's save does and record each field that changed with its `author`. */
  readonly change: (input: {
    readonly changes: ReadonlyArray<SettingsFieldChange>;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<AppliedSettingsChange, SettingsAccessError>;
};

export class SettingsAccess extends Context.Service<SettingsAccess, SettingsAccessService>()(
  "@cloudpid/extensions/settings/SettingsAccess",
) {}

/** What the Session says of itself after it read the Settings again: whether it picked its own model and level. */
export type SettingsApplied = {
  readonly picked: { readonly model: boolean; readonly thinkingLevel: boolean };
};

/**
 * Where the Session reads the Settings again after a change of its own, and brings its conversation's agent to the
 * default, so the next request uses it. It never fails: a Session that cannot read the Registry carries on with the
 * settings it last read, and reads them again when it next admits input.
 */
export class SettingsReload extends Context.Service<
  SettingsReload,
  { readonly apply: Effect.Effect<SettingsApplied> }
>()("@cloudpid/extensions/settings/SettingsReload") {}

const Reason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CHANGE_REASON),
).annotate({
  description:
    "Why you make the change, for the user to read in the Settings' Agent changes, such as 'this task is small and cheap'",
});

const MODEL_LIST = Arr.join(SUPPORTED_MODELS, ", ");

/** A value as a result says it: text bare, a list joined, anything else as JSON, and none as not set. */
const shown = (value: Schema.Json | null): string => {
  if (value === null) return "not set";

  if (Predicate.isString(value)) return value;

  if (Arr.isArray(value) && Arr.every(value, Predicate.isString)) {
    return value.length === 0 ? "none" : Arr.join(value, ", ");
  }

  return JSON.stringify(value);
};

const SETTING_LABELS: Readonly<Record<string, string>> = {
  model: "default model",
  thinkingLevel: "default thinking level",
  "tools.offered": "offered tools",
  "branchSummary.skipPrompt": "skip of the branch summary prompt",
};

/** A settings field as a result names it. */
const fieldLabel = (field: string): string => {
  const known = SETTING_LABELS[field];

  if (known !== undefined) return known;

  const role = /^roles\.(\w+)\.(model|hint)$/.exec(field);

  if (role !== null) return `${role[2]} of the ${role[1]} role`;

  const compaction = /^compaction\.(\w+)$/.exec(field);

  if (compaction !== null) return `compaction ${compaction[1]}`;

  return field.startsWith("extensions.") ? `extension option ${field.slice(11)}` : field;
};

/** The changes as a result lists them: each field with its value before and after. */
const changedLines = (changes: ReadonlyArray<AgentChange>): string =>
  Arr.join(
    Arr.map(
      changes,
      (change) =>
        `- ${fieldLabel(change.field)}: it was ${shown(change.before)}, and is ${shown(change.after)} now.`,
    ),
    "\n",
  );

/** Whether `overrides` hold a value at `field`'s path. */
const overridden = (overrides: SettingsOverrides, field: string): boolean => {
  let found: unknown = overrides;

  for (const key of field.split(".")) {
    found = Predicate.hasProperty(found, key) ? found[key] : undefined;
  }

  return found !== undefined;
};

/** What `settings_get` says: the resolved settings, each marked as an override or a default. */
export const describeSettings = (view: SettingsView): string => {
  const { settings, overrides } = view;

  const line = (label: string, field: string, value: Schema.Json | null) =>
    `${label}: ${shown(value)}${overridden(overrides, field) ? " (override)" : ""}`;

  const options = Arr.flatMap(Record.toEntries(settings.extensions), ([extension, entries]) =>
    Arr.map(Record.toEntries(entries), ([key, value]) => `  ${extension}.${key} = ${shown(value)}`),
  );

  return Arr.join(
    [
      "Settings (the user edits them on the Settings page; (override) marks a value that differs from the default):",
      line("Default model", "model", settings.model),
      line("Default thinking level", "thinkingLevel", settings.thinkingLevel),
      "Roles (the model a subagent runs on, picked by name; the hint tells an agent when to pick it):",
      ...Arr.map(
        ROLE_NAMES,
        (role) =>
          `  ${role}: ${settings.roles[role].model}${overridden(overrides, `roles.${role}.model`) ? " (override)" : ""}; hint${overridden(overrides, `roles.${role}.hint`) ? " (override)" : ""}: ${settings.roles[role].hint}`,
      ),
      "Automatic compaction:",
      ...Arr.map(
        ["enabled", "reserveTokens", "keepRecentTokens", "backgroundTokens"] as const,
        (key) => `  ${line(key, `compaction.${key}`, settings.compaction[key])}`,
      ),
      `${line("Offered tools (the rest are deferred: found with tool_search)", "tools.offered", settings.tools.offered)}. tool_search and context_rollover are offered whatever the list says.`,
      line(
        "Skip the branch summary prompt",
        "branchSummary.skipPrompt",
        settings.branchSummary.skipPrompt,
      ),
      `${line("Spend limit per Session (US dollars)", "spendLimit.perSession", settings.spendLimit.perSession)}. A Limit: only the user changes it.`,
      `Extension options: ${options.length === 0 ? "none" : `\n${Arr.join(options, "\n")}`}`,
      ...(view.problem === undefined
        ? []
        : [`Saved overrides left out, as they no longer apply: ${view.problem}`]),
    ],
    "\n",
  );
};

const LIMIT_NOTE =
  "The change is recorded with your reason, and the user can see and revert it on the Settings page. It reaches this Session's next request, and other Sessions when they next admit input.";

const encodeJsonText = Schema.encodeOption(Schema.fromJsonString(Schema.Json));

/**
 * A JSON value as text, the text a Secret could hide in at any depth: the redaction of a Secret knows the form its value
 * takes inside a JSON string.
 */
const jsonText = (value: Schema.Json | null): string =>
  Option.getOrElse(encodeJsonText(value), () => "");

/** A Schema `Json` value as the details' `JsonValue`, which differs only in that its arrays are mutable. */
// SAFETY: the two types describe the same values; the details are never mutated.
const asJsonValue = (value: Schema.Json | null): JsonValue => value as JsonValue;

/** Why a text that holds a Secret Reference is refused: the tools resolve none, so the Settings would hold its text. */
const REFUSED_PLACEHOLDER =
  "Nothing was saved: the reason or a text of the call holds a Secret Reference, which these tools do not resolve, so the Settings would hold the reference's text, not the Secret. Settings are plain and the user reads them. Say it without the reference.";

const REFUSED_SECRET =
  "Nothing was saved: the text holds the value of a Secret this Session holds, or of the GitHub token. Settings are plain and the user reads them. Say it without the value.";

/**
 * The `settings` extension: its tools over the Session's `SettingsAccess`, refusing text that holds a Secret
 * (`Secrets`) or a deploy-time credential (`DeployCredentials`), reading the Settings again after each change
 * (`SettingsReload`), and telling the Session of each change for the Run's Notification (`AgentChangeLog`).
 */
export const SettingsTools: Effect.Effect<
  Extension,
  never,
  SettingsAccess | SettingsReload | AgentChangeLog | DeployCredentials | Secrets
> = Effect.gen(function* () {
  const access = yield* SettingsAccess;
  const reload = yield* SettingsReload;
  const log = yield* AgentChangeLog;
  const secrets = yield* Secrets;

  const credentials = new Redactions();

  for (const value of (yield* DeployCredentials).values) credentials.hold("GITHUB_TOKEN", value);

  /** Whether `value` holds a Secret's value or a credential, once the Session's Secrets are fresh. */
  const holdsSecret = (value: string) =>
    Effect.map(
      secrets.refresh,
      () => secrets.redact(value) !== value || credentials.redact(value) !== value,
    );

  /**
   * Apply `fields` as `tool`, and say how it went: refused when the reason or any of `texts` holds a Secret, then made
   * by the Registry and, when something changed, read again by the Session. `changed` words the result for the changes
   * recorded and what the Session said of itself; `unchanged` for fields that already had the values.
   */
  const applyChanges = ({
    tool,
    fields,
    texts = [],
    reason,
    conversation,
    unchanged,
    changed,
  }: {
    readonly tool: string;
    readonly fields: ReadonlyArray<SettingsFieldChange>;
    /** The text the values are made of, kept as written: none holds a Secret's value or a credential. */
    readonly texts?: ReadonlyArray<string>;
    readonly reason: string;
    readonly conversation: number;
    readonly unchanged: string;
    readonly changed: (made: {
      readonly changes: ReadonlyArray<AgentChange>;
      readonly applied: SettingsApplied;
    }) => string;
  }) =>
    Effect.gen(function* () {
      const kept = Arr.join([reason, ...texts], "\n");

      if (holdsPlaceholder(kept)) {
        return yield* SettingsAccessError.make({ message: REFUSED_PLACEHOLDER });
      }

      if (yield* holdsSecret(kept)) {
        return yield* SettingsAccessError.make({ message: REFUSED_SECRET });
      }

      const answer = yield* access.change({
        changes: fields,
        author: { conversation, tool, reason },
      });

      switch (answer.status) {
        case "rejected":
          return yield* SettingsAccessError.make({
            message: `Nothing was saved: ${answer.message}`,
          });
        // Only a change made against an expected value, which these tools never give.
        case "changed-since":
          return yield* SettingsAccessError.make({
            message: `Nothing was saved: ${answer.field} changed meanwhile, to ${shown(answer.current)}`,
          });
        case "unchanged":
          return {
            output: [{ type: "text" as const, text: unchanged }],
            details: { unchanged: Arr.map(fields, (field) => field.field), agentChanges: [] },
          };
        case "changed": {
          for (const change of answer.changes) {
            yield* log.record({ tool, field: change.field });
          }

          const applied = yield* reload.apply;

          const forgot =
            answer.dropped === undefined
              ? ""
              : ` The saved overrides held values that no longer applied, and saving has forgotten them: ${answer.dropped}`;

          return {
            output: [
              {
                type: "text" as const,
                text: `${changed({ changes: answer.changes, applied })}${forgot}`,
              },
            ],
            details: {
              unchanged: [],
              agentChanges: Arr.map(answer.changes, (change) => ({
                id: change.id,
                field: change.field,
                before: asJsonValue(change.before),
                after: asJsonValue(change.after),
              })),
            },
          };
        }
      }
    });

  const get = yield* defineEffectTool({
    name: "settings_get",
    description:
      "Show the Settings the user edits on the Settings page: the default model and thinking level, the model roles (model and hint), automatic compaction, the offered tools, the branch summary prompt, the spend limit, and the extensions' options, each marked as an override of the default or not, with any problem with the saved overrides. Use it before a change, to see what there is.",
    parameters: Schema.Struct({}),
    replay: "safe",
    execute: () =>
      Effect.gen(function* () {
        const view = yield* access.get;

        return {
          output: [{ type: "text" as const, text: describeSettings(view) }],
          details: { problem: view.problem ?? null },
        };
      }),
  });

  const model = yield* defineEffectTool({
    name: "settings_model_set",
    description: Arr.join(
      [
        `Set the default model and/or thinking level: what a Session's root conversation runs with until the Session picks its own with the model picker. Models: ${MODEL_LIST}; thinking levels: ${Arr.join(THINKING_LEVELS, ", ")}. Give at least one of them.`,
        "A Session that picked its own model or thinking level keeps its pick; the result says whether this Session did. Otherwise the change reaches this Session's next request, and other Sessions when they next admit input. Subagents keep the agent they started with: their models come from the roles (settings_role_set).",
        LIMIT_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      model: Schema.optionalKey(ModelId.annotate({ description: "The default model" })),
      thinking_level: Schema.optionalKey(
        ThinkingLevel.annotate({ description: "The default thinking level" }),
      ),
      reason: Reason,
    }),
    executionMode: "sequential",
    // A rerun after an eviction would record the change again, against the value it set.
    replay: "unsafe",
    execute: ({ model, thinking_level, reason }, api) =>
      Effect.gen(function* () {
        const fields: SettingsFieldChange[] = [
          ...(model === undefined ? [] : [{ field: "model", value: model }]),
          ...(thinking_level === undefined
            ? []
            : [{ field: "thinkingLevel", value: thinking_level }]),
        ];

        if (fields.length === 0) {
          return yield* SettingsAccessError.make({
            message: "Give a model, a thinking level, or both.",
          });
        }

        return yield* applyChanges({
          tool: "settings_model_set",
          fields,
          reason,
          conversation: api.conversationId,
          unchanged:
            "The default already has these values: nothing changed, and nothing was recorded.",
          changed: ({ changes, applied }) => {
            const kept = Arr.filter(changes, (change) =>
              change.field === "model" ? applied.picked.model : applied.picked.thinkingLevel,
            );

            return Arr.join(
              [
                `Changed the defaults:\n${changedLines(changes)}`,
                kept.length === 0
                  ? "This Session follows the defaults, so its next request uses them."
                  : `This Session picked its own ${Arr.join(
                      Arr.map(kept, (change) => fieldLabel(change.field).replace("default ", "")),
                      " and ",
                    )}, which it keeps; Sessions that follow the defaults use the new ones.`,
              ],
              " ",
            );
          },
        });
      }),
  });

  const role = yield* defineEffectTool({
    name: "settings_role_set",
    description: Arr.join(
      [
        `Set one model role: the model a subagent runs on when it is started with that role, and optionally its hint, the text that tells an agent when to pick it. Roles: ${Arr.join(ROLE_NAMES, ", ")}. Models: ${MODEL_LIST}.`,
        "A hint left out stays as it is. The change reaches the next subagent started, in every Session that has read the Settings; subagents that run keep the model they started with.",
        LIMIT_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      role: Schema.Literals(ROLE_NAMES).annotate({ description: "The role to change" }),
      model: ModelId.annotate({ description: "The role's model" }),
      hint: Schema.optionalKey(
        Schema.String.annotate({
          description: "When an agent should pick this role (replaces the hint it has)",
        }),
      ),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ role, model, hint, reason }, api) =>
      applyChanges({
        tool: "settings_role_set",
        fields: [
          { field: `roles.${role}.model`, value: model },
          ...(hint === undefined ? [] : [{ field: `roles.${role}.hint`, value: hint }]),
        ],
        texts: hint === undefined ? [] : [hint],
        reason,
        conversation: api.conversationId,
        unchanged: `The ${role} role already has ${hint === undefined ? "that model" : "that model and hint"}: nothing changed, and nothing was recorded.`,
        changed: ({ changes }) =>
          `Changed the ${role} role:\n${changedLines(changes)}\nThe next subagent started with the role ${role} uses it.`,
      }),
  });

  const offered = (current: ReadonlyArray<string>, pattern: string) =>
    Arr.filter(current, (entry) => matchesPattern(entry, pattern));

  const offerNote =
    "A tool that a conversation has loaded with tool_search stays offered to it. A pattern is a tool's name, or a name with * for any run of characters (context_*): snake_case, and one that matches no tool does nothing.";

  const offer = yield* defineEffectTool({
    name: "settings_tool_offer",
    description: Arr.join(
      [
        "Offer a tool to the model from the first request: add one entry (a tool's name, or a pattern with * for any run of characters, such as context_*) to the offered tools, which every conversation's model is shown without searching. The rest of the tools are deferred: the model loads them with tool_search, and code mode scripts call them without loading. Every offered tool costs context on every request, so offer what is used constantly.",
        offerNote,
        LIMIT_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      pattern: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: "The tool's name or a pattern, such as web_fetch or settings_*",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ pattern, reason }, api) =>
      Effect.gen(function* () {
        const { settings } = yield* access.get;
        const current = settings.tools.offered;

        if (Arr.contains(current, pattern)) {
          return {
            output: [
              {
                type: "text" as const,
                text: `${pattern} is among the offered tools already: nothing changed, and nothing was recorded.`,
              },
            ],
            details: { unchanged: ["tools.offered"], agentChanges: [] },
          };
        }

        return yield* applyChanges({
          tool: "settings_tool_offer",
          fields: [{ field: "tools.offered", value: [...current, pattern] }],
          texts: [pattern],
          reason,
          conversation: api.conversationId,
          unchanged: `${pattern} is among the offered tools already: nothing changed, and nothing was recorded.`,
          changed: () =>
            `Offered ${pattern}: it is added to the offered tools, so every conversation's model is shown the tools it names from its next request. ${offerNote} ${LIMIT_NOTE}`,
        });
      }),
  });

  const defer = yield* defineEffectTool({
    name: "settings_tool_defer",
    description: Arr.join(
      [
        `Defer a tool: remove one entry (exactly as settings_get lists it) from the offered tools, so the model loads the tools it names with tool_search instead of being shown them. ${Arr.join(ALWAYS_OFFERED, " and ")} stay offered whatever the list says. An entry that is a pattern covers many tools: remove it whole, or offer fewer by replacing it.`,
        "A tool that a conversation has loaded with tool_search stays offered to it.",
        LIMIT_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      pattern: Schema.String.check(Schema.isMinLength(1)).annotate({
        description:
          "The entry of the offered tools to remove, as settings_get shows it (a tool's name or a pattern)",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ pattern, reason }, api) =>
      Effect.gen(function* () {
        const { settings } = yield* access.get;
        const current = settings.tools.offered;

        if (!Arr.contains(current, pattern)) {
          const covering = offered(current, pattern);

          return {
            output: [
              {
                type: "text" as const,
                text: `The offered tools have no entry "${pattern}": nothing changed, and nothing was recorded.${
                  covering.length === 0
                    ? ""
                    : ` ${pattern} is offered by ${Arr.join(covering, ", ")}: defer that entry to defer it.`
                }`,
              },
            ],
            details: { unchanged: ["tools.offered"], agentChanges: [] },
          };
        }

        return yield* applyChanges({
          tool: "settings_tool_defer",
          fields: [
            { field: "tools.offered", value: Arr.filter(current, (entry) => entry !== pattern) },
          ],
          reason,
          conversation: api.conversationId,
          unchanged: `${pattern} is not among the offered tools: nothing changed, and nothing was recorded.`,
          changed: () =>
            `Deferred ${pattern}: it is removed from the offered tools, so the tools it names are loaded with tool_search from the next request of each conversation${
              Arr.contains(ALWAYS_OFFERED, pattern)
                ? `. ${pattern} stays offered whatever the list says`
                : ""
            }. A tool a conversation has loaded stays offered to it. ${LIMIT_NOTE}`,
        });
      }),
  });

  const compaction = yield* defineEffectTool({
    name: "settings_compaction_set",
    description: Arr.join(
      [
        "Set automatic compaction: whether a conversation's context is summarized before it outgrows the model's window, and how. Give at least one of the settings; those left out stay as they are.",
        "`enabled` turns it on or off. `reserve_tokens` is the room kept free for the next answer (the window minus this triggers compaction), `keep_recent_tokens` how much of the latest messages a compaction keeps as they are, and `background_tokens` how far before the trigger a compaction may start in the background (0 turns that off). The token counts are whole numbers; reserve and keep above 0.",
        LIMIT_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      reserve_tokens: Schema.optionalKey(Schema.Finite),
      keep_recent_tokens: Schema.optionalKey(Schema.Finite),
      background_tokens: Schema.optionalKey(Schema.Finite),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      Effect.gen(function* () {
        const fields: SettingsFieldChange[] = [
          ...(args.enabled === undefined
            ? []
            : [{ field: "compaction.enabled", value: args.enabled }]),
          ...(args.reserve_tokens === undefined
            ? []
            : [{ field: "compaction.reserveTokens", value: args.reserve_tokens }]),
          ...(args.keep_recent_tokens === undefined
            ? []
            : [{ field: "compaction.keepRecentTokens", value: args.keep_recent_tokens }]),
          ...(args.background_tokens === undefined
            ? []
            : [{ field: "compaction.backgroundTokens", value: args.background_tokens }]),
        ];

        if (fields.length === 0) {
          return yield* SettingsAccessError.make({
            message:
              "Give at least one of enabled, reserve_tokens, keep_recent_tokens and background_tokens.",
          });
        }

        return yield* applyChanges({
          tool: "settings_compaction_set",
          fields,
          reason: args.reason,
          conversation: api.conversationId,
          unchanged:
            "Compaction already has these values: nothing changed, and nothing was recorded.",
          changed: ({ changes }) =>
            `Changed compaction:\n${changedLines(changes)}\nIt applies from the next request of each conversation.`,
        });
      }),
  });

  const branchSummary = yield* defineEffectTool({
    name: "settings_branch_summary_set",
    description: Arr.join(
      [
        "Set whether the web app asks, when the user moves to another point of a Session's tree, whether to carry a summary of the branch they leave (a model request on the Session's usage). With skip_prompt true it does not ask and carries no summary; false asks.",
        LIMIT_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      skip_prompt: Schema.Boolean.annotate({
        description: "True: leave a branch without asking or summarizing",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ skip_prompt, reason }, api) =>
      applyChanges({
        tool: "settings_branch_summary_set",
        fields: [{ field: "branchSummary.skipPrompt", value: skip_prompt }],
        reason,
        conversation: api.conversationId,
        unchanged: `The branch summary prompt is ${skip_prompt ? "skipped" : "asked"} already: nothing changed, and nothing was recorded.`,
        changed: ({ changes }) => `Changed the branch summary prompt:\n${changedLines(changes)}`,
      }),
  });

  const extension = yield* defineEffectTool({
    name: "settings_extension_set",
    description: Arr.join(
      [
        `Set one option of one extension: the settings keep each extension's options under its name, and an extension reads the ones it knows. The subagents extension reads ${Arr.join(SUBAGENT_TOOLSET_OPTIONS, ", ")} (lists of tool names or patterns with *: the tools a subagent is granted); an option no extension reads is saved and does nothing. A value of null takes the option away, back to the extension's default.`,
        "The subagent depth (subagents.maxSubagentDepth) is a Limit: it is not set here, but with settings_subagent_depth_set, which asks the user for their Approval.",
        LIMIT_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      extension: Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/^[^.]+$/)).annotate({
        description: "The extension's name, without dots, such as subagents",
      }),
      key: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: "The option's name, such as readToolset",
      }),
      value: Schema.Json.annotate({
        description: "The option's value (JSON); null takes the option away",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ extension, key, value, reason }, api) =>
      Effect.gen(function* () {
        if (extension === "subagents" && key === "maxSubagentDepth") {
          return yield* SettingsAccessError.make({
            message:
              "subagents.maxSubagentDepth is a Limit: it is not set with settings_extension_set. Use settings_subagent_depth_set, which asks the user for their Approval.",
          });
        }

        if (
          extension === "subagents" &&
          Arr.contains(SUBAGENT_TOOLSET_OPTIONS, key) &&
          value !== null &&
          !Schema.is(Schema.Array(Schema.String))(value)
        ) {
          return yield* SettingsAccessError.make({
            message: `Nothing was saved: ${extension}.${key} is a list of tool names or patterns, and the subagents extension ignores every option of its own when one is not.`,
          });
        }

        return yield* applyChanges({
          tool: "settings_extension_set",
          fields: [{ field: extensionField(extension, key), value }],
          texts: [jsonText(value)],
          reason,
          conversation: api.conversationId,
          unchanged:
            value === null
              ? `${extension}.${key} is not set: nothing changed, and nothing was recorded.`
              : `${extension}.${key} already has that value: nothing changed, and nothing was recorded.`,
          changed: ({ changes }) =>
            `Changed ${extension}.${key}:\n${changedLines(changes)}\n${
              extension === "subagents" && Arr.contains(SUBAGENT_TOOLSET_OPTIONS, key)
                ? "It applies to the next subagent started."
                : `Only an extension that reads ${extension}.${key} is affected by it.`
            }`,
        });
      }),
  });

  return defineExtension({
    name: extensionName,
    tools: [get, model, role, offer, defer, compaction, branchSummary, extension],
  });
});
