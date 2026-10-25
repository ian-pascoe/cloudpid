// @effect-diagnostics missingPipeableSignature:off preferSchemaOverJson:off
// The tools whose Agent changes wait for the owner's Approval (`docs/spec.md` → Approval, ADR-0019): those that change a
// Limit (`settings_spend_limit_set`, `settings_subagent_depth_set`, `environment_container_size_limit_set`) and those no
// revert can undo (`environment_delete`, `environment_secret_delete`). Each checks what it can first and refuses without
// asking what it would refuse anyway; then it asks the owner (`withApproval`), and on Approve makes the change as the
// other tools do (applied, recorded with an approved mark, in the Run's Notification), provided the target still has the
// value the owner saw. A Decline changes nothing, and the result carries the owner's reason. The tools are the root
// conversation's only (`PARENT_ONLY_TOOL_PREFIXES` has `environment_` and `settings_`), run alone, and are replayed
// after an eviction: the rerun waits for the same request, or takes the answer given meanwhile.
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
import { type ApprovalAnswer, type ApprovalCall, Approvals, withApproval } from "./approvals.ts";
import {
  AgentChangeLog,
  type ChangeAuthor,
  type ChangedEnvironment,
  DeployCredentials,
  describeApplied,
  Environments,
  EnvironmentsError,
  MAX_CHANGE_REASON,
} from "./environment.ts";
import { EVERY_ENVIRONMENT_ID, EVERY_ENVIRONMENT_NAME } from "./environment-secret-marks.ts";
import { Redactions } from "./secrets/redaction.ts";
import { Secrets } from "./secrets/store.ts";
import { SettingsAccess, SettingsAccessError, SettingsReload } from "./settings.ts";
import { DEFAULT_MAX_SUBAGENT_DEPTH } from "./subagents/options.ts";

export const extensionName = "approvals";

/** What deleting an Environment takes with it, as the owner is asked about it. */
export type EnvironmentFootprint = {
  /** Its Workspaces, but its spare. */
  readonly workspaces: number;
  /** The Sessions in them, archived ones too. */
  readonly sessions: number;
  /** The Secrets kept for it alone. */
  readonly secrets: number;
};

/** A Secret kept in a scope, by name: whether it reaches the Build. */
export type KeptSecretMark = { readonly name: string; readonly build: boolean };

/** How the delete of a kept Secret went. */
export type SecretDeleted =
  | {
      readonly status: "deleted";
      /** The Environment, or every Environment (`EVERY_ENVIRONMENT_ID`), whose history records it. */
      readonly environment: ChangedEnvironment;
      readonly change: AgentChange;
    }
  /** No Secret of the name is kept there (any more): nothing was deleted. */
  | { readonly status: "absent"; readonly environment: ChangedEnvironment }
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
  /** The Secrets kept in `scope` (an Environment's id, or `EVERY_ENVIRONMENT_ID`); null for an unknown Environment. */
  readonly keptSecrets: (
    scope: string,
  ) => Effect.Effect<ReadonlyArray<KeptSecretMark> | null, EnvironmentsError>;
  /** Delete the Secret `name` kept in `environment`'s scope and record it, then run the Builds' upkeep it touches. */
  readonly deleteSecret: (input: {
    readonly environment: string;
    readonly name: string;
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

/** A size limit as the owner reads it. */
const sizeWords = (size: InstanceType): string => `${size} (${INSTANCE_DESCRIPTIONS[size]})`;

/** An Environment as a result and a card name it. */
const named = ({ id, name }: ChangedEnvironment): string =>
  id === EVERY_ENVIRONMENT_ID
    ? EVERY_ENVIRONMENT_NAME
    : `Environment ${JSON.stringify(name)} (${id})`;

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** What deleting an Environment takes with it, as the card says it: what the owner approves. */
const footprintWords = (footprint: EnvironmentFootprint): string =>
  `${count(footprint.workspaces, "Workspace")} with ${count(footprint.sessions, "Session")} (archived ones too), its spare Workspace and Build, ${count(footprint.secrets, "kept Secret")} and its Agent changes`;

/** What the result of a declined request says. */
const declined = (answer: Extract<ApprovalAnswer, { approved: false }>, what: string) => ({
  output: [
    {
      type: "text" as const,
      text: `The user declined: ${what}. Nothing changed.${
        answer.reason === undefined ? "" : ` Their reason: ${answer.reason}`
      } Do not ask again for the same change unless the user wants it.`,
    },
  ],
  // The reason is null when the owner gave none.
  details: { approval: { approved: false, reason: answer.reason ?? null } },
});

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

  const credentials = new Redactions();

  for (const value of (yield* DeployCredentials).values) credentials.hold("GITHUB_TOKEN", value);

  /** Fails, asking nothing, when the reason holds a Secret the Session holds or a deploy-time credential. */
  const plainReason = (reason: string) =>
    Effect.flatMap(secrets.refresh, () =>
      secrets.redact(reason) === reason && credentials.redact(reason) === reason
        ? Effect.void
        : EnvironmentsError.make({
            message:
              "Nothing was asked or saved: the reason holds the value of a Secret this Session holds, or of the GitHub token. Say why without it.",
          }),
    );

  /** The Environment `id` names, this Session's by default, with whether it is this Session's. */
  const target = (id: string | undefined) =>
    Effect.gen(function* () {
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
                message: changedSince(change, JSON.stringify(applied.current)),
              });
            case "unchanged":
              return {
                output: [
                  {
                    type: "text" as const,
                    text: `The user approved, and ${change} is ${after} already: nothing changed, and nothing was recorded.`,
                  },
                ],
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

        if (current === per_session) {
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

        const current =
          Predicate.isNumber(stored) && Number.isInteger(stored) && stored > 0
            ? stored
            : DEFAULT_MAX_SUBAGENT_DEPTH;

        if (current === depth) {
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
          before: `${depthWords(current)}${stored === null ? " (the default)" : ""}`,
          after: depthWords(depth),
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

        if (size === maxInstance) {
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
                      JSON.stringify(applied.current),
                    ),
                  });
                case "unchanged":
                  return {
                    output: [
                      {
                        type: "text" as const,
                        text: `The user approved, and the size limit of ${where} is ${size} already: nothing changed, and nothing was recorded.`,
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

        /** The Environment as the owner is asked about it, or null when it is gone. */
        const describe = Effect.gen(function* () {
          const details = yield* environments.get(id);
          const footprint = yield* removal.footprint(id);

          return details === null || footprint === null
            ? null
            : { details, words: `${named(details)}: ${footprintWords(footprint)}` };
        });

        const found = yield* describe;

        if (found === null) return yield* notFound(id);

        const { details } = found;

        return yield* withApproval(
          approvals,
          api,
          {
            tool: "environment_delete",
            target: `Environment ${JSON.stringify(details.name)}`,
            change: "Delete the Environment",
            before: found.words,
            after: "Deleted, with no revert",
            reason,
            expected: found.words,
          },
          (answer) =>
            Effect.gen(function* () {
              if (!answer.approved) return declined(answer, `deleting ${named(details)}`);

              const now = yield* describe;

              if (now === null) {
                return {
                  output: [
                    {
                      type: "text" as const,
                      text: `The user approved, and ${named(details)} is gone already: nothing was deleted.`,
                    },
                  ],
                  details: { approval: { approved: true } },
                };
              }

              if (now.words !== answer.expected) {
                return yield* EnvironmentsError.make({
                  message: changedSince(named(details), now.words),
                });
              }

              yield* removal.deleteEnvironment(id);
              yield* log.record({
                tool: "environment_delete",
                environmentName: details.name,
                field: "environment",
              });

              return {
                output: [
                  {
                    type: "text" as const,
                    text: `The user approved: deleted ${now.words}. No revert brings it back.`,
                  },
                ],
                details: {
                  approval: { approved: true },
                  agentChange: {
                    environment: { id: details.id, name: details.name },
                    field: "environment",
                    before: now.words,
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
        `Delete a Secret kept for an Environment (this Session's unless id names another; id "${EVERY_ENVIRONMENT_ID}" is a Secret kept for every Environment), as the user's delete on the Environments page does: commands and Sessions no longer get it, nor Builds. The history keeps no value, so no revert brings it back, and the user must approve it. environment_get lists the Secrets kept (names only).`,
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: Schema.optionalKey(
        Schema.String.annotate({
          description: `The Environment's id, as environment_list shows it (default: this Session's Environment), or "${EVERY_ENVIRONMENT_ID}" for a Secret kept for every Environment`,
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

        const environment =
          id === EVERY_ENVIRONMENT_ID ? EVERY_ENVIRONMENT_ID : (yield* target(id)).environment;

        const scope: ChangedEnvironment =
          environment === EVERY_ENVIRONMENT_ID
            ? { id: EVERY_ENVIRONMENT_ID, name: EVERY_ENVIRONMENT_NAME }
            : yield* Effect.flatMap(environments.get(environment), (details) =>
                details === null
                  ? notFound(environment)
                  : Effect.succeed({ id: details.id, name: details.name }),
              );

        const kept = yield* removal.keptSecrets(environment);

        if (kept === null) return yield* notFound(environment);

        const secret = Arr.findFirst(kept, (each) => each.name === name);

        if (Option.isNone(secret)) {
          return yield* EnvironmentsError.make({
            message: `Nothing was asked or deleted: no Secret ${name} is kept for ${named(scope)}. environment_get lists the Secrets kept (names only); a Secret kept for every Environment is addressed with id "${EVERY_ENVIRONMENT_ID}".`,
          });
        }

        const before = `${name}, kept for ${named(scope)}${secret.value.build ? ", marked for the Build" : ""}`;

        return yield* withApproval(
          approvals,
          api,
          {
            tool: "environment_secret_delete",
            target:
              scope.id === EVERY_ENVIRONMENT_ID
                ? "every Environment"
                : `Environment ${JSON.stringify(scope.name)}`,
            change: "Delete a kept Secret",
            before,
            after: "Deleted, with no revert",
            reason,
            expected: name,
          },
          (answer) =>
            Effect.gen(function* () {
              if (!answer.approved) return declined(answer, `deleting ${before}`);

              const deleted = yield* removal.deleteSecret({
                environment,
                name,
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
                        text: `The user approved, and no Secret ${name} is kept for ${named(deleted.environment)} any more: nothing was deleted.`,
                      },
                    ],
                    details: { approval: { approved: true } },
                  };
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
    tools: [spendLimit, subagentDepth, sizeLimit, deleteEnvironment, deleteSecret],
  });
});
