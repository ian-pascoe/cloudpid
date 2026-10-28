// @effect-diagnostics missingPipeableSignature:off preferSchemaOverJson:off
// The tools whose Agent changes wait for the owner's Approval (`docs/architecture/agent-changes.md` → Approval, ADR-0019): those that change a
// Limit (`settings_spend_limit_set`, `settings_subagent_depth_set`, `settings_subagent_workspaces_set`,
// `environment_container_size_limit_set`) and those no revert can undo (`environment_delete`,
// `environment_secret_delete`). Each checks what it can first and refuses without asking what it would refuse anyway;
// then it asks the owner (`withApproval`), and on Approve makes the change as the other tools do (applied, recorded
// with an approved mark, in the Run's Notification), provided the target still has the value the owner saw. A Decline
// changes nothing, and the result carries the owner's reason. The tools are the root conversation's only
// (`PARENT_ONLY_TOOL_PREFIXES` has `environment_` and `settings_`), run alone, and are replayed after an eviction: the
// rerun waits for the same request, or takes the answer given meanwhile.
import {
  compareInstances,
  extensionField,
  INSTANCE_DESCRIPTIONS,
  InstanceType,
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
  refuseGlobal,
  Environments,
  EnvironmentsError,
  MAX_CHANGE_REASON,
} from "./environment.ts";
import { GLOBAL_ID, GLOBAL_NAME } from "./environment-secret-marks.ts";
import { holdsPlaceholder } from "./secrets/references.ts";
import { Secrets } from "./secrets/store.ts";
import { SettingsAccess, SettingsAccessError, SettingsReload } from "./settings.ts";
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

/** A size limit as the owner reads it. */
const sizeWords = (size: InstanceType): string => `${size} (${INSTANCE_DESCRIPTIONS[size]})`;

const isInstanceType = Schema.is(InstanceType);

/** A stored size limit as the owner reads it. */
const storedSizeWords = (stored: Schema.Json | null): string =>
  isInstanceType(stored) ? sizeWords(stored) : JSON.stringify(stored);

/** An Environment as a result and a card name it. */
const named = ({ id, name }: ChangedEnvironment): string =>
  id === GLOBAL_ID ? GLOBAL_NAME : `Environment ${JSON.stringify(name)} (${id})`;

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

  /** The Environment `id` names, this Session's by default, with whether it is this Session's. */
  const target = (id: string | undefined) =>
    Effect.gen(function* () {
      yield* refuseGlobal(id);

      const current = yield* environments.current;
      const environment = id ?? current;

      if (environment === null) {
        return yield* EnvironmentsError.make({
          message:
            "This Session belongs to no Environment the Registry lists: name one with id (environment_list shows them).",
        });
      }

      return { environment, own: environment === current };
    });

  const notFound = (id: string) =>
    EnvironmentsError.make({
      message: `No Environment has the id ${JSON.stringify(id)}. Call environment_list for the Environments and their ids.`,
    });

  /**
   * Change the Settings' `field` to `value` with the owner's Approval: `before` is what it is now (`stored`, as the
   * Registry reads it, is what the change is made against), and the words are what the card and the result say.
   */
  const changeLimit = ({
    tool,
    field,
    value,
    stored,
    reason,
    api,
    change,
    before,
    after,
    words,
  }: {
    readonly tool: string;
    readonly field: string;
    readonly value: Schema.Json | null;
    readonly stored: Schema.Json | null;
    readonly reason: string;
    readonly api: ApprovalCall;
    readonly change: string;
    readonly before: string;
    readonly after: string;
    /** A stored value of the field as the owner reads it. */
    readonly words: (value: Schema.Json | null) => string;
  }) =>
    withApproval(
      approvals,
      api,
      { tool, target: "the Settings", change, before, after, reason, expected: stored },
      (answer) =>
        Effect.gen(function* () {
          if (!answer.approved) return declined(answer, `${change} from ${before} to ${after}`);

          const applied = yield* access.change({
            changes: [{ field, value, expected: { value: answer.expected } }],
            author: { conversation: api.conversationId, tool, reason, approved: true },
          });

          switch (applied.status) {
            case "rejected":
              return yield* SettingsAccessError.make({
                message: `The user approved, but nothing was saved: ${applied.message}`,
              });
            case "changed-since":
              return yield* SettingsAccessError.make({
                message: changedSince(change, words(applied.current)),
              });
            case "unchanged":
              return {
                output: [{ type: "text" as const, text: approvedAlready(`${change} is ${after}`) }],
                details: { approval: { approved: true }, agentChanges: [] },
              };
            case "changed": {
              for (const made of applied.changes) yield* log.record({ tool, field: made.field });

              yield* reload.apply;

              return {
                output: [
                  {
                    type: "text" as const,
                    text: `The user approved: ${change} was ${before}, and is ${after} now. It reaches this Session's next request, and other Sessions when they next admit input. The change is recorded as approved, with your reason; the user can revert it on the Settings page.`,
                  },
                ],
                details: {
                  approval: { approved: true },
                  agentChanges: Arr.map(applied.changes, (made) => ({
                    id: made.id,
                    field: made.field,
                    before: asJsonValue(made.before),
                    after: asJsonValue(made.after),
                  })),
                },
              };
            }
          }
        }),
    );

  const spendLimit = yield* defineEffectTool({
    name: "settings_spend_limit_set",
    description: Arr.join(
      [
        "Set the spend limit: the US dollars one Session (its root conversation and every subagent) may spend on model requests before it stops, or null for no limit. It is a Limit, so the user must approve the change.",
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      per_session: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThan(0))).annotate({
        description: "US dollars per Session, more than 0; null turns the limit off",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    // The wait survives an eviction: the rerun finds the same request, or the answer given meanwhile.
    replay: "safe",
    execute: ({ per_session, reason }, api) =>
      Effect.gen(function* () {
        yield* plainReason(reason);

        const current = (yield* access.get).settings.spendLimit.perSession;

        if (current === per_session && !(yield* askedBefore(approvals, api))) {
          return {
            output: [
              {
                type: "text" as const,
                text: `The spend limit is ${spendWords(current)} already: nothing was asked, changed or recorded.`,
              },
            ],
            details: { unchanged: ["spendLimit.perSession"], agentChanges: [] },
          };
        }

        return yield* changeLimit({
          tool: "settings_spend_limit_set",
          field: "spendLimit.perSession",
          value: per_session,
          stored: current,
          reason,
          api,
          change: "Spend limit",
          before: spendWords(current),
          after: spendWords(per_session),
          words: spendWords,
        });
      }),
  });

  const depthField = extensionField("subagents", "maxSubagentDepth");

  const subagentDepth = yield* defineEffectTool({
    name: "settings_subagent_depth_set",
    description: Arr.join(
      [
        `Set the subagent depth: how many levels of subagents may run below the root conversation (1: the root's children only; ${DEFAULT_MAX_SUBAGENT_DEPTH}, the default: their children too). A deeper tree can spend more at once. It is a Limit, so the user must approve the change. Subagents that run keep the depth they started with.`,
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      depth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
        description: "Levels of subagents below the root, at least 1",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ depth, reason }, api) =>
      Effect.gen(function* () {
        yield* plainReason(reason);

        const view = yield* access.get;
        const stored = view.settings.extensions.subagents?.maxSubagentDepth ?? null;

        const current = depthOf(stored);

        if (current === depth && !(yield* askedBefore(approvals, api))) {
          return {
            output: [
              {
                type: "text" as const,
                text: `The subagent depth is ${depth} already: nothing was asked, changed or recorded.`,
              },
            ],
            details: { unchanged: [depthField], agentChanges: [] },
          };
        }

        return yield* changeLimit({
          tool: "settings_subagent_depth_set",
          field: depthField,
          value: depth,
          stored,
          reason,
          api,
          change: "Subagent depth",
          before: storedDepthWords(stored),
          after: depthWords(depth),
          words: storedDepthWords,
        });
      }),
  });

  const workspacesField = extensionField("subagents", "maxSubagentWorkspaces");

  const subagentWorkspaces = yield* defineEffectTool({
    name: "settings_subagent_workspaces_set",
    description: Arr.join(
      [
        `Set the Subagent Workspace limit: how many Subagent Workspaces (subagent with workspace "new": a Workspace of its own, with its own Container) one Session may have at once, default ${DEFAULT_MAX_SUBAGENT_WORKSPACES}. Each runs a Container of its own, which costs while it runs. It is a Limit, so the user must approve the change. Subagent Workspaces that exist stay.`,
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).annotate({
        description: "Subagent Workspaces one Session may have at once; 0 allows none",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ limit, reason }, api) =>
      Effect.gen(function* () {
        yield* plainReason(reason);

        const view = yield* access.get;
        const stored = view.settings.extensions.subagents?.maxSubagentWorkspaces ?? null;

        if (workspacesOf(stored) === limit && !(yield* askedBefore(approvals, api))) {
          return {
            output: [
              {
                type: "text" as const,
                text: `The Subagent Workspace limit is ${limit} already: nothing was asked, changed or recorded.`,
              },
            ],
            details: { unchanged: [workspacesField], agentChanges: [] },
          };
        }

        return yield* changeLimit({
          tool: "settings_subagent_workspaces_set",
          field: workspacesField,
          value: limit,
          stored,
          reason,
          api,
          change: "Subagent Workspace limit",
          before: storedWorkspacesWords(stored),
          after: workspacesWords(limit),
          words: storedWorkspacesWords,
        });
      }),
  });

  const Id = Schema.String.annotate({
    description:
      "The Environment's id, as environment_list shows it (default: this Session's Environment)",
  });

  const sizeLimit = yield* defineEffectTool({
    name: "environment_container_size_limit_set",
    description: Arr.join(
      [
        "Set an Environment's size limit (this Session's unless id names another): the largest size its Containers may have, which bounds environment_container_resize and container_resize. A larger limit lets the agent run larger, costlier Containers, so it is a Limit and the user must approve the change. It cannot be below the Environment's own size: lower that first with environment_container_resize.",
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: Schema.optionalKey(Id),
      size: InstanceType.annotate({ description: "The largest size the Environment allows" }),
      reason: Reason,
    }),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ id, size, reason }, api) =>
      Effect.gen(function* () {
        yield* plainReason(reason);

        const { environment, own } = yield* target(id);
        const details = yield* environments.get(environment);

        if (details === null) return yield* notFound(environment);

        const where = named(details);
        const { instance, maxInstance } = details.settings;

        if (compareInstances(size, instance) < 0) {
          return yield* EnvironmentsError.make({
            message: `Nothing was asked or saved: ${size} is below the size of ${where}, ${instance}, and the limit cannot be below the size. Lower the size first with environment_container_resize.`,
          });
        }

        if (size === maxInstance && !(yield* askedBefore(approvals, api))) {
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

        const change = "Size limit";

        return yield* withApproval(
          approvals,
          api,
          {
            tool: "environment_container_size_limit_set",
            target: `Environment ${JSON.stringify(details.name)}`,
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
                        text: `The user approved: the size limit of ${named(applied.environment)} was ${maxInstance}, and is ${size} now. environment_container_resize and container_resize may now use sizes up to ${size}. ${describeApplied(own, applied.newBuild)} The change is recorded as approved, with your reason; the user can revert it on the Environments page.`,
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
      id: Schema.String.annotate({
        description: "The Environment's id, as environment_list shows it",
      }),
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
        `Delete a Secret kept for an Environment (this Session's unless id names another; id "${GLOBAL_ID}" is a Secret kept Global), as the user's delete on the Environments page does: commands and Sessions no longer get it, nor Builds. The history keeps no value, so no revert brings it back, and the user must approve it. environment_get lists the Secrets kept (names only).`,
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: Schema.optionalKey(
        Schema.String.annotate({
          description: `The Environment's id, as environment_list shows it (default: this Session's Environment), or "${GLOBAL_ID}" for a Secret kept Global`,
        }),
      ),
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
            message: `Nothing was asked or deleted: no Secret ${name} is kept for ${named(scope)}. environment_get lists the Secrets kept (names only); a Secret kept Global is addressed with id "${GLOBAL_ID}".`,
          });
        }

        const marked = Option.isSome(secret) && secret.value.build;
        const before = `${name}, kept for ${named(scope)}${marked ? ", marked for the Build" : ""}`;

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
                          `no Secret ${name} is kept for ${named(deleted.environment)}`,
                        ),
                      },
                    ],
                    details: { approval: { approved: true } },
                  };
                case "changed-since":
                  return yield* EnvironmentsError.make({
                    message: `The user approved, but ${name}, kept for ${named(deleted.environment)}, changed since they were asked (its value or its Build mark): nothing was deleted. Ask again if it should still be deleted.`,
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
    ],
  });
});
