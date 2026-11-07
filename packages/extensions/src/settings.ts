// The `settings` extension (`docs/architecture/agent-changes.md`, ADR-0019): the agent's tools for the Settings the owner edits
// on the Settings page, one tool for each thing it may change: `settings_get`, `settings_model_set`,
// `settings_role_set`, `settings_tool_offer`, `settings_tool_defer`, `settings_compaction_set`,
// `settings_branch_summary_set` and `settings_extension_set`. The Limits (`spendLimit.perSession`, the subagent
// depth and the Subagent Workspace limit) are not among them: their tools wait for the owner's Approval
// (`./approval-tools.ts`), as `settings_reset` does for a Limit. Every tool takes a required `scope` (ADR-0027): `*` for Global, or an Environment's id, whose Overrides
// it reads and changes. Each change is an Agent change: the Registry applies it as the owner's save is applied and
// records it under the Scope, the Session reads the Settings again at once, and the Run's end notifies the owner of the
// changes it made (`AgentChangeLog`). They are the root conversation's only (`PARENT_ONLY_TOOL_PREFIXES`), as
// `secret_ask` is. Values are plain: a change is refused when its reason or its text holds a Secret the Session holds
// or a GitHub credential. Each tool gives programs its result
// (`docs/architecture/agent-capabilities.md` → Values for programs) as a `structuredOutput` (`./settings-outputs.ts`,
// `./outputs.ts`): the Scope, the Agent changes made and the fields that already had their value, or, for
// `settings_get`, the Settings by field.
// @effect-diagnostics missingPipeableSignature:off
import {
  extensionField,
  ModelId,
  overrideValue,
  resetsOverride,
  ROLE_NAMES,
  SUPPORTED_MODELS,
  THINKING_LEVELS,
  ThinkingLevel,
  matchesToolPattern,
} from "@cloudpid/config";
import { defineEffectTool } from "@cloudpid/effect-durable";
import type { AgentChange, McpChangeGuard } from "@cloudpid/protocol";
import {
  GLOBAL_SETTINGS_SCOPE,
  HARNESS_TOOLS,
  SettingsScope,
} from "@cloudpid/protocol/harness-tools";
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
  credentialCheck,
  type DeployCredentials,
  MAX_CHANGE_REASON,
} from "./environment.ts";
import { toolResult } from "./harness.ts";
import { APPROVED, ChangeOutput, outputSchema } from "./outputs.ts";
import { holdsPlaceholder } from "./secrets/references.ts";
import { Secrets } from "./secrets/store.ts";
import {
  isGlobalView,
  roleOf,
  scopeName,
  SettingsAccessError,
  type SettingsView,
  shown,
} from "./settings-describe.ts";
import { settingsGetRead } from "./settings-reads.ts";
import { settingsChangeOutput } from "./settings-outputs.ts";
import { SUBAGENT_TOOLSET_OPTIONS } from "./subagents/options.ts";
import { ALWAYS_OFFERED } from "./tool-search.ts";

export const extensionName = "settings";

/** The prefix of every tool of the extension: all of them are the root conversation's only. */
export const SETTINGS_TOOL_PREFIX = "settings_";

// The supported import path for these, `apps/server` included, is this module: the leaf is an internal split.
export {
  describeSettings,
  type EnvironmentSettingsView,
  type GlobalSettingsView,
  isGlobalView,
  scopeName,
  SettingsAccessError,
  settingsOutput,
  type SettingsView,
  shown,
} from "./settings-describe.ts";

/**
 * One setting given a new value: a settings field (`model`, `roles.small`, `compaction.enabled`,
 * `extensions.<extension>.<key>`); null takes an option away. With `reset`, the field goes back to its default
 * (Global) or to inheriting Global (an Environment). With `expected`, it is changed only while it has that value (null:
 * not set) and, at an Environment, is inherited or not as `inherited` says: what the owner saw when they approved it.
 */
export type SettingsFieldChange = {
  readonly field: string;
  readonly value: Schema.Json | null;
  readonly reset?: true | undefined;
  readonly expected?:
    | { readonly value: Schema.Json | null; readonly inherited?: boolean | undefined }
    | undefined;
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
  /**
   * A field no longer has the value it was approved against: it is `current` (at an Environment, `inherited` or not),
   * and nothing was saved.
   */
  | {
      readonly status: "changed-since";
      readonly field: string;
      readonly current: Schema.Json | null;
      readonly inherited?: boolean | undefined;
    };

/** The Settings, as the Session reaches them through the Registry. */
export type SettingsAccessService = {
  /** The Settings of `scope`: `*` (Global) or an Environment's id; an id no Environment has fails, saying so. */
  readonly get: (scope: string) => Effect.Effect<SettingsView, SettingsAccessError>;
  /** The Session's own Environment, whose Settings its requests run with; null when the Registry does not list it. */
  readonly own: Effect.Effect<string | null, SettingsAccessError>;
  /**
   * Apply `changes` at `scope` as the owner's save does (Global's overrides, or the Environment's Overrides) and record
   * each field that changed with its `author`, under the Scope.
   */
  readonly change: (input: {
    readonly scope: string;
    readonly changes: ReadonlyArray<SettingsFieldChange>;
    readonly author: ChangeAuthor;
    /** An agent's MCP change: what the Registry checks again in the transaction that writes it (`McpChangeGuard`). */
    readonly guard?: McpChangeGuard | undefined;
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

/** What the descriptions of the changing tools say of the `scope`. */
export const SCOPE_NOTE = `Give scope "${GLOBAL_SETTINGS_SCOPE}" to change Global, which each Environment inherits unless it overrides the field, or an Environment's id (environment_list shows them) to override Global for that Environment's Sessions only; there is no default. At an Environment the value is kept as its Override even when it equals Global's, so the field stops following Global until settings_reset removes the Override.`;

/** What the descriptions of the changing tools say of the record and of the Sessions a change reaches. */
export const CHANGE_NOTE =
  "The change is recorded with your reason, and the user can see and revert it on the Settings page. Each Session runs with its own Environment's Settings (its Overrides over Global over the defaults): a change at an Environment reaches only that Environment's Sessions, and a change at Global only those whose Environment does not override the field. A Session it reaches uses it from its next request (this one) or when it next admits input (the others); the result says whether it reaches this Session.";

const MODEL_LIST = Arr.join(SUPPORTED_MODELS, ", ");

/** What a value at an Environment says of where it comes from; nothing at Global, where nothing is inherited. */
export const inheritedWords = (inherited: boolean | undefined): string => {
  if (inherited === undefined) return "";

  return inherited ? " (inherited from Global)" : " (overridden)";
};

const SETTING_LABELS: Readonly<Record<string, string>> = {
  model: "default model",
  thinkingLevel: "default thinking level",
  "tools.offered": "offered tools",
  "branchSummary.skipPrompt": "skip of the branch summary prompt",
  "spendLimit.perSession": "spend limit per Session",
  instructions: "Instructions",
};

/** A settings field as a result names it. */
export const fieldLabel = (field: string): string => {
  const known = SETTING_LABELS[field];

  if (known !== undefined) return known;

  const role = /^roles\.(\w+)$/.exec(field);

  if (role !== null) return `${role[1]} role`;

  const rolePart = /^roles\.(\w+)\.(model|hint)$/.exec(field);

  if (rolePart !== null) return `${rolePart[2]} of the ${rolePart[1]} role`;

  const compaction = /^compaction\.(\w+)$/.exec(field);

  if (compaction !== null) return `compaction ${compaction[1]}`;

  return field.startsWith("extensions.") ? `extension option ${field.slice(11)}` : field;
};

/** One change as a result lists it: the field with its value before and after, a Role's hint only when it changed. */
const changedLine = (change: AgentChange): string => {
  const before = roleOf(change.before);
  const after = roleOf(change.after);

  const sameHint =
    Option.isSome(before) && Option.isSome(after) && before.value.hint === after.value.hint;

  const words = (value: Schema.Json | null, role: typeof before, inherited?: boolean) =>
    `${sameHint && Option.isSome(role) ? role.value.model : shown(value)}${inheritedWords(inherited)}`;

  return `- ${fieldLabel(change.field)}: it was ${words(change.before, before, change.beforeInherited)}, and is ${words(change.after, after, change.afterInherited)} now${sameHint ? ", with the same hint" : ""}.`;
};

/** The changes as a result lists them: each field with its value before and after. */
export const changedLines = (changes: ReadonlyArray<AgentChange>): string =>
  Arr.join(Arr.map(changes, changedLine), "\n");

/** The Settings a card names as the target: Global's, or an Environment's by name. */
export const settingsTarget = (view: SettingsView): string =>
  isGlobalView(view)
    ? "the Global Settings"
    : `Environment ${JSON.stringify(view.name)}'s Settings`;

/** Where a change was made, as a result says it: "at Global", or "for" the Environment. */
export const scopeWhere = (view: SettingsView): string =>
  isGlobalView(view) ? "at Global" : `for ${scopeName(view)}`;

/** A Schema `Json` value as the details' `JsonValue`, which differs only in that its arrays are mutable. */
// SAFETY: the two types describe the same values; the details are never mutated.
const asJsonValue = (value: Schema.Json | null): JsonValue => value as JsonValue;

/** A change for the Run's Notification: the tool and the field, with the Environment's name at an Environment. */
export const loggedChange = (view: SettingsView, tool: string, field: string) =>
  isGlobalView(view) ? { tool, field } : { tool, field, environmentName: view.name };

/** The changes as a result's `details.agentChanges` carry them, each with its Scope and, at an Environment, inheritance. */
export const agentChangeDetails = (view: SettingsView, changes: ReadonlyArray<AgentChange>) =>
  Arr.map(changes, (change) => {
    const made = {
      id: change.id,
      scope: view.scope,
      field: change.field,
      before: asJsonValue(change.before),
      after: asJsonValue(change.after),
    };

    if (isGlobalView(view)) return made;

    // A change at an Environment names it, for the transcript's card, and says whether the field was inherited before
    // and after it; one at Global does neither.
    return {
      ...made,
      environment: { id: view.scope, name: view.name },
      beforeInherited: change.beforeInherited === true,
      afterInherited: change.afterInherited === true,
    };
  });

const encodeJsonText = Schema.encodeOption(Schema.fromJsonString(Schema.Json));

/**
 * A JSON value as text, the text a Secret could hide in at any depth: the redaction of a Secret knows the form its value
 * takes inside a JSON string.
 */
const jsonText = (value: Schema.Json | null): string =>
  Option.getOrElse(encodeJsonText(value), () => "");

/** Why a text that holds a Secret Reference is refused: the tools resolve none, so the Settings would hold its text. */
const REFUSED_PLACEHOLDER =
  "the reason or a text of the call holds a Secret Reference, which these tools do not resolve, so the Settings would hold the reference's text, not the Secret. Settings are plain and the user reads them. Say it without the reference.";

const REFUSED_SECRET =
  "the text holds the value of a Secret this Session holds, or a GitHub token or the GitHub App's key. Settings are plain and the user reads them. Say it without the value.";

/** Whether a change reaches this Session, field by field, and what a result says of it. */
export type SettingsReach = {
  readonly reaches: (field: string) => boolean;
  readonly text: string;
};

/** What a change made by `tool` at `view`'s Scope answers, once made: its words and its details. */
export type SettingsChangeRequest = {
  readonly tool: string;
  /** The Scope's Settings, read before the change. */
  readonly view: SettingsView;
  readonly fields: ReadonlyArray<SettingsFieldChange>;
  /** The text the values are made of, kept as written: none holds a Secret's value or a credential. */
  readonly texts?: ReadonlyArray<string>;
  readonly reason: string;
  readonly conversation: number;
  /** The result's words when nothing changed; an Effect where they wait for something (the MCP tools' status after an approved change). */
  readonly unchanged: string | Effect.Effect<string>;
  /** The owner approved this change: it is recorded as approved, and refusals and answers say "The user approved, but …". */
  readonly approved?: true | undefined;
  /** An agent's MCP change: what the Registry checks again as it writes. */
  readonly guard?: McpChangeGuard | undefined;
  /** The result's words; an Effect where the words wait for something that happens after the change (the MCP tools' pushes). */
  readonly changed: (made: {
    readonly changes: ReadonlyArray<AgentChange>;
    readonly applied: SettingsApplied;
    readonly reach: SettingsReach;
  }) => string | Effect.Effect<string>;
};

/**
 * How the settings tools change the Settings, over the Session's `SettingsAccess`: refusing text that holds a Secret
 * (`Secrets`) or a deploy-time credential (`DeployCredentials`), reading the Settings again after each change
 * (`SettingsReload`), telling the Session of each change for the Run's Notification (`AgentChangeLog`), and saying
 * whether a change reaches this Session.
 */
export const SettingsChanges = Effect.gen(function* () {
  const access = yield* SettingsAccess;
  const reload = yield* SettingsReload;
  const log = yield* AgentChangeLog;
  const secrets = yield* Secrets;

  const holdsCredential = yield* credentialCheck;

  /** Whether `value` holds a Secret's value or a credential, once the Session's Secrets are fresh. */
  const holdsSecret = (value: string) =>
    Effect.map(secrets.refresh, () => secrets.redact(value) !== value || holdsCredential(value));

  /**
   * Whether a change of `fields` at `view`'s Scope reaches this Session, which runs with its own Environment's
   * Settings: a change at another Environment does not, nor one at Global of a field its Environment overrides.
   */
  const reach = (view: SettingsView, fields: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const own = yield* access.own;

      if (!isGlobalView(view)) {
        return view.scope === own
          ? {
              reaches: () => true,
              text: `This Session runs in ${scopeName(view)}, so the change reaches its next request; the Environment's other Sessions get it when they next admit input.`,
            }
          : {
              reaches: () => false,
              text: `This Session runs with the Settings of its own Environment${own === null ? "" : ` (id ${own})`}, so a change ${scopeWhere(view)} does not reach it: that Environment's Sessions get it when they next admit input.`,
            };
      }

      const others = `other Sessions get it when they next admit input, unless their Environment overrides the field (settings_get with scope "${GLOBAL_SETTINGS_SCOPE}" names those Environments).`;

      if (own === null) {
        return {
          reaches: () => true,
          text: `The change reaches the next request of this Session unless its Environment overrides the field; ${others}`,
        };
      }

      const ownView = yield* access.get(own);

      const held = isGlobalView(ownView)
        ? []
        : Arr.filter(fields, (field) => Option.isSome(overrideValue(ownView.overrides, field)));

      if (held.length === 0) {
        return {
          reaches: () => true,
          text: `This Session's Environment does not override it, so the change reaches its next request; ${others}`,
        };
      }

      const labels = Arr.join(Arr.map(held, fieldLabel), " and ");
      const overrides = `This Session's own ${scopeName(ownView)} overrides the ${labels}`;

      return {
        reaches: (field: string) => !Arr.contains(held, field),
        text:
          held.length < fields.length
            ? `${overrides}, so that part of the change does not reach this Session, nor the Environment's other Sessions; the rest reaches this Session's next request, and ${others}`
            : `${overrides}, so the change does not reach this Session, nor the Environment's other Sessions; ${others}`,
      };
    }).pipe(
      Effect.orElseSucceed((): SettingsReach => ({
        reaches: () => true,
        text: "A Session gets it from its next request if it runs with these Settings: its own Environment's, which inherit Global's unless they override the field.",
      })),
    );

  /**
   * Refuse, asking nobody, a `reason` or any of `texts` that holds a Secret the Session holds, a deploy-time credential or a
   * Secret Reference's placeholder (the Settings are plain, and the user reads them).
   */
  const plain = (
    reason: string,
    texts: ReadonlyArray<string>,
    /** How the refusal begins: what the tool did not do. */
    outcome = "Nothing was saved",
  ) =>
    Effect.gen(function* () {
      const kept = Arr.join([reason, ...texts], "\n");

      if (holdsPlaceholder(kept)) {
        return yield* SettingsAccessError.make({ message: `${outcome}: ${REFUSED_PLACEHOLDER}` });
      }

      if (yield* holdsSecret(kept)) {
        return yield* SettingsAccessError.make({ message: `${outcome}: ${REFUSED_SECRET}` });
      }
    });

  /**
   * Apply `fields` at the Scope as `tool`, and say how it went: refused when the reason or any of `texts` holds a
   * Secret, then made by the Registry and, when something changed, read again by the Session. `changed` words the
   * result for the changes recorded, what the Session said of itself and whether the change reaches it; `unchanged`
   * for fields that already had the values.
   */
  const apply = ({
    tool,
    view,
    fields,
    texts = [],
    reason,
    conversation,
    unchanged,
    approved,
    guard,
    changed,
  }: SettingsChangeRequest) =>
    Effect.gen(function* () {
      yield* plain(reason, texts);

      const approval = approved === true ? APPROVED : null;
      const approvedDetails = approved === true ? { approval: { approved: true } } : {};

      const author =
        approved === true
          ? { conversation, tool, reason, approved }
          : { conversation, tool, reason };

      const guarded = guard === undefined ? {} : { guard };

      const answer = yield* access.change({
        scope: view.scope,
        changes: fields,
        author,
        ...guarded,
      });

      switch (answer.status) {
        case "rejected":
          return yield* SettingsAccessError.make({
            message: `${approved === true ? "The user approved, but nothing was saved" : "Nothing was saved"}: ${answer.message}`,
          });
        // Only a change made against an expected value: the one the owner saw.
        case "changed-since":
          return yield* SettingsAccessError.make({
            message:
              approved === true
                ? `The user approved, but ${answer.field} changed since they were asked: it is ${shown(answer.current)}${inheritedWords(answer.inherited)} now, so the change they saw was not made and nothing was saved. Ask again with the value as it is now if the change is still needed.`
                : `Nothing was saved: ${answer.field} changed meanwhile, to ${shown(answer.current)}${inheritedWords(answer.inherited)}`,
          });
        case "unchanged":
          return {
            output: [
              {
                type: "text" as const,
                text: Predicate.isString(unchanged) ? unchanged : yield* unchanged,
              },
            ],
            structuredOutput: settingsChangeOutput({
              view,
              changes: [],
              unchanged: Arr.map(fields, (field) => field.field),
              approval,
            }),
            details: {
              scope: view.scope,
              unchanged: Arr.map(fields, (field) => field.field),
              agentChanges: [],
              ...approvedDetails,
            },
          };
        case "changed": {
          for (const change of answer.changes) {
            yield* log.record(loggedChange(view, tool, change.field));
          }

          const applied = yield* reload.apply;

          const reached = yield* reach(
            view,
            Arr.map(answer.changes, (change) => change.field),
          );

          const said = changed({ changes: answer.changes, applied, reach: reached });
          const words = Predicate.isString(said) ? said : yield* said;

          const forgot =
            answer.dropped === undefined
              ? ""
              : ` The saved overrides held values that no longer applied, and saving has forgotten them: ${answer.dropped}`;

          return {
            output: [
              {
                type: "text" as const,
                text: `${words}${forgot}`,
              },
            ],
            structuredOutput: settingsChangeOutput({
              view,
              changes: answer.changes,
              // Fields that already had their value are not among the changes the Registry recorded.
              unchanged: Arr.filter(
                Arr.map(fields, (field) => field.field),
                (name) => !Arr.some(answer.changes, (change) => change.field === name),
              ),
              approval,
            }),
            details: {
              scope: view.scope,
              unchanged: [],
              agentChanges: agentChangeDetails(view, answer.changes),
              ...approvedDetails,
            },
          };
        }
      }
    });

  return { apply, reach, plain };
});

export const RECORDED =
  "The change is recorded with your reason; the user can see and revert it on the Settings page.";

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
  const { apply } = yield* SettingsChanges;

  const getRead = settingsGetRead(access);

  const get = yield* defineEffectTool({
    name: HARNESS_TOOLS.settings_get.name,
    description: HARNESS_TOOLS.settings_get.session.description,
    parameters: HARNESS_TOOLS.settings_get.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.settings_get.session.output),
    replay: "safe",
    execute: (args) => Effect.map(getRead(args, "session"), toolResult),
  });

  const model = yield* defineEffectTool({
    name: "settings_model_set",
    description: Arr.join(
      [
        `Set the default model and/or thinking level: what a Session's root conversation runs with until the Session picks its own with the model picker. Models: ${MODEL_LIST}; thinking levels: ${Arr.join(THINKING_LEVELS, ", ")}. Give at least one of them.`,
        "A Session that picked its own model or thinking level keeps its pick; the result says whether this Session did. Subagents keep the agent they started with: their models come from the roles (settings_role_set).",
        SCOPE_NOTE,
        CHANGE_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      scope: SettingsScope,
      model: Schema.optionalKey(ModelId.annotate({ description: "The default model" })),
      thinking_level: Schema.optionalKey(
        ThinkingLevel.annotate({ description: "The default thinking level" }),
      ),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(ChangeOutput),
    executionMode: "sequential",
    // A rerun after an eviction would record the change again, against the value it set.
    replay: "unsafe",
    execute: ({ scope, model, thinking_level, reason }, api) =>
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

        const view = yield* access.get(scope);

        return yield* apply({
          tool: "settings_model_set",
          view,
          fields,
          reason,
          conversation: api.conversationId,
          unchanged: isGlobalView(view)
            ? "The default already has these values at Global: nothing changed, and nothing was recorded."
            : `${scopeName(view)} overrides the default with these values already: nothing changed, and nothing was recorded.`,
          changed: ({ changes, applied, reach }) => {
            const reaching = Arr.filter(changes, (change) => reach.reaches(change.field));

            const kept = Arr.filter(reaching, (change) =>
              change.field === "model" ? applied.picked.model : applied.picked.thinkingLevel,
            );

            return Arr.join(
              [
                `Changed the defaults ${scopeWhere(view)}:\n${changedLines(changes)}`,
                reach.text,
                ...(reaching.length === 0
                  ? []
                  : [
                      kept.length === 0
                        ? "This Session follows the defaults, so its next request uses them."
                        : `This Session picked its own ${Arr.join(
                            Arr.map(kept, (change) =>
                              fieldLabel(change.field).replace("default ", ""),
                            ),
                            " and ",
                          )}, which it keeps; Sessions that follow the defaults use the new ones.`,
                    ]),
                RECORDED,
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
        "A Role's model and hint are one setting: a hint left out keeps the hint the role has at that Scope now, and at an Environment the two are its Override together. The change reaches the next subagent started; subagents that run keep the model they started with.",
        SCOPE_NOTE,
        CHANGE_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      scope: SettingsScope,
      role: Schema.Literals(ROLE_NAMES).annotate({ description: "The role to change" }),
      model: ModelId.annotate({ description: "The role's model" }),
      hint: Schema.optionalKey(
        Schema.String.annotate({
          description: "When an agent should pick this role (replaces the hint it has)",
        }),
      ),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(ChangeOutput),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ scope, role, model, hint, reason }, api) =>
      Effect.gen(function* () {
        const view = yield* access.get(scope);

        return yield* apply({
          tool: "settings_role_set",
          view,
          fields: [
            {
              field: `roles.${role}`,
              value: { model, hint: hint ?? view.settings.roles[role].hint },
            },
          ],
          texts: hint === undefined ? [] : [hint],
          reason,
          conversation: api.conversationId,
          unchanged: isGlobalView(view)
            ? `The ${role} role already has ${hint === undefined ? "that model" : "that model and hint"} at Global: nothing changed, and nothing was recorded.`
            : `${scopeName(view)} overrides the ${role} role with ${hint === undefined ? "that model" : "that model and hint"} already: nothing changed, and nothing was recorded.`,
          changed: ({ changes, reach }) =>
            `Changed the ${role} role ${scopeWhere(view)}:\n${changedLines(changes)}\nThe next subagent started with the role ${role} where the change applies uses it. ${reach.text} ${RECORDED}`,
        });
      }),
  });

  const offered = (current: ReadonlyArray<string>, pattern: string) =>
    Arr.filter(current, (entry) => matchesToolPattern(entry, pattern));

  const offerNote =
    "A tool that a conversation has loaded with tool_search stays offered to it. A pattern is a tool's name, or a name with * for any run of characters (context_*): snake_case, and one that matches no tool does nothing.";

  const listNote =
    "The offered tools are one setting: the list in force at the Scope gets the entry, and is saved whole there (at an Environment, as its Override).";

  const offer = yield* defineEffectTool({
    name: "settings_tool_offer",
    description: Arr.join(
      [
        "Offer a tool to the model from the first request: add one entry (a tool's name, or a pattern with * for any run of characters, such as context_*) to the offered tools, which every conversation's model is shown without searching. The rest of the tools are deferred: the model loads them with tool_search, and code mode scripts call them without loading. Every offered tool costs context on every request, so offer what is used constantly.",
        offerNote,
        listNote,
        SCOPE_NOTE,
        CHANGE_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      scope: SettingsScope,
      pattern: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: "The tool's name or a pattern, such as web_fetch or settings_*",
      }),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(ChangeOutput),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ scope, pattern, reason }, api) =>
      Effect.gen(function* () {
        const view = yield* access.get(scope);
        const current = view.settings.tools.offered;
        const already = `${pattern} is among the offered tools ${scopeWhere(view)} already: nothing changed, and nothing was recorded.`;

        if (Arr.contains(current, pattern)) {
          return {
            output: [{ type: "text" as const, text: already }],
            structuredOutput: settingsChangeOutput({
              view,
              changes: [],
              unchanged: ["tools.offered"],
              approval: null,
            }),
            details: { scope: view.scope, unchanged: ["tools.offered"], agentChanges: [] },
          };
        }

        return yield* apply({
          tool: "settings_tool_offer",
          view,
          fields: [{ field: "tools.offered", value: [...current, pattern] }],
          texts: [pattern],
          reason,
          conversation: api.conversationId,
          unchanged: already,
          changed: ({ reach }) =>
            `Offered ${pattern} ${scopeWhere(view)}: it is added to the offered tools, so the model of each conversation the change reaches is shown the tools it names from its next request. ${reach.text} ${offerNote} ${RECORDED}`,
        });
      }),
  });

  const defer = yield* defineEffectTool({
    name: "settings_tool_defer",
    description: Arr.join(
      [
        `Defer a tool: remove one entry (exactly as settings_get lists it) from the offered tools, so the model loads the tools it names with tool_search instead of being shown them. ${Arr.join(ALWAYS_OFFERED, " and ")} stay offered whatever the list says. An entry that is a pattern covers many tools: remove it whole, or offer fewer by replacing it.`,
        "A tool that a conversation has loaded with tool_search stays offered to it.",
        listNote,
        SCOPE_NOTE,
        CHANGE_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      scope: SettingsScope,
      pattern: Schema.String.check(Schema.isMinLength(1)).annotate({
        description:
          "The entry of the offered tools to remove, as settings_get shows it (a tool's name or a pattern)",
      }),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(ChangeOutput),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ scope, pattern, reason }, api) =>
      Effect.gen(function* () {
        const view = yield* access.get(scope);
        const current = view.settings.tools.offered;

        if (!Arr.contains(current, pattern)) {
          const covering = offered(current, pattern);

          return {
            output: [
              {
                type: "text" as const,
                text: `The offered tools ${scopeWhere(view)} have no entry "${pattern}": nothing changed, and nothing was recorded.${
                  covering.length === 0
                    ? ""
                    : ` ${pattern} is offered by ${Arr.join(covering, ", ")}: defer that entry to defer it.`
                }`,
              },
            ],
            structuredOutput: settingsChangeOutput({
              view,
              changes: [],
              unchanged: ["tools.offered"],
              approval: null,
            }),
            details: { scope: view.scope, unchanged: ["tools.offered"], agentChanges: [] },
          };
        }

        return yield* apply({
          tool: "settings_tool_defer",
          view,
          fields: [
            { field: "tools.offered", value: Arr.filter(current, (entry) => entry !== pattern) },
          ],
          reason,
          conversation: api.conversationId,
          unchanged: `${pattern} is not among the offered tools ${scopeWhere(view)}: nothing changed, and nothing was recorded.`,
          changed: ({ reach }) =>
            `Deferred ${pattern} ${scopeWhere(view)}: it is removed from the offered tools, so the tools it names are loaded with tool_search from the next request of each conversation the change reaches${
              Arr.contains(ALWAYS_OFFERED, pattern)
                ? `. ${pattern} stays offered whatever the list says`
                : ""
            }. A tool a conversation has loaded stays offered to it. ${reach.text} ${RECORDED}`,
        });
      }),
  });

  const compaction = yield* defineEffectTool({
    name: "settings_compaction_set",
    description: Arr.join(
      [
        "Set automatic compaction: whether a conversation's context is summarized before it outgrows the model's window, and how. Give at least one of the settings; those left out stay as they are. Each is a setting of its own, overridden at an Environment by itself.",
        "`enabled` turns it on or off. `reserve_tokens` is the room kept free for the next answer (the window minus this triggers compaction), `keep_recent_tokens` how much of the latest messages a compaction keeps as they are, and `background_tokens` how far before the trigger a compaction may start in the background (0 turns that off). The token counts are whole numbers; reserve and keep above 0.",
        SCOPE_NOTE,
        CHANGE_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      scope: SettingsScope,
      enabled: Schema.optionalKey(Schema.Boolean),
      reserve_tokens: Schema.optionalKey(Schema.Finite),
      keep_recent_tokens: Schema.optionalKey(Schema.Finite),
      background_tokens: Schema.optionalKey(Schema.Finite),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(ChangeOutput),
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

        const view = yield* access.get(args.scope);

        return yield* apply({
          tool: "settings_compaction_set",
          view,
          fields,
          reason: args.reason,
          conversation: api.conversationId,
          unchanged: isGlobalView(view)
            ? "Compaction already has these values at Global: nothing changed, and nothing was recorded."
            : `${scopeName(view)} overrides compaction with these values already: nothing changed, and nothing was recorded.`,
          changed: ({ changes, reach }) =>
            `Changed compaction ${scopeWhere(view)}:\n${changedLines(changes)}\nIt applies from the next request of each conversation the change reaches. ${reach.text} ${RECORDED}`,
        });
      }),
  });

  const branchSummary = yield* defineEffectTool({
    name: "settings_branch_summary_set",
    description: Arr.join(
      [
        "Set whether the web app asks, when the user moves to another point of a Session's tree, whether to carry a summary of the branch they leave (a model request on the Session's usage). With skip_prompt true it does not ask and carries no summary; false asks.",
        SCOPE_NOTE,
        CHANGE_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      scope: SettingsScope,
      skip_prompt: Schema.Boolean.annotate({
        description: "True: leave a branch without asking or summarizing",
      }),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(ChangeOutput),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ scope, skip_prompt, reason }, api) =>
      Effect.gen(function* () {
        const view = yield* access.get(scope);

        return yield* apply({
          tool: "settings_branch_summary_set",
          view,
          fields: [{ field: "branchSummary.skipPrompt", value: skip_prompt }],
          reason,
          conversation: api.conversationId,
          unchanged: isGlobalView(view)
            ? `The branch summary prompt is ${skip_prompt ? "skipped" : "asked"} at Global already: nothing changed, and nothing was recorded.`
            : `${scopeName(view)} overrides the branch summary prompt to be ${skip_prompt ? "skipped" : "asked"} already: nothing changed, and nothing was recorded.`,
          changed: ({ changes, reach }) =>
            `Changed the branch summary prompt ${scopeWhere(view)}:\n${changedLines(changes)}\n${reach.text} ${RECORDED}`,
        });
      }),
  });

  const extension = yield* defineEffectTool({
    name: "settings_extension_set",
    description: Arr.join(
      [
        `Set one option of one extension: the settings keep each extension's options under its name, and an extension reads the ones it knows. The subagents extension reads ${Arr.join(SUBAGENT_TOOLSET_OPTIONS, ", ")} (lists of tool names or patterns with *: the tools a subagent is granted); an option no extension reads is saved and does nothing. Each option is a setting of its own. A value of null at Global takes the option away, back to the extension's default; at an Environment it removes the option's Override, so the option inherits Global (as settings_reset does).`,
        "The subagent depth (subagents.maxSubagentDepth) and the Subagent Workspace limit (subagents.maxSubagentWorkspaces) are Limits: they are not set here, but with settings_subagent_depth_set and settings_subagent_workspaces_set, which ask the user for their Approval.",
        SCOPE_NOTE,
        CHANGE_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      scope: SettingsScope,
      extension: Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/^[^.]+$/)).annotate({
        description: "The extension's name, without dots, such as subagents",
      }),
      key: Schema.String.check(Schema.isMinLength(1)).annotate({
        description: "The option's name, such as readToolset",
      }),
      value: Schema.Json.annotate({
        description:
          "The option's value (JSON); null takes the option away at Global, or removes its Override at an Environment",
      }),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(ChangeOutput),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ scope, extension, key, value, reason }, api) =>
      Effect.gen(function* () {
        if (extension === "mcp") {
          return yield* SettingsAccessError.make({
            message:
              "mcp is not an extension whose options are set here: MCP servers are kept under their own settings root, extensions.mcp is read by nothing, and the mcp extension is not switched off this way. The settings_mcp tools show and change the MCP servers (settings_mcp_list shows them).",
          });
        }

        if (extension === "subagents" && key === "maxSubagentDepth") {
          return yield* SettingsAccessError.make({
            message:
              "subagents.maxSubagentDepth is a Limit: it is not set with settings_extension_set. Use settings_subagent_depth_set, which asks the user for their Approval.",
          });
        }

        if (extension === "subagents" && key === "maxSubagentWorkspaces") {
          return yield* SettingsAccessError.make({
            message:
              "subagents.maxSubagentWorkspaces is a Limit: it is not set with settings_extension_set. Use settings_subagent_workspaces_set, which asks the user for their Approval.",
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

        const view = yield* access.get(scope);
        const field = extensionField(extension, key);
        const global = isGlobalView(view);

        return yield* apply({
          tool: "settings_extension_set",
          view,
          // At an Environment, null is no Override of nothing: the option's Override is removed.
          fields: [
            resetsOverride(field, value) && !global
              ? { field, value: null, reset: true }
              : { field, value },
          ],
          texts: [jsonText(value)],
          reason,
          conversation: api.conversationId,
          unchanged: global
            ? value === null
              ? `${extension}.${key} is not set at Global: nothing changed, and nothing was recorded.`
              : `${extension}.${key} already has that value at Global: nothing changed, and nothing was recorded.`
            : value === null
              ? `${scopeName(view)} has no Override of ${extension}.${key}: it inherits Global already, so nothing changed, and nothing was recorded.`
              : `${scopeName(view)} overrides ${extension}.${key} with that value already: nothing changed, and nothing was recorded.`,
          changed: ({ changes, reach }) =>
            `Changed ${extension}.${key} ${scopeWhere(view)}:\n${changedLines(changes)}\n${
              extension === "subagents" && Arr.contains(SUBAGENT_TOOLSET_OPTIONS, key)
                ? "It applies to the next subagent started where the change applies."
                : `Only an extension that reads ${extension}.${key} is affected by it.`
            } ${reach.text} ${RECORDED}`,
        });
      }),
  });

  return defineExtension({
    name: extensionName,
    tools: [get, model, role, offer, defer, compaction, branchSummary, extension],
  });
});
