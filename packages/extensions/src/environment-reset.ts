// The `environment` extension's `environment_setting_reset` (`docs/architecture/agent-changes.md`): the agent takes an
// Environment's Override of one Container setting back, so the field inherits the value at Global again. The reset is
// applied as the owner's reset is (`changeEnvironment` with no value) and recorded as an Agent change whose value after
// is inherited. A reset of the size limit may raise or lower the largest size the Environment allows, so it is a Limit:
// it waits for the owner's Approval (`./approvals.ts`), as `environment_container_size_limit_set` does. Global's own
// settings are not reset here: Global inherits nothing, and its value is changed with the setting's own tool at `*`.
// @effect-diagnostics missingPipeableSignature:off preferSchemaOverJson:off
import { compareInstances, INSTANCE_DESCRIPTIONS, InstanceType } from "@cloudpid/config";
import { defineEffectTool } from "@cloudpid/effect-durable";
import type { AgentChange } from "@cloudpid/protocol";
import type { JsonValue } from "@earendil-works/chord";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  type ApprovalCall,
  type ApprovalsService,
  approvedAlready,
  askedBefore,
  declined,
  withApproval,
} from "./approvals.ts";
import {
  type ChangedEnvironment,
  describeApplied,
  type EnvironmentDetails,
  EnvironmentsError,
  MAX_CHANGE_REASON,
} from "./environment.ts";
import type { LifecycleDeps } from "./environment-lifecycle.ts";

/** The Container settings an Environment may override and reset, but its variables (`environment_variable_unset`). */
export const RESETTABLE_SETTINGS = [
  "instance",
  "maxInstance",
  "idleMinutes",
  "ignore",
  "setupScript",
  "startScript",
  "toolchains",
  "spareWorkspace",
] as const;

export type ResettableSetting = (typeof RESETTABLE_SETTINGS)[number];

/** Each setting as a result names it. */
const SETTING_WORDS: Readonly<Record<ResettableSetting, string>> = {
  instance: "Container size",
  maxInstance: "size limit",
  idleMinutes: "idle time",
  ignore: "extra Container-only paths",
  setupScript: "Setup Script",
  startScript: "Start Script",
  toolchains: "Toolchains",
  spareWorkspace: "Spare Workspace",
};

/** A setting's value as a result says it: a text by its size (the user sees the text on the Environments page). */
const valueWords = (setting: ResettableSetting, value: Schema.Json | null): string => {
  switch (setting) {
    case "setupScript":
    case "startScript":
    case "toolchains": {
      const text = Predicate.isString(value) ? value : "";
      const lines = text.replace(/\n$/, "").split("\n").length;

      return text === ""
        ? "none"
        : `${lines} line${lines === 1 ? "" : "s"}, ${new TextEncoder().encode(text).length} bytes`;
    }

    case "ignore":
      return Arr.isArray(value) && value.length > 0
        ? Arr.join(Arr.map(value, String), ", ")
        : "none";
    case "spareWorkspace":
      return value === true ? "on" : "off";
    case "idleMinutes":
      return `${JSON.stringify(value)} minutes`;
    case "instance":
    case "maxInstance":
      return Predicate.isString(value) ? value : JSON.stringify(value);
  }
};

/** A size limit as the owner reads it on the Approval card. */
const sizeWords = (size: InstanceType): string => `${size} (${INSTANCE_DESCRIPTIONS[size]})`;

/** A Schema `Json` value as the details' `JsonValue`, which differs only in that its arrays are mutable. */
// SAFETY: the two types describe the same values; the details are never mutated.
const asJsonValue = (value: Schema.Json | null): JsonValue | null => value as JsonValue | null;

const named = ({ id, name }: ChangedEnvironment): string =>
  `Environment ${JSON.stringify(name)} (${id})`;

/** The Session's Approvals, which a reset of the size limit asks. */
export type ResetDeps = LifecycleDeps & { readonly approvals: ApprovalsService };

/** `environment_setting_reset`, over the Session's `Environments`. */
export const resetTool = ({
  environments,
  approvals,
  log,
  refuseSecrets,
  target,
  notFound,
}: ResetDeps) => {
  // Built here, not at the module's top: `environment.ts` imports this file, so its exports are not there yet then.
  const Reason = Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_CHANGE_REASON),
  ).annotate({
    description:
      "Why you make the change, for the user to read in the Environment's Agent changes (and on the Approval card, for the size limit), such as 'the Global Setup Script now installs what this one did'",
  });

  /** The card's view of a reset made. */
  const agentChangeOf = (
    setting: ResettableSetting,
    environment: ChangedEnvironment,
    change: AgentChange,
  ) => ({
    id: change.id,
    environment,
    field: setting,
    before: asJsonValue(change.before),
    after: asJsonValue(change.after),
  });

  /** The result of a reset made: what it says, and what the card shows. */
  const resetResult = (
    setting: ResettableSetting,
    environment: ChangedEnvironment,
    change: AgentChange,
    text: string,
    approved: boolean,
  ) =>
    log
      .record({
        tool: "environment_setting_reset",
        environmentName: environment.name,
        field: setting,
      })
      .pipe(
        Effect.as({
          output: [{ type: "text" as const, text }],
          details: approved
            ? {
                approval: { approved: true },
                agentChange: agentChangeOf(setting, environment, change),
              }
            : { agentChange: agentChangeOf(setting, environment, change) },
        }),
      );

  /** The reset of a field the Environment does not override: nothing to do. */
  const inheritedAlready = (
    setting: ResettableSetting,
    environment: ChangedEnvironment,
    value: Schema.Json | null,
  ) => ({
    output: [
      {
        type: "text" as const,
        text: `The ${SETTING_WORDS[setting]} of ${named(environment)} is inherited from Global already (${valueWords(setting, value)}): nothing changed, and nothing was recorded.`,
      },
    ],
    details: { unchanged: { environment, field: setting } },
  });

  /** Make the reset of `setting` in `environment`, approved or not, and say how it went. */
  const reset = ({
    environment,
    own,
    setting,
    reason,
    api,
    expected,
  }: {
    readonly environment: string;
    readonly own: boolean;
    readonly setting: ResettableSetting;
    readonly reason: string;
    readonly api: ApprovalCall;
    /** For an approved reset: the value in force the owner saw. */
    readonly expected?: { readonly value: Schema.Json | null } | undefined;
  }) =>
    Effect.gen(function* () {
      const approved = expected !== undefined;

      const applied = yield* environments.change({
        environment,
        change: { field: setting, value: null },
        expected,
        author: {
          conversation: api.conversationId,
          tool: "environment_setting_reset",
          reason,
          approved: approved ? true : undefined,
        },
      });

      const prefix = approved ? "The user approved, but nothing was saved" : "Nothing was saved";

      switch (applied.status) {
        case "missing":
          return yield* notFound(environment);
        case "rejected":
          return yield* EnvironmentsError.make({ message: `${prefix}: ${applied.message}` });
        case "changed-since":
          return yield* EnvironmentsError.make({
            message: `${prefix}: the ${SETTING_WORDS[setting]} changed since the user was asked, to ${valueWords(setting, applied.current)}. Ask again if the reset is still needed.`,
          });
        case "unchanged":
          return approved
            ? {
                output: [
                  {
                    type: "text" as const,
                    text: approvedAlready(
                      `the ${SETTING_WORDS[setting]} of ${named(applied.environment)} is inherited from Global`,
                    ),
                  },
                ],
                details: { approval: { approved: true } },
              }
            : inheritedAlready(setting, applied.environment, applied.value);
        case "changed":
          return yield* resetResult(
            setting,
            applied.environment,
            applied.change,
            `${approved ? "The user approved: r" : "R"}eset the ${SETTING_WORDS[setting]} of ${named(applied.environment)}: it was ${valueWords(setting, applied.change.before)} (its own), and inherits Global's ${valueWords(setting, applied.change.after)} now, and each change of it at Global. ${describeApplied(own, applied.newBuild)} The change is recorded${approved ? " as approved" : ""} with your reason; the user can revert it on the Environments page.`,
            approved,
          );
      }
    });

  /** The reset of the size limit, which waits for the owner's Approval. */
  const resetLimit = (
    details: EnvironmentDetails,
    own: boolean,
    reason: string,
    api: ApprovalCall,
  ) =>
    Effect.gen(function* () {
      const where = named(details);
      const { instance, maxInstance } = details.settings;
      const inherited = details.global.maxInstance;

      if (details.overrides.maxInstance === undefined && !(yield* askedBefore(approvals, api))) {
        return inheritedAlready("maxInstance", details, maxInstance);
      }

      if (compareInstances(instance, inherited) > 0) {
        return yield* EnvironmentsError.make({
          message: `Nothing was asked or saved: the size limit at Global, ${inherited}, is below the size of ${where}, ${instance}, and the limit cannot be below the size. Lower the size first with environment_container_resize.`,
        });
      }

      const change = "Size limit (reset to Global's)";

      return yield* withApproval(
        approvals,
        api,
        {
          tool: "environment_setting_reset",
          target: `Environment ${JSON.stringify(details.name)}`,
          change,
          before: `${sizeWords(maxInstance)}, its own`,
          after: `${sizeWords(inherited)}, inherited from Global`,
          reason,
          expected: maxInstance,
        },
        (answer) =>
          answer.approved
            ? reset({
                environment: details.id,
                own,
                setting: "maxInstance",
                reason,
                api,
                expected: { value: answer.expected },
              })
            : Effect.succeed(
                declined(
                  answer,
                  `the reset of the size limit of ${where} from ${maxInstance} to Global's ${inherited}`,
                ),
              ),
      );
    });

  return defineEffectTool({
    name: "environment_setting_reset",
    description: Arr.join(
      [
        "Reset one of an Environment's Container settings (this Session's unless id names another): take its own value (its Override) back, so the setting inherits the value at Global again, and each later change of it at Global. environment_get shows which settings are the Environment's own (overridden here) and which are inherited from Global.",
        `The setting is one of ${Arr.join(RESETTABLE_SETTINGS, ", ")}. A variable of its own is taken back with environment_variable_unset, after which a variable at Global of the same name applies again.`,
        "A reset is refused as the user's save would refuse it, such as a size that would be above the size limit. Resetting the size limit (maxInstance) changes a Limit, so the user must approve it: the call waits for their answer on a card in the Session; on Decline nothing changes.",
        "The change is recorded with your reason, and the user can see and revert it on the Environments page. It applies at each Workspace's next Container start; for this Session's own Environment, container_restart applies it now.",
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: Schema.optionalKey(
        Schema.String.annotate({
          description:
            "The Environment's id, as environment_list shows it (default: this Session's Environment); not \"*\": Global's settings are not reset here",
        }),
      ),
      setting: Schema.Literals(RESETTABLE_SETTINGS).annotate({
        description: "The Container setting that inherits Global's value again",
      }),
      reason: Reason,
    }),
    executionMode: "sequential",
    // A rerun after an eviction finds the field inherited already and records nothing; the size limit's waits for the
    // same Approval request.
    replay: "safe",
    execute: ({ id, setting, reason }, api) =>
      Effect.gen(function* () {
        yield* refuseSecrets([{ what: "the reason", text: reason }]);

        const { environment, own } = yield* target(id);

        if (setting !== "maxInstance") {
          return yield* reset({ environment, own, setting, reason, api });
        }

        const details = yield* environments.get(environment);

        if (details === null) return yield* notFound(environment);

        return yield* resetLimit(details, own, reason, api);
      }),
  });
};
