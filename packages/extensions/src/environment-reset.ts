// The `environment` extension's `environment_setting_reset` (`docs/architecture/agent-changes.md` → Container
// settings, one tool each, and → Approval; ADR-0027): the agent takes an Environment's Override of one Container setting
// back, so the field inherits the value at Global again. The reset is applied as the owner's reset is
// (`changeEnvironment` with no value) and recorded as an Agent change whose value after is inherited. A reset of the
// size limit may raise or lower the largest size the Environment allows, so it is a Limit: it waits for the owner's
// Approval (`./approvals.ts`), as `environment_container_size_limit_set` does. Global's own settings are not reset here:
// Global inherits nothing, and its value is changed with the setting's own tool at `*`. Its `structuredOutput`
// (`docs/architecture/agent-capabilities.md` → Values for programs; `environment-outputs.ts`) is the outcome of the
// change (`EnvironmentChangeOutput`), with the owner's answer for a reset of the size limit, approved or declined with
// their reason.
// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off
import {
  compareInstances,
  CONTAINER_SETTING_NAMES,
  type ContainerSettings,
} from "@cloudpid/config";
import { defineEffectTool } from "@cloudpid/effect-durable";
import type { AgentChange } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ApprovalCore } from "./approval-cores.ts";
import {
  type ApprovalCall,
  approvedChange,
  type ApprovalsService,
  approvedAlready,
  declinedAnswer,
  storedText,
} from "./approvals.ts";
import {
  type AppliedChange,
  type ChangedEnvironment,
  type ChangedSetting,
  describeApplied,
  type EnvironmentDetails,
  EnvironmentsError,
  type EnvironmentsService,
  IdNotGlobal,
  MAX_CHANGE_REASON,
  pathsLine,
  plainValue,
  sizeWords,
  textSize,
} from "./environment.ts";
import { notFound } from "./environment-describe.ts";
import type { LifecycleDeps } from "./environment-lifecycle.ts";
import { changeOutput, declinedOutput, unchangedOutput } from "./environment-outputs.ts";
import { asJsonValue, named } from "./environment-skill-results.ts";
import { type HarnessAnswer, toolResult } from "./harness.ts";
import { APPROVED, asOutput, EnvironmentChangeOutput, outputSchema } from "./outputs.ts";

/** A Container setting an Environment may override and reset, but its variables (`environment_variable_unset`). */
export type ResettableSetting = Exclude<keyof ContainerSettings, "variables">;

/** The Container settings an Environment may override and reset. */
export const RESETTABLE_SETTINGS: ReadonlyArray<ResettableSetting> = Arr.filter(
  CONTAINER_SETTING_NAMES,
  (name): name is ResettableSetting => name !== "variables",
);

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
    case "toolchains":
      return textSize(value);
    case "ignore":
      return pathsLine(value);
    case "spareWorkspace":
      return value === true ? "on" : "off";
    case "idleMinutes":
      return `${plainValue(value)} minutes`;
    case "instance":
    case "maxInstance":
      return plainValue(value);
  }
};

/** The tool's name, which its cards and the changes it makes carry. */
const RESET_TOOL = "environment_setting_reset";

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

/** The reset of a field the Environment does not override: nothing to do. */
const inheritedAlready = (
  setting: ResettableSetting,
  environment: ChangedEnvironment,
  value: Schema.Json | null,
): HarnessAnswer => ({
  text: `The ${SETTING_WORDS[setting]} of ${named(environment)} is inherited from Global already (${valueWords(setting, value)}): nothing changed, and nothing was recorded.`,
  structured: asOutput(EnvironmentChangeOutput, unchangedOutput(environment, setting)),
  details: { unchanged: { environment, field: setting } },
});

/**
 * What a reset of `setting` in `environment` answers once the Registry has answered the write, `approved` by the owner or
 * not: a reset made, or found made already, or the refusal of one that was not (nothing was saved). `result` is the write's
 * own answer, or one built from the Agent change it recorded (whose `newBuild`, the upkeep's, is then unknown).
 */
const resetAnswer = ({
  environment,
  setting,
  result,
  own,
  approved,
}: {
  readonly environment: string;
  readonly setting: ResettableSetting;
  readonly result: ResetResult;
  readonly own: boolean;
  readonly approved: boolean;
}): Effect.Effect<HarnessAnswer, EnvironmentsError> => {
  const prefix = approved ? "The user approved, but nothing was saved" : "Nothing was saved";

  switch (result.status) {
    case "missing":
      return Effect.fail(notFound(environment));
    case "rejected":
      return Effect.fail(EnvironmentsError.make({ message: `${prefix}: ${result.message}` }));
    case "changed-since":
      return Effect.fail(
        EnvironmentsError.make({
          message: `${prefix}: the ${SETTING_WORDS[setting]} changed since the user was asked, to ${valueWords(setting, result.current)}. Ask again if the reset is still needed.`,
        }),
      );
    case "unchanged":
      return Effect.succeed(
        approved
          ? {
              text: approvedAlready(
                `the ${SETTING_WORDS[setting]} of ${named(result.environment)} is inherited from Global`,
              ),
              structured: asOutput(
                EnvironmentChangeOutput,
                unchangedOutput(result.environment, setting, APPROVED),
              ),
              details: { approval: { approved: true } },
            }
          : inheritedAlready(setting, result.environment, result.value),
      );
    case "changed":
      return Effect.succeed({
        text: `${approved ? "The user approved: r" : "R"}eset the ${SETTING_WORDS[setting]} of ${named(result.environment)}: it was ${valueWords(setting, result.change.before)} (its own), and inherits Global's ${valueWords(setting, result.change.after)} now, and each change of it at Global. ${describeApplied(own, result.newBuild)} The change is recorded${approved ? " as approved" : ""} with your reason; the user can revert it on the Environments page.`,
        structured: asOutput(
          EnvironmentChangeOutput,
          changeOutput(result, own, approved ? APPROVED : null),
        ),
        details: approved
          ? {
              approval: { approved: true },
              agentChange: agentChangeOf(setting, result.environment, result.change),
            }
          : { agentChange: agentChangeOf(setting, result.environment, result.change) },
      });
  }
};

/** How the write of a reset went: the Registry's answer, or one built from the Agent change it recorded. */
export type ResetResult = Exclude<AppliedChange, { readonly status: "changed" }> | ChangedSetting;

/** What the core of the reset of the size limit reads and writes. */
export type ResetLimitServices = Pick<LifecycleDeps, "refuseSecrets" | "target"> & {
  readonly environments: Pick<EnvironmentsService, "get" | "change">;
};

/** The arguments of the reset of the size limit: `environment_setting_reset` with the setting `maxInstance`. */
export type ResetLimitArgs = { readonly id: string; readonly reason: string };

/** What `prepare` read of the reset's target: the Environment, and whether it is the Session's own (never, with no Session). */
export type ResetLimitKnown = { readonly details: EnvironmentDetails; readonly own: boolean };

/**
 * The core of the reset of the size limit (`maxInstance`), the one setting of `environment_setting_reset` that waits for the
 * owner's Approval (`./approval-cores.ts` describes `prepare`, `apply` and `render`): the Environment takes Global's limit
 * again, which may raise or lower the largest size it allows.
 */
export const resetLimitCore = ({
  environments,
  refuseSecrets,
  target,
}: ResetLimitServices): ApprovalCore<
  ResetLimitArgs,
  ResetLimitKnown,
  ResetResult,
  undefined,
  EnvironmentsError
> => {
  /** The Environment `id` names, found, and whether it is the Session's own. */
  const read = (id: string) =>
    Effect.gen(function* () {
      const { environment, own } = yield* target(id);
      const details = yield* environments.get(environment);

      if (details === null) return yield* notFound(environment);

      return { details, own };
    });

  return {
    prepare: ({ id, reason }) =>
      Effect.gen(function* () {
        yield* refuseSecrets([{ what: "the reason", text: reason }]);

        const known = yield* read(id);
        const { details } = known;
        const where = named(details);
        const { instance, maxInstance } = details.settings;
        const inherited = details.global.maxInstance;

        const prepared = {
          card: {
            tool: RESET_TOOL,
            target: `Environment ${JSON.stringify(details.name)}`,
            change: "Size limit (reset to Global's)",
            before: `${sizeWords(maxInstance)}, its own`,
            after: `${sizeWords(inherited)}, inherited from Global`,
            reason,
          },
          expected: maxInstance,
          known,
        };

        if (details.overrides.maxInstance === undefined) {
          return { ...prepared, unchanged: inheritedAlready("maxInstance", details, maxInstance) };
        }

        if (compareInstances(instance, inherited) > 0) {
          return yield* EnvironmentsError.make({
            message: `Nothing was asked or saved: the size limit at Global, ${inherited}, is below the size of ${where}, ${instance}, and the limit cannot be below the size. Lower the size first with environment_container_resize.`,
          });
        }

        return prepared;
      }),

    apply: ({ id }, expected, author, given) =>
      Effect.gen(function* () {
        const known = given ?? (yield* read(id));

        const result = yield* environments.change({
          environment: id,
          change: { field: "maxInstance", value: null },
          expected: { value: expected },
          author: { ...author, approved: true },
        });

        return { known, result };
      }),

    render: ({ id }, _expected, { known, result }) =>
      resetAnswer({
        environment: id,
        setting: "maxInstance",
        result,
        own: known.own,
        approved: true,
      }),

    declined: (_args, { details }, answer) =>
      declinedAnswer(
        answer,
        `the reset of the size limit of ${named(details)} from ${storedText(answer.expected)} to Global's ${details.global.maxInstance}`,
        (approval) => asOutput(EnvironmentChangeOutput, declinedOutput(details, approval)),
      ),
  };
};

/** The Session's Approvals, which a reset of the size limit asks. */
export type ResetDeps = LifecycleDeps & { readonly approvals: ApprovalsService };

/** `environment_setting_reset`, over the Session's `Environments`. */
export const resetTool = ({ environments, approvals, log, refuseSecrets, target }: ResetDeps) => {
  // Built here, not at the module's top: `environment.ts` imports this file, so its exports are not there yet then.
  const Reason = Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_CHANGE_REASON),
  ).annotate({
    description:
      "Why you make the change, for the user to read in the Environment's Agent changes (and on the Approval card, for the size limit), such as 'the Global Setup Script now installs what this one did'",
  });

  const limit = resetLimitCore({ environments, refuseSecrets, target });

  /** Reset `setting` in `environment` at once, with no Approval, and say how it went. */
  const reset = ({
    environment,
    own,
    setting,
    reason,
    api,
  }: {
    readonly environment: string;
    readonly own: boolean;
    readonly setting: ResettableSetting;
    readonly reason: string;
    readonly api: ApprovalCall;
  }) =>
    Effect.gen(function* () {
      const result = yield* environments.change({
        environment,
        change: { field: setting, value: null },
        expected: undefined,
        author: {
          conversation: api.conversationId,
          tool: RESET_TOOL,
          reason,
          approved: undefined,
        },
      });

      if (result.status === "changed") {
        yield* log.record({
          tool: RESET_TOOL,
          environmentName: result.environment.name,
          field: setting,
        });
      }

      return toolResult(yield* resetAnswer({ environment, setting, result, own, approved: false }));
    });

  return defineEffectTool({
    name: RESET_TOOL,
    description: Arr.join(
      [
        "Reset one of an Environment's Container settings (the one id names): take its own value (its Override) back, so the setting inherits the value at Global again, and each later change of it at Global. environment_get shows which settings are the Environment's own (overridden here) and which are inherited from Global.",
        `The setting is one of ${Arr.join(RESETTABLE_SETTINGS, ", ")}. A variable of its own is taken back with environment_variable_unset, after which a variable at Global of the same name applies again.`,
        "A reset is refused as the user's save would refuse it, such as a size that would be above the size limit. Resetting the size limit (maxInstance) changes a Limit, so the user must approve it: the call waits for their answer on a card in the Session; on Decline nothing changes.",
        "The change is recorded with your reason, and the user can see and revert it on the Environments page. It applies at each Workspace's next Container start; for this Session's own Environment, container_restart applies it now.",
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: IdNotGlobal,
      setting: Schema.Literals(RESETTABLE_SETTINGS).annotate({
        description: "The Container setting that inherits Global's value again",
      }),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(EnvironmentChangeOutput),
    executionMode: "sequential",
    // A rerun after an eviction finds the field inherited already and records nothing; the size limit's waits for the
    // same Approval request.
    replay: "safe",
    execute: ({ id, setting, reason }, api) =>
      Effect.gen(function* () {
        if (setting === "maxInstance") {
          return yield* approvedChange(approvals, api, limit, { id, reason }, (applied) =>
            applied.result.status === "changed"
              ? log
                  .record({
                    tool: RESET_TOOL,
                    environmentName: applied.result.environment.name,
                    field: "maxInstance",
                  })
                  .pipe(Effect.as(undefined))
              : Effect.undefined,
          );
        }

        yield* refuseSecrets([{ what: "the reason", text: reason }]);

        const { environment, own } = yield* target(id);

        return yield* reset({ environment, own, setting, reason, api });
      }),
  });
};
