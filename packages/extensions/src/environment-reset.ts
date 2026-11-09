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
import { compareInstances } from "@cloudpid/config";
import { defineEffectTool } from "@cloudpid/effect-durable";
import type { AgentChange } from "@cloudpid/protocol";
import {
  EnvironmentChangeEndpointOutput,
  HARNESS_TOOLS,
  RESET_LIMIT_SETTING,
  RESETTABLE_SETTINGS,
  type ResettableSetting,
  type Surface,
} from "@cloudpid/protocol/harness-tools";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type { ApprovalCore } from "./approval-cores.ts";
import {
  approvedChange,
  type ApprovalsService,
  approvedAlready,
  declinedAnswer,
} from "./approvals.ts";
import {
  type ChangedEnvironment,
  describeApplied,
  type EnvironmentDetails,
  type EnvironmentsService,
  pathsLine,
  plainValue,
  recordContainerSettingChange,
  type ContainerSettingResult,
  sizeWords,
  storedText,
  textSize,
} from "./environment.ts";
import { environmentTarget, holdsRefusal } from "./environment-change-parts.ts";
import {
  authorOf,
  endpointChangeOutput,
  endpointText,
  type TextCheck,
} from "./environment-changes.ts";
import { EnvironmentsError, notFound } from "./environment-describe.ts";
import type { LifecycleDeps } from "./environment-lifecycle.ts";
import { changeOutput, declinedOutput, unchangedOutput } from "./environment-outputs.ts";
import { asJsonValue, named } from "./environment-skill-results.ts";
import {
  type HarnessAnswer,
  type HarnessWrite,
  INVALID_ARGUMENT,
  loggedOf,
  toolResult,
  UNSUPPORTED,
} from "./harness.ts";
import { APPROVED, asOutput, EnvironmentChangeOutput, outputSchema } from "./outputs.ts";

// The settings that can be reset are the shared declaration's (`@cloudpid/protocol/harness-tools`), since the endpoint
// declares the same tool; they are re-exported here, where the tool has always imported them from.
export { RESETTABLE_SETTINGS, type ResettableSetting };

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

/**
 * What `resetCore` answers (`unsupported`) to the reset of the size limit, which it never makes: on the endpoint the
 * dispatcher asks the owner for it before the core runs (`apps/server/src/harness/approval-ask.ts`).
 */
export const RESET_LIMIT_UNSUPPORTED = `Nothing was changed: resetting the size limit (${RESET_LIMIT_SETTING}) waits for the owner's Approval and is not made here.`;

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
  surface: Surface,
): HarnessAnswer => {
  const text = `The ${SETTING_WORDS[setting]} of ${named(environment)} is inherited from Global already (${valueWords(setting, value)}): nothing changed, and nothing was recorded.`;

  return {
    text: surface === "session" ? text : endpointText(text),
    structured:
      surface === "session"
        ? asOutput(EnvironmentChangeOutput, unchangedOutput(environment, setting))
        : asOutput(
            EnvironmentChangeEndpointOutput,
            endpointChangeOutput({ environment, unchanged: [setting] }),
          ),
    details: { unchanged: { environment, field: setting } },
  };
};

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
  surface,
}: {
  readonly environment: string;
  readonly setting: ResettableSetting;
  readonly result: ContainerSettingResult;
  readonly own: boolean;
  readonly approved: boolean;
  /** Whose words the answer is in: the endpoint's names the owner and refuses with a code (never approved). */
  readonly surface: Surface;
}): Effect.Effect<HarnessAnswer, EnvironmentsError> => {
  const prefix = approved ? "The user approved, but nothing was saved" : "Nothing was saved";

  const refusal = (message: string) =>
    Effect.fail(
      EnvironmentsError.make(
        surface === "session" ? { message } : { message, code: INVALID_ARGUMENT },
      ),
    );

  switch (result.status) {
    case "missing":
      return Effect.fail(notFound(environment));
    case "rejected":
      return refusal(`${prefix}: ${result.message}`);
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
          : inheritedAlready(setting, result.environment, result.value, surface),
      );
    case "changed": {
      const text = `${approved ? "The user approved: r" : "R"}eset the ${SETTING_WORDS[setting]} of ${named(result.environment)}: it was ${valueWords(setting, result.change.before)} (its own), and inherits Global's ${valueWords(setting, result.change.after)} now, and each change of it at Global. ${describeApplied(own, result.newBuild, surface)} The change is recorded${approved ? " as approved" : ""} with your reason; the ${surface === "session" ? "user" : "owner"} can revert it on the Environments page.`;

      return Effect.succeed({
        text: surface === "session" ? text : endpointText(text),
        structured:
          surface === "session"
            ? asOutput(
                EnvironmentChangeOutput,
                changeOutput(result, own, approved ? APPROVED : null),
              )
            : asOutput(
                EnvironmentChangeEndpointOutput,
                endpointChangeOutput({
                  environment: result.environment,
                  change: result.change,
                  newBuild: result.newBuild === true,
                }),
              ),
        details: approved
          ? {
              approval: { approved: true },
              agentChange: agentChangeOf(setting, result.environment, result.change),
            }
          : { agentChange: agentChangeOf(setting, result.environment, result.change) },
      });
    }
  }
};

/** What the core of the reset of a setting that waits for no Approval reads and writes. */
export type ResetCoreServices = {
  readonly environments: Pick<EnvironmentsService, "current" | "change">;
  readonly holdsSecret: TextCheck;
};

/** The arguments of `environment_setting_reset`, as a Session's call decodes them (the endpoint's add `request_id`). */
export type ResetArgs = (typeof HARNESS_TOOLS.environment_setting_reset.session.input)["Type"];

/**
 * The core of `environment_setting_reset` for every setting but the size limit (`maxInstance`, the one that waits for the
 * owner's Approval: `resetLimitCore`): the Environment takes Global's value again, as the owner's reset does, and the
 * change is recorded with the Agent change whose value after is inherited. Both surfaces make the one `Environments` call
 * the Session's tool has always made; the endpoint's words name the owner and its refusals carry codes.
 */
export const resetCore =
  ({ environments, holdsSecret }: ResetCoreServices): HarnessWrite<ResetArgs, EnvironmentsError> =>
  ({ id, setting, reason }, surface, conversation) =>
    Effect.gen(function* () {
      if (setting === RESET_LIMIT_SETTING) {
        // The dispatcher asks the owner for this reset before the core: a call that reaches it changes nothing.
        return yield* EnvironmentsError.make({
          message: RESET_LIMIT_UNSUPPORTED,
          code: UNSUPPORTED,
        });
      }

      if (yield* holdsSecret(reason)) {
        return yield* holdsRefusal(surface, "Nothing was saved", "the reason");
      }

      const { environment, own } = yield* environmentTarget(environments, surface)(id);

      const result = yield* environments.change({
        environment,
        change: { field: setting, value: null },
        expected: undefined,
        author: { ...authorOf(RESET_TOOL, reason, conversation), approved: undefined },
      });

      const answer = yield* resetAnswer({
        environment,
        setting,
        result,
        own,
        approved: false,
        surface,
      });

      return {
        ...answer,
        logged:
          result.status === "changed"
            ? { tool: RESET_TOOL, environmentName: result.environment.name, field: setting }
            : undefined,
      };
    });

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
  ContainerSettingResult,
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
    tool: RESET_TOOL,
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
          return {
            ...prepared,
            unchanged: inheritedAlready("maxInstance", details, maxInstance, "session"),
          };
        }

        if (compareInstances(instance, inherited) > 0) {
          return yield* EnvironmentsError.make({
            message: `Nothing was asked or saved: the size limit at Global, ${inherited}, is below the size of ${where}, ${instance}, and the limit cannot be below the size. Lower the size first with environment_container_resize.`,
          });
        }

        return prepared;
      }),

    apply: ({ id }, expected, author, known) =>
      Effect.gen(function* () {
        const found = known ?? (yield* read(id));

        const result = yield* environments.change({
          environment: id,
          change: { field: "maxInstance", value: null },
          expected: { value: expected },
          author: { ...author, approved: true },
        });

        return { known: found, result };
      }),

    render: ({ id }, _expected, { known, result }) =>
      resetAnswer({
        environment: id,
        setting: "maxInstance",
        result,
        own: known.own,
        approved: true,
        surface: "session",
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
export const resetTool = (
  { environments, approvals, log, refuseSecrets, target }: ResetDeps,
  core: HarnessWrite<ResetArgs, EnvironmentsError>,
) => {
  const limit = resetLimitCore({ environments, refuseSecrets, target });

  return defineEffectTool({
    name: HARNESS_TOOLS.environment_setting_reset.name,
    description: HARNESS_TOOLS.environment_setting_reset.session.description,
    parameters: HARNESS_TOOLS.environment_setting_reset.session.input,
    structuredOutputSchema: outputSchema(HARNESS_TOOLS.environment_setting_reset.session.output),
    executionMode: "sequential",
    // A rerun after an eviction finds the field inherited already and records nothing; the size limit's waits for the
    // same Approval request.
    replay: "safe",
    execute: ({ id, setting, reason }, api) =>
      Effect.gen(function* () {
        if (setting === RESET_LIMIT_SETTING) {
          return yield* approvedChange(
            approvals,
            api,
            limit,
            { id, reason },
            recordContainerSettingChange(log, RESET_TOOL, "maxInstance"),
          );
        }

        const answer = yield* core({ id, setting, reason }, "session", api.conversationId);

        yield* Effect.forEach(loggedOf(answer.logged), log.record, { discard: true });

        return toolResult(answer);
      }),
  });
};
