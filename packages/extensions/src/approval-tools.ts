// @effect-diagnostics missingPipeableSignature:off preferSchemaOverJson:off
// The tools whose Agent changes wait for the owner's Approval (`docs/architecture/agent-changes.md` → Approval,
// ADR-0019): those that change a Limit (`settings_spend_limit_set`, `settings_subagent_depth_set`,
// `settings_subagent_workspaces_set`, `environment_container_size_limit_set`, and `settings_reset` of a Limit) and
// those no revert can undo (`environment_delete`, `environment_secret_delete`). The Settings' Limits are kept at both Scopes (ADR-0027): their tools and `settings_reset` take a required `scope`, `*` for
// Global or an Environment's id, and ask at either. `settings_reset` lives here for its Limits, but a reset of any other
// field is made at once, without asking, as the `settings` tools make a change. Each checks what it can first and
// refuses without asking what it would refuse anyway; then it asks the owner (`withApproval`), and on Approve makes
// the change as the other tools do (applied, recorded with an approved mark, in the Run's Notification), provided the target still has the value the owner saw. A Decline
// changes nothing, and the result carries the owner's reason. The tools are the root conversation's only
// (`PARENT_ONLY_TOOL_PREFIXES` has `environment_` and `settings_`), run alone, and are replayed after an eviction: the
// rerun waits for the same request, or takes the answer given meanwhile.
import {
  compareInstances,
  DEFAULT_SETTINGS,
  extensionField,
  InstanceType,
  OVERRIDE_FIELD_NAMES,
  overrideFieldPath,
  overrideValue,
  settingsFieldValue,
} from "@cloudpid/config";
import { defineEffectTool } from "@cloudpid/effect-durable";
import {
  type AgentChange,
  DEFAULT_ENVIRONMENT,
  DELETED_FIELD,
  keptSecretField,
  SecretName,
} from "@cloudpid/protocol";
import type { JsonValue } from "@earendil-works/chord";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  type ApprovalCall,
  Approvals,
  approvedAlready,
  askedBefore,
  declined,
  withApproval,
} from "./approvals.ts";
import {
  AgentChangeLog,
  type ChangeAuthor,
  type ChangedEnvironment,
  credentialCheck,
  type DeployCredentials,
  describeApplied,
  describeAppliedGlobal,
  Environments,
  EnvironmentsError,
  environmentTarget,
  Id,
  idOrGlobal,
  MAX_CHANGE_REASON,
  notFound,
  sizeWords,
} from "./environment.ts";
import { GLOBAL_ID, GLOBAL_NAME } from "./environment-secret-marks.ts";
import { holdsPlaceholder } from "./secrets/references.ts";
import { Secrets } from "./secrets/store.ts";
import {
  agentChangeDetails,
  CHANGE_NOTE,
  changedLines,
  fieldLabel,
  GLOBAL_SETTINGS_SCOPE,
  inheritedWords,
  isGlobalView,
  loggedChange,
  RECORDED,
  SCOPE_NOTE,
  scopeName,
  scopeWhere,
  SettingsAccess,
  SettingsAccessError,
  SettingsChanges,
  type SettingsFieldChange,
  SettingsReload,
  SettingsScope,
  type SettingsView,
} from "./settings.ts";
import { DEFAULT_MAX_SUBAGENT_DEPTH } from "./subagents/options.ts";
import { DEFAULT_MAX_SUBAGENT_WORKSPACES } from "./subagents/workspaces.ts";

export const extensionName = "approval-tools";

/** What deleting an Environment takes with it, as the owner is asked about it. */
export const EnvironmentFootprint = Schema.Struct({
  /** Its Workspaces, but its spare. */
  workspaces: Schema.Int,
  /** The Sessions in them, archived ones too. */
  sessions: Schema.Int,
  /** The Secrets kept for it alone. */
  secrets: Schema.Int,
});

export type EnvironmentFootprint = typeof EnvironmentFootprint.Type;

/** A Secret kept in a scope, by name: whether it reaches the Build, and when its value or mark last changed. */
export type KeptSecretMark = {
  readonly name: string;
  readonly build: boolean;
  readonly updatedAt: number;
};

/** What a kept Secret was when the owner was asked to delete it: when its value or Build mark last changed. */
const SecretAsked = Schema.Struct({ updatedAt: Schema.Finite });

/** How the delete of a kept Secret went. */
export type SecretDeleted =
  | {
      readonly status: "deleted";
      /** The Environment, or Global (`GLOBAL_ID`), whose history records it. */
      readonly environment: ChangedEnvironment;
      readonly change: AgentChange;
    }
  /** No Secret of the name is kept there (any more): nothing was deleted. */
  | { readonly status: "absent"; readonly environment: ChangedEnvironment }
  /** Its value or Build mark changed since the owner was asked: nothing was deleted. */
  | { readonly status: "changed-since"; readonly environment: ChangedEnvironment }
  | { readonly status: "missing" };

/**
 * What the Session does for the deletes that need the owner's Approval, over the Registry and the objects: it deletes an
 * Environment as the owner's delete does, and a kept Secret as the owner's delete does, recorded.
 */
export type EnvironmentRemovalService = {
  /** What deleting `environment` takes with it; null when it is not registered. */
  readonly footprint: (
    environment: string,
  ) => Effect.Effect<EnvironmentFootprint | null, EnvironmentsError>;
  /**
   * Delete `environment` as the owner's delete does: its Workspaces with their Sessions, its spare Workspace, its Build
   * object, then its record, its kept Secrets and its Agent changes. Fails saying what is left when it cannot finish.
   */
  readonly deleteEnvironment: (environment: string) => Effect.Effect<void, EnvironmentsError>;
  /** The Secrets kept in `scope` (an Environment's id, or `GLOBAL_ID`); null for an unknown Environment. */
  readonly keptSecrets: (
    scope: string,
  ) => Effect.Effect<ReadonlyArray<KeptSecretMark> | null, EnvironmentsError>;
  /**
   * Delete the Secret `name` kept in `environment`'s scope and record it, then run the Builds' upkeep it touches; with
   * `expected`, only while it was last changed then.
   */
  readonly deleteSecret: (input: {
    readonly environment: string;
    readonly name: string;
    readonly expected?: { readonly updatedAt: number } | undefined;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<SecretDeleted, EnvironmentsError>;
};

export class EnvironmentRemoval extends Context.Service<
  EnvironmentRemoval,
  EnvironmentRemovalService
>()("@cloudpid/extensions/approval-tools/EnvironmentRemoval") {}

/** A Schema `Json` value as the details' `JsonValue`, which differs only in that its arrays are mutable. */
// SAFETY: the two types describe the same values; the details are never mutated.
const asJsonValue = (value: Schema.Json | null): JsonValue | null => value as JsonValue | null;

/** US dollars as the owner reads them. */
const dollars = (amount: number): string =>
  `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;

/** A spend limit as the owner reads it. */
const spendWords = (limit: Schema.Json | null): string =>
  Predicate.isNumber(limit) ? `${dollars(limit)} per Session` : "no limit";

/** A subagent depth as the owner reads it. */
const depthWords = (depth: number): string =>
  `${depth} level${depth === 1 ? "" : "s"} of subagents below the root`;

/** The subagent depth a stored value gives: the default where it is unset or not a depth. */
const depthOf = (stored: Schema.Json | null): number =>
  Predicate.isNumber(stored) && Number.isInteger(stored) && stored > 0
    ? stored
    : DEFAULT_MAX_SUBAGENT_DEPTH;

/** A stored subagent depth as the owner reads it. */
const storedDepthWords = (stored: Schema.Json | null): string =>
  `${depthWords(depthOf(stored))}${stored === null ? " (the default)" : ""}`;

/** A Subagent Workspace limit as the owner reads it. */
const workspacesWords = (limit: number): string =>
  `${limit} Subagent Workspace${limit === 1 ? "" : "s"} per Session`;

/** The Subagent Workspace limit a stored value gives: the default where it is unset or not a limit. */
const workspacesOf = (stored: Schema.Json | null): number =>
  Predicate.isNumber(stored) && Number.isInteger(stored) && stored >= 0
    ? stored
    : DEFAULT_MAX_SUBAGENT_WORKSPACES;

/** A stored Subagent Workspace limit as the owner reads it. */
const storedWorkspacesWords = (stored: Schema.Json | null): string =>
  `${workspacesWords(workspacesOf(stored))}${stored === null ? " (the default)" : ""}`;

/** A Limit of the Settings: its field, what the card calls it, and how the owner reads a value of it. */
type SettingsLimit = {
  readonly field: string;
  /** The Limit as a card names it. */
  readonly change: string;
  /** The Limit as a sentence names it. */
  readonly name: string;
  /** A stored value as the owner reads it (null: not set, the default). */
  readonly words: (stored: Schema.Json | null) => string;
  /** Its default as the owner reads it. */
  readonly byDefault: string;
};

const SPEND_LIMIT: SettingsLimit = {
  field: "spendLimit.perSession",
  change: "Spend limit",
  name: "the spend limit",
  words: spendWords,
  byDefault: "no limit (the default)",
};

const DEPTH_LIMIT: SettingsLimit = {
  field: extensionField("subagents", "maxSubagentDepth"),
  change: "Subagent depth",
  name: "the subagent depth",
  words: storedDepthWords,
  byDefault: storedDepthWords(null),
};

const WORKSPACES_LIMIT: SettingsLimit = {
  field: extensionField("subagents", "maxSubagentWorkspaces"),
  change: "Subagent Workspace limit",
  name: "the Subagent Workspace limit",
  words: storedWorkspacesWords,
  byDefault: storedWorkspacesWords(null),
};

const SETTINGS_LIMITS: ReadonlyArray<SettingsLimit> = [SPEND_LIMIT, DEPTH_LIMIT, WORKSPACES_LIMIT];

/** The Settings a card names as the target: Global's, or an Environment's by name. */
const settingsTarget = (view: SettingsView): string =>
  isGlobalView(view)
    ? "the Global Settings"
    : `Environment ${JSON.stringify(view.name)}'s Settings`;

/** What a Limit at an Environment was when the owner was asked: its value in force, and whether it was inherited. */
const LimitAtEnvironment = Schema.Struct({
  value: Schema.NullOr(Schema.Json),
  inherited: Schema.Boolean,
});

const sameJson = Schema.toEquivalence(Schema.NullOr(Schema.Json));

/** The fields `settings_reset` takes, as its description and its refusal list them. */
const RESET_FIELDS = Arr.join(OVERRIDE_FIELD_NAMES, ", ");

const isInstanceType = Schema.is(InstanceType);

/** A stored size limit as the owner reads it. */
const storedSizeWords = (stored: Schema.Json | null): string =>
  isInstanceType(stored) ? sizeWords(stored) : JSON.stringify(stored);

/** An Environment as a result and a card name it. */
const named = ({ id, name }: ChangedEnvironment): string =>
  id === GLOBAL_ID ? GLOBAL_NAME : `Environment ${JSON.stringify(name)} (${id})`;

/** "kept Global", or "kept for" the Environment, as a message says it. */
const keptIn = (environment: ChangedEnvironment): string =>
  environment.id === GLOBAL_ID ? "kept Global" : `kept for ${named(environment)}`;

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** Whether `now` takes no more of anything than `approved`, what the owner was shown. */
const within = (now: EnvironmentFootprint, approved: EnvironmentFootprint): boolean =>
  now.workspaces <= approved.workspaces &&
  now.sessions <= approved.sessions &&
  now.secrets <= approved.secrets;

/** What deleting an Environment takes with it, as the card says it: what the owner approves. */
const footprintWords = (footprint: EnvironmentFootprint): string =>
  `${count(footprint.workspaces, "Workspace")} with ${count(footprint.sessions, "Session")} (archived ones too), its spare Workspace and Build, ${count(footprint.secrets, "kept Secret")} and its Agent changes`;

/** What a change the owner approved says when the target changed between the request and the answer. */
const changedSince = (what: string, now: string) =>
  `The user approved, but ${what} changed since they were asked: it is ${now} now, so the change they saw was not made and nothing was saved. Ask again with the value as it is now if the change is still needed.`;

const Reason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CHANGE_REASON),
).annotate({
  description:
    "Why you make the change, shown to the user on the Approval card and kept with the change, such as 'the test suite needs 12 GiB of memory'",
});

const APPROVAL =
  "The user is asked for their Approval on a card in the Session (and a notification): the call waits for the answer, with no deadline. On Approve the change is made and recorded as approved; on Decline nothing changes, and the result carries their reason. If the user changes the same setting meanwhile, the approval does not apply and you are told to ask again.";

/**
 * The tools that wait for the owner's Approval: over the Session's `Environments`, `EnvironmentRemoval` and
 * `SettingsAccess`, asking through its `Approvals`, refusing a reason that holds a Secret (`Secrets`) or a deploy-time
 * credential (`DeployCredentials`), and telling the Session of each change for the Run's Notification (`AgentChangeLog`).
 */
export const ApprovalTools: Effect.Effect<
  Extension,
  never,
  | Approvals
  | Environments
  | EnvironmentRemoval
  | SettingsAccess
  | SettingsReload
  | AgentChangeLog
  | DeployCredentials
  | Secrets
> = Effect.gen(function* () {
  const approvals = yield* Approvals;
  const environments = yield* Environments;
  const removal = yield* EnvironmentRemoval;
  const access = yield* SettingsAccess;
  const reload = yield* SettingsReload;
  const log = yield* AgentChangeLog;
  const secrets = yield* Secrets;

  const holdsCredential = yield* credentialCheck;
  const { apply: applySettings, reach } = yield* SettingsChanges;

  /**
   * Fails, asking nothing, when the reason holds a Secret the Session holds, a deploy-time credential, or a Secret
   * Reference's placeholder, which these tools do not resolve (the card and the history would show the reference's
   * text).
   */
  const plainReason = (reason: string) =>
    holdsPlaceholder(reason)
      ? Effect.fail(
          EnvironmentsError.make({
            message:
              "Nothing was asked or saved: the reason holds a Secret Reference, which these tools do not resolve, so it would hold the reference's text, not the Secret. Say why without it.",
          }),
        )
      : Effect.flatMap(secrets.refresh, () =>
          secrets.redact(reason) === reason && !holdsCredential(reason)
            ? Effect.void
            : EnvironmentsError.make({
                message:
                  "Nothing was asked or saved: the reason holds the value of a Secret this Session holds, or a GitHub token or the GitHub App's key. Say why without it.",
              }),
        );

  const target = environmentTarget(environments);

  /** A Limit's value in force at `view`'s Scope, and at an Environment whether it is inherited (it has no Override). */
  const limitNow = (view: SettingsView, limit: SettingsLimit) => ({
    stored: settingsFieldValue(view.settings, limit.field),
    inherited: isGlobalView(view)
      ? undefined
      : Option.isNone(overrideValue(view.overrides, limit.field)),
  });

  /**
   * Make `fieldChange` to `limit` at `view`'s Scope as `tool`, with the owner's Approval: the card shows the Limit as it
   * is now and `after`, and the change is made only while the Limit is still as the owner saw it (at an Environment,
   * inherited or not as it was).
   */
  const changeLimit = ({
    tool,
    view,
    limit,
    fieldChange,
    change,
    after,
    reason,
    api,
  }: {
    readonly tool: string;
    readonly view: SettingsView;
    readonly limit: SettingsLimit;
    readonly fieldChange: SettingsFieldChange;
    /** The change as the card names it. */
    readonly change: string;
    /** The value the Limit has after the change, as the owner reads it. */
    readonly after: string;
    readonly reason: string;
    readonly api: ApprovalCall;
  }) => {
    const { stored, inherited } = limitNow(view, limit);
    const before = `${limit.words(stored)}${inheritedWords(inherited)}`;
    const where = scopeWhere(view);

    return withApproval(
      approvals,
      api,
      {
        tool,
        target: settingsTarget(view),
        change,
        before,
        after,
        reason,
        expected: inherited === undefined ? stored : { value: stored, inherited },
      },
      (answer) =>
        Effect.gen(function* () {
          if (!answer.approved) {
            return declined(answer, `${change} ${where}, from ${before} to ${after}`);
          }

          // What the owner saw: at Global the value, at an Environment the value and whether it was inherited.
          const expected = isGlobalView(view)
            ? { value: answer.expected }
            : Option.getOrElse(
                Schema.decodeUnknownOption(LimitAtEnvironment)(answer.expected),
                () => ({ value: answer.expected }),
              );

          const applied = yield* access.change({
            scope: view.scope,
            changes: [{ ...fieldChange, expected }],
            author: { conversation: api.conversationId, tool, reason, approved: true },
          });

          switch (applied.status) {
            case "rejected":
              return yield* SettingsAccessError.make({
                message: `The user approved, but nothing was saved: ${applied.message}`,
              });
            case "changed-since":
              return yield* SettingsAccessError.make({
                message: changedSince(
                  `${limit.name} ${where}`,
                  `${limit.words(applied.current)}${inheritedWords(applied.inherited)}`,
                ),
              });
            case "unchanged":
              return {
                output: [
                  {
                    type: "text" as const,
                    text: approvedAlready(`${limit.name} ${where} is ${after}`),
                  },
                ],
                details: { scope: view.scope, approval: { approved: true }, agentChanges: [] },
              };
            case "changed": {
              for (const made of applied.changes) {
                yield* log.record(loggedChange(view, tool, made.field));
              }

              yield* reload.apply;

              const reached = yield* reach(view, [limit.field]);

              return {
                output: [
                  {
                    type: "text" as const,
                    text: `The user approved: ${limit.name} ${where} was ${before}, and is ${after} now. ${reached.text} The change is recorded as approved, with your reason; the user can revert it on the Settings page.`,
                  },
                ],
                details: {
                  scope: view.scope,
                  approval: { approved: true },
                  agentChanges: agentChangeDetails(view, applied.changes),
                },
              };
            }
          }
        }),
    );
  };

  /**
   * Set `limit` to `value` at `view`'s Scope as `tool`, with the owner's Approval, unless it has the value already (`same`
   * of the value in force; at an Environment only as its Override, since an inherited value is not pinned): then nothing
   * is asked, but by a rerun that asked already.
   */
  const setLimit = ({
    tool,
    view,
    limit,
    value,
    same,
    after,
    reason,
    api,
  }: {
    readonly tool: string;
    readonly view: SettingsView;
    readonly limit: SettingsLimit;
    readonly value: Schema.Json | null;
    readonly same: (stored: Schema.Json | null) => boolean;
    readonly after: string;
    readonly reason: string;
    readonly api: ApprovalCall;
  }) =>
    Effect.gen(function* () {
      const { stored, inherited } = limitNow(view, limit);

      if (same(stored) && inherited !== true && !(yield* askedBefore(approvals, api))) {
        return {
          output: [
            {
              type: "text" as const,
              text: `${limit.name.replace(/^t/, "T")} ${scopeWhere(view)} is ${after}${inherited === false ? " as its Override" : ""} already: nothing was asked, changed or recorded.`,
            },
          ],
          details: { scope: view.scope, unchanged: [limit.field], agentChanges: [] },
        };
      }

      return yield* changeLimit({
        tool,
        view,
        limit,
        fieldChange: { field: limit.field, value },
        change: limit.change,
        after,
        reason,
        api,
      });
    });

  const spendLimit = yield* defineEffectTool({
    name: "settings_spend_limit_set",
    description: Arr.join(
      [
        "Set the spend limit: the US dollars one Session (its root conversation and every subagent) may spend on model requests before it stops, or null for no limit. It is a Limit, so the user must approve the change, at either Scope.",
        SCOPE_NOTE,
        APPROVAL,
        CHANGE_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      scope: SettingsScope,
      per_session: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThan(0))).annotate({
        description: "US dollars per Session, more than 0; null turns the limit off",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    // The wait survives an eviction: the rerun finds the same request, or the answer given meanwhile.
    replay: "safe",
    execute: ({ scope, per_session, reason }, api) =>
      Effect.gen(function* () {
        yield* plainReason(reason);

        return yield* setLimit({
          tool: "settings_spend_limit_set",
          view: yield* access.get(scope),
          limit: SPEND_LIMIT,
          value: per_session,
          same: (stored) => stored === per_session,
          after: spendWords(per_session),
          reason,
          api,
        });
      }),
  });

  const subagentDepth = yield* defineEffectTool({
    name: "settings_subagent_depth_set",
    description: Arr.join(
      [
        `Set the subagent depth: how many levels of subagents may run below the root conversation (1: the root's children only; ${DEFAULT_MAX_SUBAGENT_DEPTH}, the default: their children too). A deeper tree can spend more at once. It is a Limit, so the user must approve the change, at either Scope. Subagents that run keep the depth they started with.`,
        SCOPE_NOTE,
        APPROVAL,
        CHANGE_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      scope: SettingsScope,
      depth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
        description: "Levels of subagents below the root, at least 1",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ scope, depth, reason }, api) =>
      Effect.gen(function* () {
        yield* plainReason(reason);

        return yield* setLimit({
          tool: "settings_subagent_depth_set",
          view: yield* access.get(scope),
          limit: DEPTH_LIMIT,
          value: depth,
          same: (stored) => depthOf(stored) === depth,
          after: depthWords(depth),
          reason,
          api,
        });
      }),
  });

  const subagentWorkspaces = yield* defineEffectTool({
    name: "settings_subagent_workspaces_set",
    description: Arr.join(
      [
        `Set the Subagent Workspace limit: how many Subagent Workspaces (subagent with workspace "new": a Workspace of its own, with its own Container) one Session may have at once, default ${DEFAULT_MAX_SUBAGENT_WORKSPACES}. Each runs a Container of its own, which costs while it runs. It is a Limit, so the user must approve the change, at either Scope. Subagent Workspaces that exist stay.`,
        SCOPE_NOTE,
        APPROVAL,
        CHANGE_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      scope: SettingsScope,
      limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
        description: "Subagent Workspaces one Session may have at once; 0 allows none",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ scope, limit, reason }, api) =>
      Effect.gen(function* () {
        yield* plainReason(reason);

        return yield* setLimit({
          tool: "settings_subagent_workspaces_set",
          view: yield* access.get(scope),
          limit: WORKSPACES_LIMIT,
          value: limit,
          same: (stored) => workspacesOf(stored) === limit,
          after: workspacesWords(limit),
          reason,
          api,
        });
      }),
  });

  const reset = yield* defineEffectTool({
    name: "settings_reset",
    description: Arr.join(
      [
        `Reset one setting at a Scope: with an Environment's id, remove the Environment's Override of the field, so it inherits Global again; with scope "${GLOBAL_SETTINGS_SCOPE}", put the field back to its default at Global (an Environment that overrides it keeps its Override). A field the Environment does not override, or that is at its default at Global, changes nothing. The fields: ${RESET_FIELDS}. A Role is one field (its model and hint together), and so is each extension option.`,
        `Resetting a Limit (${Arr.join(
          Arr.map(SETTINGS_LIMITS, (limit) => limit.field),
          ", ",
        )}) waits for the user's Approval at either Scope, as the Limit tools do: ${APPROVAL} Any other field is reset at once.`,
        CHANGE_NOTE,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      scope: SettingsScope,
      field: Schema.String.check(Schema.isMinLength(1)).annotate({
        description:
          "The setting to reset, as settings_get and the Agent changes name it, such as model, roles.small, compaction.enabled or extensions.subagents.readToolset",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    // A Limit's wait survives an eviction; a rerun of any other field's reset finds it reset, and changes nothing.
    replay: "safe",
    execute: ({ scope, field, reason }, api) =>
      Effect.gen(function* () {
        yield* plainReason(reason);

        if (overrideFieldPath(field) === undefined) {
          return yield* SettingsAccessError.make({
            message: `Nothing was asked or saved: ${field} is not a setting settings_reset takes. The settings are: ${RESET_FIELDS}.`,
          });
        }

        const view = yield* access.get(scope);
        const global = isGlobalView(view);
        const label = fieldLabel(field);
        const fieldChange: SettingsFieldChange = { field, value: null, reset: true };
        const limit = Arr.findFirst(SETTINGS_LIMITS, (each) => each.field === field);

        const reset = global
          ? sameJson(
              settingsFieldValue(view.settings, field),
              settingsFieldValue(DEFAULT_SETTINGS, field),
            )
          : Option.isNone(overrideValue(view.overrides, field));

        const already = global
          ? `The ${label} is at its default at Global already: nothing was asked, changed or recorded.`
          : `${scopeName(view)} does not override the ${label}: it inherits Global already, so nothing was asked, changed or recorded.`;

        if (reset && !(Option.isSome(limit) && (yield* askedBefore(approvals, api)))) {
          return {
            output: [{ type: "text" as const, text: already }],
            details: { scope: view.scope, unchanged: [field], agentChanges: [] },
          };
        }

        if (Option.isSome(limit)) {
          return yield* changeLimit({
            tool: "settings_reset",
            view,
            limit: limit.value,
            fieldChange,
            change: `${limit.value.change}, reset`,
            after: global
              ? limit.value.byDefault
              : `${limit.value.words(settingsFieldValue(view.global, field))}${inheritedWords(true)}`,
            reason,
            api,
          });
        }

        return yield* applySettings({
          tool: "settings_reset",
          view,
          fields: [fieldChange],
          reason,
          conversation: api.conversationId,
          unchanged: already,
          changed: ({ changes, reach: reached }) =>
            `Reset the ${label} ${scopeWhere(view)}${global ? " to its default" : ": it inherits Global again"}:\n${changedLines(changes)}\n${reached.text} ${RECORDED}`,
        });
      }),
  });

  const LimitId = idOrGlobal(
    "the size limit at Global, which each Environment that does not override it inherits",
  );

  /** The size settings where the limit is set (an Environment's in force, or Global's), and how a result names it. */
  const limitTarget = (id: string) =>
    Effect.gen(function* () {
      if (id === GLOBAL_ID) {
        const { settings } = yield* environments.global;

        return {
          environment: GLOBAL_ID,
          own: false,
          named: { id: GLOBAL_ID, name: GLOBAL_NAME },
          card: GLOBAL_NAME,
          settings,
          kept: settings.maxInstance,
        };
      }

      const { environment, own } = yield* target(id);
      const details = yield* environments.get(environment);

      if (details === null) return yield* notFound(environment);

      return {
        environment,
        own,
        named: { id: details.id, name: details.name },
        card: `Environment ${JSON.stringify(details.name)}`,
        settings: details.settings,
        // An inherited limit set to the same size becomes the Environment's own, so it is a change.
        kept: details.overrides.maxInstance,
      };
    });

  /**
   * The Environments that inherit the size limit at Global and whose size (their own, or Global's `globalSize`) is above
   * `limit`, each named with its size: what the Registry would refuse the limit for. Before the size raises the limit,
   * as the Registry checks.
   */
  const inheritingAbove = (globalSize: InstanceType, limit: InstanceType) =>
    Effect.gen(function* () {
      const listed = yield* environments.list;
      const each = yield* Effect.forEach(listed, ({ id }) => environments.get(id));

      return Arr.flatMap(each, (details) => {
        if (details === null || details.overrides.maxInstance !== undefined) return [];

        const size = details.overrides.instance ?? globalSize;

        return compareInstances(size, limit) > 0 ? [`${named(details)}, ${size}`] : [];
      });
    });

  const sizeLimit = yield* defineEffectTool({
    name: "environment_container_size_limit_set",
    description: Arr.join(
      [
        "Set an Environment's size limit (the one id names): the largest size its Containers may have, which bounds environment_container_resize and container_resize. A larger limit lets the agent run larger, costlier Containers, so it is a Limit and the user must approve the change. It cannot be below the Environment's own size: lower that first with environment_container_resize.",
        `With id "${GLOBAL_ID}" the limit at Global is set: each Environment that does not override it inherits it, and a limit that would leave such an Environment's size above it is refused. Setting an Environment's limit makes it the Environment's own; environment_setting_reset makes it inherit Global's again.`,
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: LimitId,
      size: InstanceType.annotate({ description: "The largest size the Environment allows" }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ id, size, reason }, api) =>
      Effect.gen(function* () {
        yield* plainReason(reason);

        const { environment, own, named: details, card, settings, kept } = yield* limitTarget(id);
        const where = named(details);
        const { instance, maxInstance } = settings;

        if (compareInstances(size, instance) < 0) {
          return yield* EnvironmentsError.make({
            message: `Nothing was asked or saved: ${size} is below the size of ${where}, ${instance}, and the limit cannot be below the size. Lower the size first with environment_container_resize.`,
          });
        }

        if (size === kept && !(yield* askedBefore(approvals, api))) {
          return {
            output: [
              {
                type: "text" as const,
                text: `The size limit of ${where} is ${size} already: nothing was asked, changed or recorded.`,
              },
            ],
            details: {
              unchanged: {
                environment: { id: details.id, name: details.name },
                field: "maxInstance",
              },
            },
          };
        }

        const above =
          environment === GLOBAL_ID && size !== kept ? yield* inheritingAbove(instance, size) : [];

        if (above.length > 0) {
          return yield* EnvironmentsError.make({
            message: `Nothing was asked or saved: ${size} is below the own size of ${Arr.join(above, ", ")}, which inherit${above.length === 1 ? "s" : ""} the size limit at Global, and the limit cannot be below the size. Give each its own limit with environment_container_size_limit_set, or lower its size first with environment_container_resize.`,
          });
        }

        const change = "Size limit";

        return yield* withApproval(
          approvals,
          api,
          {
            tool: "environment_container_size_limit_set",
            target: card,
            change,
            before: sizeWords(maxInstance),
            after: sizeWords(size),
            reason,
            expected: maxInstance,
          },
          (answer) =>
            Effect.gen(function* () {
              if (!answer.approved) {
                return declined(
                  answer,
                  `the size limit of ${where} from ${maxInstance} to ${size}`,
                );
              }

              const applied = yield* environments.change({
                environment,
                change: { field: "maxInstance", value: size },
                expected: { value: answer.expected },
                author: {
                  conversation: api.conversationId,
                  tool: "environment_container_size_limit_set",
                  reason,
                  approved: true,
                },
              });

              switch (applied.status) {
                case "missing":
                  return yield* notFound(environment);
                case "rejected":
                  return yield* EnvironmentsError.make({
                    message: `The user approved, but nothing was saved: ${applied.message}`,
                  });
                case "changed-since":
                  return yield* EnvironmentsError.make({
                    message: changedSince(
                      `the size limit of ${where}`,
                      storedSizeWords(applied.current),
                    ),
                  });
                case "unchanged":
                  return {
                    output: [
                      {
                        type: "text" as const,
                        text: approvedAlready(`the size limit of ${where} is ${size}`),
                      },
                    ],
                    details: { approval: { approved: true } },
                  };
                case "changed":
                  yield* log.record({
                    tool: "environment_container_size_limit_set",
                    environmentName: applied.environment.name,
                    field: "maxInstance",
                  });

                  return {
                    output: [
                      {
                        type: "text" as const,
                        text: `The user approved: the size limit of ${named(applied.environment)} was ${maxInstance}, and is ${size} now. environment_container_resize and container_resize may now use sizes up to ${size}. ${applied.global === undefined ? describeApplied(own, applied.newBuild) : describeAppliedGlobal("maxInstance", applied.global)} The change is recorded as approved, with your reason; the user can revert it on the Environments page.`,
                      },
                    ],
                    details: {
                      approval: { approved: true },
                      agentChange: {
                        id: applied.change.id,
                        environment: applied.environment,
                        field: "maxInstance",
                        before: asJsonValue(applied.change.before),
                        after: asJsonValue(applied.change.after),
                      },
                    },
                  };
              }
            }),
        );
      }),
  });

  const deleteEnvironment = yield* defineEffectTool({
    name: "environment_delete",
    description: Arr.join(
      [
        "Delete an Environment, as the user's delete on the Environments page does: its Workspaces with their Sessions (archived ones too) and everything not pushed in them, its spare Workspace, its Build, the Secrets kept for it and its Agent changes. No revert can bring it back, so the user must approve it. The default Environment and this Session's own Environment cannot be deleted.",
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: Id,
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ id, reason }, api) =>
      Effect.gen(function* () {
        yield* plainReason(reason);

        if (id === DEFAULT_ENVIRONMENT) {
          return yield* EnvironmentsError.make({
            message:
              "Nothing was asked or deleted: the default Environment cannot be deleted, so that a new Session always has one to start in.",
          });
        }

        const { own } = yield* target(id);

        if (own) {
          return yield* EnvironmentsError.make({
            message:
              "Nothing was asked or deleted: this is this Session's own Environment, whose Workspace this Session runs in. The user can delete it from the Environments page.",
          });
        }

        /** The Environment and what deleting it takes, or null when it is gone. */
        const describe = Effect.gen(function* () {
          const details = yield* environments.get(id);
          const footprint = yield* removal.footprint(id);

          return details === null || footprint === null ? null : { details, footprint };
        });

        const found = yield* describe;
        const rerun = yield* askedBefore(approvals, api);

        if (found === null && !rerun) return yield* notFound(id);

        // A rerun whose Environment is gone (deleted by this call before the Session restarted, or by the user) waits
        // for, or takes, the answer to the request it made: what it shows the owner is that request's.
        const environment: ChangedEnvironment = found?.details ?? { id, name: id };
        const where = named(environment);
        const before = found === null ? where : `${where}: ${footprintWords(found.footprint)}`;

        return yield* withApproval(
          approvals,
          api,
          {
            tool: "environment_delete",
            target: `Environment ${JSON.stringify(environment.name)}`,
            change: "Delete the Environment",
            before,
            after: "Deleted, with no revert",
            reason,
            expected: found?.footprint ?? null,
          },
          (answer) =>
            Effect.gen(function* () {
              if (!answer.approved) return declined(answer, `deleting ${where}`);

              const now = yield* describe;

              if (now === null) {
                return {
                  output: [{ type: "text" as const, text: approvedAlready(`${where} is gone`) }],
                  details: { approval: { approved: true } },
                };
              }

              const approved = Schema.decodeUnknownOption(EnvironmentFootprint)(answer.expected);

              // The approval covers what the card showed, or less of it: a delete an eviction cut off has taken some
              // of it already. A Workspace, Session or kept Secret added since is not covered.
              if (Option.isNone(approved) || !within(now.footprint, approved.value)) {
                return yield* EnvironmentsError.make({
                  message: changedSince(
                    `what deleting ${where} takes`,
                    footprintWords(now.footprint),
                  ),
                });
              }

              const deleted = `${named(now.details)}: ${footprintWords(approved.value)}`;

              yield* removal.deleteEnvironment(id);
              yield* log.record({
                tool: "environment_delete",
                environmentName: now.details.name,
                field: DELETED_FIELD,
              });

              return {
                output: [
                  {
                    type: "text" as const,
                    text: `The user approved: deleted ${deleted}. No revert brings it back.`,
                  },
                ],
                details: {
                  approval: { approved: true },
                  agentChange: {
                    environment: { id: now.details.id, name: now.details.name },
                    field: DELETED_FIELD,
                    before: deleted,
                    after: null,
                  },
                },
              };
            }),
        );
      }),
  });

  const deleteSecret = yield* defineEffectTool({
    name: "environment_secret_delete",
    description: Arr.join(
      [
        `Delete a Secret kept for an Environment (the one id names; id "${GLOBAL_ID}" is a Secret kept Global), as the user's delete on the Environments page does: commands and Sessions no longer get it, nor Builds. The history keeps no value, so no revert brings it back, and the user must approve it. environment_get lists the Secrets kept (names only).`,
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: idOrGlobal("a Secret kept Global"),
      name: SecretName.annotate({ description: "The Secret's name, such as NPM_TOKEN" }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ id, name, reason }, api) =>
      Effect.gen(function* () {
        yield* plainReason(reason);

        const environment = id === GLOBAL_ID ? GLOBAL_ID : (yield* target(id)).environment;

        const scope: ChangedEnvironment =
          environment === GLOBAL_ID
            ? { id: GLOBAL_ID, name: GLOBAL_NAME }
            : yield* Effect.flatMap(environments.get(environment), (details) =>
                details === null
                  ? notFound(environment)
                  : Effect.succeed({ id: details.id, name: details.name }),
              );

        const kept = yield* removal.keptSecrets(environment);

        if (kept === null) return yield* notFound(environment);

        const secret = Arr.findFirst(kept, (each) => each.name === name);

        if (Option.isNone(secret) && !(yield* askedBefore(approvals, api))) {
          return yield* EnvironmentsError.make({
            message: `Nothing was asked or deleted: no Secret ${name} is ${keptIn(scope)}. environment_get with id ${environment} lists the Secrets kept (names only); a Secret kept Global is addressed with id "${GLOBAL_ID}".`,
          });
        }

        const marked = Option.isSome(secret) && secret.value.build;
        const before = `${name}, ${keptIn(scope)}${marked ? ", marked for the Build" : ""}`;

        return yield* withApproval(
          approvals,
          api,
          {
            tool: "environment_secret_delete",
            target: scope.id === GLOBAL_ID ? "Global" : `Environment ${JSON.stringify(scope.name)}`,
            change: "Delete a kept Secret",
            before,
            after: "Deleted, with no revert",
            reason,
            // The Secret as the owner saw it: deleted only while its value and Build mark are still those.
            expected: Option.match(secret, {
              onNone: () => null,
              onSome: ({ updatedAt }) => ({ updatedAt }),
            }),
          },
          (answer) =>
            Effect.gen(function* () {
              if (!answer.approved) return declined(answer, `deleting ${before}`);

              const deleted = yield* removal.deleteSecret({
                environment,
                name,
                expected: Option.getOrUndefined(
                  Schema.decodeUnknownOption(SecretAsked)(answer.expected),
                ),
                author: {
                  conversation: api.conversationId,
                  tool: "environment_secret_delete",
                  reason,
                  approved: true,
                },
              });

              switch (deleted.status) {
                case "missing":
                  return yield* notFound(environment);
                case "absent":
                  return {
                    output: [
                      {
                        type: "text" as const,
                        text: approvedAlready(
                          `no Secret ${name} is ${keptIn(deleted.environment)}`,
                        ),
                      },
                    ],
                    details: { approval: { approved: true } },
                  };
                case "changed-since":
                  return yield* EnvironmentsError.make({
                    message: `The user approved, but ${name}, ${keptIn(deleted.environment)}, changed since they were asked (its value or its Build mark): nothing was deleted. Ask again if it should still be deleted.`,
                  });
                case "deleted":
                  yield* log.record({
                    tool: "environment_secret_delete",
                    environmentName: deleted.environment.name,
                    field: keptSecretField(name),
                  });

                  return {
                    output: [
                      {
                        type: "text" as const,
                        text: `The user approved: deleted ${before}. Commands and Sessions stop getting it once they next ask for the kept Secrets (within a minute); this Session keeps taking its value out of output until it is evicted. The Builds' upkeep ran, as after the user's own delete. No revert brings it back: the user keeps it again with secret_ask's form or on the Environments page.`,
                      },
                    ],
                    details: {
                      approval: { approved: true },
                      agentChange: {
                        id: deleted.change.id,
                        environment: deleted.environment,
                        field: deleted.change.field,
                        before: asJsonValue(deleted.change.before),
                        after: asJsonValue(deleted.change.after),
                      },
                    },
                  };
              }
            }),
        );
      }),
  });

  return defineExtension({
    name: extensionName,
    tools: [
      spendLimit,
      subagentDepth,
      subagentWorkspaces,
      sizeLimit,
      deleteEnvironment,
      deleteSecret,
      reset,
    ],
  });
});
