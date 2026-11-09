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
  overrideValue,
  resetsOverride,
  matchesToolPattern,
} from "@cloudpid/config";
import { defineEffectTool } from "@cloudpid/effect-durable";
import type { AgentChange, McpChangeGuard } from "@cloudpid/protocol";
import {
  CHANGE_NOTE,
  GLOBAL_SETTINGS_SCOPE,
  HARNESS_TOOLS,
  OFFER_NOTE,
  OFFER_NOTE_ENDPOINT,
  SCOPE_NOTE,
  type Surface,
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
  type RunChange,
} from "./environment.ts";
import {
  cutNote,
  cutText,
  type HarnessWrite,
  type HarnessWriteAnswer,
  loggedOf,
  toolResult,
} from "./harness.ts";
import { APPROVED, outputSchema } from "./outputs.ts";
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

// What the descriptions of the changing tools say of the `scope` and of the record, from the declarations.
export { CHANGE_NOTE, SCOPE_NOTE };

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

/** The same on the endpoint: no Session's Secrets are held there, and the owner reads the Settings. */
const REFUSED_PLACEHOLDER_ENDPOINT =
  "the reason or a text of the call holds a Secret Reference, which these tools do not resolve, so the Settings would hold the reference's text, not the Secret. Settings are plain and the owner reads them. Say it without the reference.";

const REFUSED_SECRET_ENDPOINT =
  "the text holds a GitHub token or the GitHub App's key. Settings are plain and the owner reads them. Say it without the value.";

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
  /** The calling conversation in a Session; none on the endpoint, whose services know the caller. */
  readonly conversation: number | undefined;
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

/** What the settings tools' engine is built over: the Settings' access, and what only the surface knows. */
export type SettingsChangeServices = {
  /** Where the change is made from: a Session's words say "this Session" and "the user"; the endpoint's neither. */
  readonly surface: Surface;
  readonly access: SettingsAccessService;
  /** Where the Session reads the Settings again after a change; the endpoint has no Session, and reads nothing. */
  readonly reload: Effect.Effect<SettingsApplied>;
  /** Where each change made is told, for the Run's Notification (a Session's) or for the answer's `logged` (the cores'). */
  readonly log: { readonly record: (change: RunChange) => Effect.Effect<void> };
  /** Whether `value` holds a Secret's value or a credential: the Session's Secrets are fresh; the endpoint has none of its own. */
  readonly holdsSecret: (value: string) => Effect.Effect<boolean>;
};

/** What a Session says of itself when nothing reads it again: it picked nothing, so no change is kept from it. */
export const NOT_PICKED: SettingsApplied = { picked: { model: false, thinkingLevel: false } };

/** The Settings' recorded-change sentence, as `who` reads it. */
export const recordedFor = (surface: Surface): string =>
  surface === "session"
    ? RECORDED
    : "The change is recorded with your reason; the owner can see and revert it on the Settings page.";

/**
 * How the settings tools change the Settings, over `services`: refusing text that holds a Secret or a deploy-time credential,
 * reading the Settings again after each change, telling of each change made, and saying whether a change reaches this
 * Session. A Session's are the `SettingsChanges` below; the endpoint's cores build them with its own services.
 */
export const settingsChanges = ({
  surface,
  access,
  reload,
  log,
  holdsSecret,
}: SettingsChangeServices) => {
  /** What a change at `view`'s Scope reaches on the endpoint: no Session is its own, and each takes it when it next admits input. */
  const endpointReach = (view: SettingsView): SettingsReach => ({
    reaches: () => true,
    text: isGlobalView(view)
      ? `Sessions whose Environment does not override the field get it when they next admit input (settings_get with scope "${GLOBAL_SETTINGS_SCOPE}" names those Environments).`
      : `${scopeName(view)}'s Sessions get it when they next admit input.`,
  });

  /**
   * Whether a change of `fields` at `view`'s Scope reaches this Session, which runs with its own Environment's
   * Settings: a change at another Environment does not, nor one at Global of a field its Environment overrides.
   */
  const reach = (view: SettingsView, fields: ReadonlyArray<string>) =>
    surface === "endpoint" ? Effect.succeed(endpointReach(view)) : sessionReach(view, fields);

  const sessionReach = (view: SettingsView, fields: ReadonlyArray<string>) =>
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
        return yield* SettingsAccessError.make({
          message: `${outcome}: ${surface === "session" ? REFUSED_PLACEHOLDER : REFUSED_PLACEHOLDER_ENDPOINT}`,
          code: "invalid_argument",
        });
      }

      if (yield* holdsSecret(kept)) {
        return yield* SettingsAccessError.make({
          message: `${outcome}: ${surface === "session" ? REFUSED_SECRET : REFUSED_SECRET_ENDPOINT}`,
          code: "invalid_argument",
        });
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
            code: "invalid_argument",
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
              surface,
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

          const applied = yield* reload;

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
              surface,
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
};

/**
 * The settings tools' engine in a Session: over the Session's `SettingsAccess`, refusing text that holds a Secret
 * (`Secrets`) or a deploy-time credential (`DeployCredentials`), reading the Settings again after each change
 * (`SettingsReload`), and telling the Run's Notification of each change (`AgentChangeLog`).
 */
export const SettingsChanges = Effect.gen(function* () {
  const access = yield* SettingsAccess;
  const reload = yield* SettingsReload;
  const log = yield* AgentChangeLog;
  const secrets = yield* Secrets;

  const holdsCredential = yield* credentialCheck;

  return settingsChanges({
    surface: "session",
    access,
    reload: reload.apply,
    log,
    // Whether `value` holds a Secret's value or a credential, once the Session's Secrets are fresh.
    holdsSecret: (value) =>
      Effect.map(secrets.refresh, () => secrets.redact(value) !== value || holdsCredential(value)),
  });
});

export const RECORDED =
  "The change is recorded with your reason; the user can see and revert it on the Settings page.";

/** What an engine's `apply` answers: the text, the value for programs and the details of the card. */
type SettingsToolResult = Effect.Success<ReturnType<ReturnType<typeof settingsChanges>["apply"]>>;

/** What the endpoint's text of a settings change is cut to: it is read whole by `settings_get`. */
const endpointText = (text: string): string =>
  cutText(text, cutNote("settings_get shows the settings as they are now"));

/** The arguments of tool `Name`, as a Session's call decodes them (the endpoint's add only `request_id`). */
type ArgsOf<Name extends keyof typeof HARNESS_TOOLS> =
  (typeof HARNESS_TOOLS)[Name]["session"]["input"]["Type"];

/** What the cores run over: the Settings' access, what the Session reads again, and the check of a text. */
export type SettingsChangeCoreServices = Omit<SettingsChangeServices, "surface" | "log">;

/** The result of a call that found a field as it was asked to be: nothing is saved, recorded or pushed. */
export const nothingChanged = (
  surface: Surface,
  view: SettingsView,
  field: string,
  text: string,
) => ({
  output: [{ type: "text" as const, text }],
  structuredOutput: settingsChangeOutput({
    view,
    changes: [],
    unchanged: [field],
    approval: null,
    surface,
  }),
  details: { scope: view.scope, unchanged: [field], agentChanges: [] },
});

/**
 * An engine's result as a core answers it on `surface`: a Session's as it is, the endpoint's text cut; with the Agent changes
 * made (`logged`), which the Session's wrapper tells the Run's Notification of.
 */
export const settingsAnswer = (
  surface: Surface,
  {
    output,
    structuredOutput,
    details,
  }: {
    readonly output: ReadonlyArray<{ readonly text: string }>;
    readonly structuredOutput: JsonValue;
    readonly details: JsonValue;
  },
  logged: ReadonlyArray<RunChange>,
): HarnessWriteAnswer => {
  const [first] = output;
  const text = first === undefined ? "" : first.text;

  return {
    text: surface === "session" ? text : endpointText(text),
    structured: structuredOutput,
    details,
    logged: logged.length === 0 ? undefined : logged,
  };
};

/**
 * Run `make` over the Settings' engine of `surface` built over `services`, collecting the changes it records, and answer as
 * a core does.
 */
export const settingsWritten =
  (services: SettingsChangeCoreServices) =>
  (
    surface: Surface,
    make: (
      engine: ReturnType<typeof settingsChanges>,
    ) => Effect.Effect<SettingsToolResult, SettingsAccessError>,
  ): Effect.Effect<HarnessWriteAnswer, SettingsAccessError> =>
    Effect.suspend(() => {
      const logged: Array<RunChange> = [];

      const engine = settingsChanges({
        ...services,
        surface,
        log: { record: (change) => Effect.sync(() => void logged.push(change)) },
      });

      return Effect.map(make(engine), (result) => settingsAnswer(surface, result, logged));
    });

/**
 * The cores of the Settings' changing tools, by name (`docs/architecture/mcp-endpoint.md` → Shared definitions and the
 * core/wrapper split): each makes its tool's checks and one `SettingsAccess` call, and answers the text, the value for
 * programs and the card's `details` of its surface, with the Agent changes made. The Session's wrappers call them with the
 * session surface, whose words and values are byte-identical to the tools' before the split; the endpoint's dispatcher
 * calls them with `surface: "endpoint"`, whose words name no Session and no tool the endpoint does not serve, and say the
 * owner where a Session's say the user. A Limit's option is refused there as `unsupported`.
 */
export const settingsChangeCores = (services: SettingsChangeCoreServices) => {
  const { access } = services;
  const written = settingsWritten(services);

  const modelSet: HarnessWrite<ArgsOf<"settings_model_set">, SettingsAccessError> = (
    { scope, model, thinking_level, reason },
    surface,
    conversation,
  ) =>
    written(surface, ({ apply }) =>
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
            code: "invalid_argument",
          });
        }

        const view = yield* access.get(scope);

        return yield* apply({
          tool: "settings_model_set",
          view,
          fields,
          reason,
          conversation,
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
                // Only a Session knows what it picked.
                ...(reaching.length === 0 || surface === "endpoint"
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
                recordedFor(surface),
              ],
              " ",
            );
          },
        });
      }),
    );

  const roleSet: HarnessWrite<ArgsOf<"settings_role_set">, SettingsAccessError> = (
    { scope, role, model, hint, reason },
    surface,
    conversation,
  ) =>
    written(surface, ({ apply }) =>
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
          conversation,
          unchanged: isGlobalView(view)
            ? `The ${role} role already has ${hint === undefined ? "that model" : "that model and hint"} at Global: nothing changed, and nothing was recorded.`
            : `${scopeName(view)} overrides the ${role} role with ${hint === undefined ? "that model" : "that model and hint"} already: nothing changed, and nothing was recorded.`,
          changed: ({ changes, reach }) =>
            `Changed the ${role} role ${scopeWhere(view)}:\n${changedLines(changes)}\nThe next subagent started with the role ${role} where the change applies uses it. ${reach.text} ${recordedFor(surface)}`,
        });
      }),
    );

  const offered = (current: ReadonlyArray<string>, pattern: string) =>
    Arr.filter(current, (entry) => matchesToolPattern(entry, pattern));

  const offerSet: HarnessWrite<ArgsOf<"settings_tool_offer">, SettingsAccessError> = (
    { scope, pattern, reason },
    surface,
    conversation,
  ) =>
    written(surface, ({ apply }) =>
      Effect.gen(function* () {
        const view = yield* access.get(scope);
        const current = view.settings.tools.offered;
        const already = `${pattern} is among the offered tools ${scopeWhere(view)} already: nothing changed, and nothing was recorded.`;

        if (Arr.contains(current, pattern)) {
          return nothingChanged(surface, view, "tools.offered", already);
        }

        return yield* apply({
          tool: "settings_tool_offer",
          view,
          fields: [{ field: "tools.offered", value: [...current, pattern] }],
          texts: [pattern],
          reason,
          conversation,
          unchanged: already,
          changed: ({ reach }) =>
            `Offered ${pattern} ${scopeWhere(view)}: it is added to the offered tools, so the model of each conversation the change reaches is shown the tools it names from its next request. ${reach.text} ${surface === "session" ? OFFER_NOTE : OFFER_NOTE_ENDPOINT} ${recordedFor(surface)}`,
        });
      }),
    );

  const deferSet: HarnessWrite<ArgsOf<"settings_tool_defer">, SettingsAccessError> = (
    { scope, pattern, reason },
    surface,
    conversation,
  ) =>
    written(surface, ({ apply }) =>
      Effect.gen(function* () {
        const view = yield* access.get(scope);
        const current = view.settings.tools.offered;

        if (!Arr.contains(current, pattern)) {
          const covering = offered(current, pattern);

          return nothingChanged(
            surface,
            view,
            "tools.offered",
            `The offered tools ${scopeWhere(view)} have no entry "${pattern}": nothing changed, and nothing was recorded.${
              covering.length === 0
                ? ""
                : ` ${pattern} is offered by ${Arr.join(covering, ", ")}: defer that entry to defer it.`
            }`,
          );
        }

        return yield* apply({
          tool: "settings_tool_defer",
          view,
          fields: [
            { field: "tools.offered", value: Arr.filter(current, (entry) => entry !== pattern) },
          ],
          reason,
          conversation,
          unchanged: `${pattern} is not among the offered tools ${scopeWhere(view)}: nothing changed, and nothing was recorded.`,
          changed: ({ reach }) =>
            `Deferred ${pattern} ${scopeWhere(view)}: it is removed from the offered tools, so ${
              surface === "session"
                ? "the tools it names are loaded with tool_search from the next request of each conversation the change reaches"
                : "the model of each conversation the change reaches loads the tools it names when it needs them"
            }${
              Arr.contains(ALWAYS_OFFERED, pattern)
                ? `. ${pattern} stays offered whatever the list says`
                : ""
            }. A tool a conversation has loaded stays offered to it. ${reach.text} ${recordedFor(surface)}`,
        });
      }),
    );

  const compactionSet: HarnessWrite<ArgsOf<"settings_compaction_set">, SettingsAccessError> = (
    args,
    surface,
    conversation,
  ) =>
    written(surface, ({ apply }) =>
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
            code: "invalid_argument",
          });
        }

        const view = yield* access.get(args.scope);

        return yield* apply({
          tool: "settings_compaction_set",
          view,
          fields,
          reason: args.reason,
          conversation,
          unchanged: isGlobalView(view)
            ? "Compaction already has these values at Global: nothing changed, and nothing was recorded."
            : `${scopeName(view)} overrides compaction with these values already: nothing changed, and nothing was recorded.`,
          changed: ({ changes, reach }) =>
            `Changed compaction ${scopeWhere(view)}:\n${changedLines(changes)}\nIt applies from the next request of each conversation the change reaches. ${reach.text} ${recordedFor(surface)}`,
        });
      }),
    );

  const branchSummarySet: HarnessWrite<
    ArgsOf<"settings_branch_summary_set">,
    SettingsAccessError
  > = ({ scope, skip_prompt, reason }, surface, conversation) =>
    written(surface, ({ apply }) =>
      Effect.gen(function* () {
        const view = yield* access.get(scope);

        return yield* apply({
          tool: "settings_branch_summary_set",
          view,
          fields: [{ field: "branchSummary.skipPrompt", value: skip_prompt }],
          reason,
          conversation,
          unchanged: isGlobalView(view)
            ? `The branch summary prompt is ${skip_prompt ? "skipped" : "asked"} at Global already: nothing changed, and nothing was recorded.`
            : `${scopeName(view)} overrides the branch summary prompt to be ${skip_prompt ? "skipped" : "asked"} already: nothing changed, and nothing was recorded.`,
          changed: ({ changes, reach }) =>
            `Changed the branch summary prompt ${scopeWhere(view)}:\n${changedLines(changes)}\n${reach.text} ${recordedFor(surface)}`,
        });
      }),
    );

  const extensionSet: HarnessWrite<ArgsOf<"settings_extension_set">, SettingsAccessError> = (
    { scope, extension, key, value, reason },
    surface,
    conversation,
  ) =>
    written(surface, ({ apply }) =>
      Effect.gen(function* () {
        if (extension === "mcp") {
          return yield* SettingsAccessError.make({
            message:
              "mcp is not an extension whose options are set here: MCP servers are kept under their own settings root, extensions.mcp is read by nothing, and the mcp extension is not switched off this way. The settings_mcp tools show and change the MCP servers (settings_mcp_list shows them).",
            code: "invalid_argument",
          });
        }

        if (extension === "subagents" && key === "maxSubagentDepth") {
          return yield* SettingsAccessError.make(
            surface === "session"
              ? {
                  message:
                    "subagents.maxSubagentDepth is a Limit: it is not set with settings_extension_set. Use settings_subagent_depth_set, which asks the user for their Approval.",
                  code: "invalid_argument",
                }
              : {
                  message:
                    "Nothing was saved: subagents.maxSubagentDepth is a Limit, which these tools do not change. The owner changes it on the Settings page.",
                  code: "unsupported",
                },
          );
        }

        if (extension === "subagents" && key === "maxSubagentWorkspaces") {
          return yield* SettingsAccessError.make(
            surface === "session"
              ? {
                  message:
                    "subagents.maxSubagentWorkspaces is a Limit: it is not set with settings_extension_set. Use settings_subagent_workspaces_set, which asks the user for their Approval.",
                  code: "invalid_argument",
                }
              : {
                  message:
                    "Nothing was saved: subagents.maxSubagentWorkspaces is a Limit, which these tools do not change. The owner changes it on the Settings page.",
                  code: "unsupported",
                },
          );
        }

        if (
          extension === "subagents" &&
          Arr.contains(SUBAGENT_TOOLSET_OPTIONS, key) &&
          value !== null &&
          !Schema.is(Schema.Array(Schema.String))(value)
        ) {
          return yield* SettingsAccessError.make({
            message: `Nothing was saved: ${extension}.${key} is a list of tool names or patterns, and the subagents extension ignores every option of its own when one is not.`,
            code: "invalid_argument",
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
          conversation,
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
            } ${reach.text} ${recordedFor(surface)}`,
        });
      }),
    );

  return {
    settings_model_set: modelSet,
    settings_role_set: roleSet,
    settings_tool_offer: offerSet,
    settings_tool_defer: deferSet,
    settings_compaction_set: compactionSet,
    settings_branch_summary_set: branchSummarySet,
    settings_extension_set: extensionSet,
  };
};

export type SettingsChangeCores = ReturnType<typeof settingsChangeCores>;

/** The tools these cores serve, by name. */
export type SettingsChangeToolName = keyof SettingsChangeCores;

/** The Session's check of a text: its Secrets are fresh, and it holds no deploy-time credential. */
const sessionHoldsSecret = Effect.gen(function* () {
  const secrets = yield* Secrets;
  const holdsCredential = yield* credentialCheck;

  return (value: string) =>
    Effect.map(secrets.refresh, () => secrets.redact(value) !== value || holdsCredential(value));
});

/**
 * The `settings` extension: its tools over the Session's `SettingsAccess`, refusing text that holds a Secret
 * (`Secrets`) or a deploy-time credential (`DeployCredentials`), reading the Settings again after each change
 * (`SettingsReload`), and telling the Session of each change for the Run's Notification (`AgentChangeLog`). Each changing
 * tool is a wrapper over its core (`settingsChangeCores`).
 */
export const SettingsTools: Effect.Effect<
  Extension,
  never,
  SettingsAccess | SettingsReload | AgentChangeLog | DeployCredentials | Secrets
> = Effect.gen(function* () {
  const access = yield* SettingsAccess;
  const reload = yield* SettingsReload;
  const log = yield* AgentChangeLog;
  const holdsSecret = yield* sessionHoldsSecret;

  const cores = settingsChangeCores({ access, reload: reload.apply, holdsSecret });

  /** A core's answer as the Session's tool returns it, once the Run's Notification is told of the changes it made. */
  const inSession = (answer: Effect.Effect<HarnessWriteAnswer, SettingsAccessError>) =>
    answer.pipe(
      Effect.tap(({ logged }) => Effect.forEach(loggedOf(logged), log.record, { discard: true })),
      Effect.map(toolResult),
    );

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
    name: HARNESS_TOOLS.settings_model_set.name,
    description: HARNESS_TOOLS.settings_model_set.session.description,
    parameters: HARNESS_TOOLS.settings_model_set.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.settings_model_set.session.output),
    executionMode: "sequential",
    // A rerun after an eviction would record the change again, against the value it set.
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.settings_model_set(args, "session", api.conversationId)),
  });

  const role = yield* defineEffectTool({
    name: HARNESS_TOOLS.settings_role_set.name,
    description: HARNESS_TOOLS.settings_role_set.session.description,
    parameters: HARNESS_TOOLS.settings_role_set.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.settings_role_set.session.output),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) => inSession(cores.settings_role_set(args, "session", api.conversationId)),
  });

  const offer = yield* defineEffectTool({
    name: HARNESS_TOOLS.settings_tool_offer.name,
    description: HARNESS_TOOLS.settings_tool_offer.session.description,
    parameters: HARNESS_TOOLS.settings_tool_offer.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.settings_tool_offer.session.output),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.settings_tool_offer(args, "session", api.conversationId)),
  });

  const defer = yield* defineEffectTool({
    name: HARNESS_TOOLS.settings_tool_defer.name,
    description: HARNESS_TOOLS.settings_tool_defer.session.description,
    parameters: HARNESS_TOOLS.settings_tool_defer.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.settings_tool_defer.session.output),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.settings_tool_defer(args, "session", api.conversationId)),
  });

  const compaction = yield* defineEffectTool({
    name: HARNESS_TOOLS.settings_compaction_set.name,
    description: HARNESS_TOOLS.settings_compaction_set.session.description,
    parameters: HARNESS_TOOLS.settings_compaction_set.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.settings_compaction_set.session.output),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.settings_compaction_set(args, "session", api.conversationId)),
  });

  const branchSummary = yield* defineEffectTool({
    name: HARNESS_TOOLS.settings_branch_summary_set.name,
    description: HARNESS_TOOLS.settings_branch_summary_set.session.description,
    parameters: HARNESS_TOOLS.settings_branch_summary_set.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.settings_branch_summary_set.session.output),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.settings_branch_summary_set(args, "session", api.conversationId)),
  });

  const extension = yield* defineEffectTool({
    name: HARNESS_TOOLS.settings_extension_set.name,
    description: HARNESS_TOOLS.settings_extension_set.session.description,
    parameters: HARNESS_TOOLS.settings_extension_set.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.settings_extension_set.session.output),
    executionMode: "sequential",
    replay: "unsafe",
    execute: (args, api) =>
      inSession(cores.settings_extension_set(args, "session", api.conversationId)),
  });

  return defineExtension({
    name: extensionName,
    tools: [get, model, role, offer, defer, compaction, branchSummary, extension],
  });
});
