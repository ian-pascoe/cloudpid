// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off
// The core of `environment_container_size_limit_set` (`docs/architecture/mcp-endpoint.md` → Environment and Settings
// tools → Approvals with no Session; #685 L2): `prepare`, `apply` and `render` over the Registry's Environments, as
// `./approval-cores.ts` describes them. The size limit is a Limit, so the change waits for the owner's Approval. The card
// shows the limit as it is now and after, and the change is made only while the limit is still as the owner saw it.
import { compareInstances, InstanceType } from "@cloudpid/config";
import { GLOBAL_ID, GLOBAL_NAME } from "@cloudpid/protocol/harness-tools";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ApprovalCore, PlainText } from "./approval-cores.ts";
import { approvedAlready, changedSince, declinedAnswer, storedText } from "./approvals.ts";
import {
  type AppliedChange,
  type ChangedEnvironment,
  type ChangedSetting,
  describeApplied,
  describeAppliedGlobal,
  type EnvironmentsService,
  sizeWords,
} from "./environment.ts";
import { EnvironmentsError, notFound } from "./environment-describe.ts";
import { changeOutput, declinedOutput, unchangedOutput } from "./environment-outputs.ts";
import { asJsonValue, named } from "./environment-skill-results.ts";
import { APPROVED, asOutput, EnvironmentChangeOutput } from "./outputs.ts";

/** The tool's name, which its cards and the changes it makes carry. */
export const SIZE_LIMIT_TOOL = "environment_container_size_limit_set";

/** What the core reads and writes: the Registry's Environments, and the check of the reason. */
export type SizeLimitServices = {
  readonly environments: Pick<
    EnvironmentsService,
    "current" | "list" | "get" | "global" | "change"
  >;
  readonly plainText: PlainText;
};

/** The arguments of `environment_container_size_limit_set`. */
export type SizeLimitArgs = {
  readonly id: string;
  readonly size: InstanceType;
  readonly reason: string;
};

/**
 * What `prepare` read of the target: the Environment (or Global) the limit is of, and whether it is the Session's own
 * (never, where there is no Session).
 */
export type SizeLimitKnown = {
  readonly environment: ChangedEnvironment;
  readonly own: boolean;
};

/**
 * How the write went: the Registry's own answer, or, for an Applied built from the Agent change it recorded, the same
 * with `newBuild` unknown (it is the upkeep's, not the record's), which the text then leaves to `environment_get`.
 */
export type SizeLimitResult =
  | Exclude<AppliedChange, { readonly status: "changed" }>
  | ChangedSetting;

type SizeLimitFailure = EnvironmentsError;

const isInstanceType = Schema.is(InstanceType);

/** A stored size limit as the owner reads it. */
const storedSizeWords = (stored: Schema.Json | null): string =>
  isInstanceType(stored) ? sizeWords(stored) : JSON.stringify(stored);

/** The core of `environment_container_size_limit_set`. */
export const sizeLimitCore = ({
  environments,
  plainText,
}: SizeLimitServices): ApprovalCore<
  SizeLimitArgs,
  SizeLimitKnown,
  SizeLimitResult,
  undefined,
  SizeLimitFailure
> => {
  /**
   * The target of the limit: Global, or the Environment `id`, found. With the size settings where the limit is set (an
   * Environment's in force, or Global's), the limit as it is kept there (an inherited limit set to the same size becomes
   * the Environment's own, so it is a change), and how the card names it.
   */
  const read = (id: string) =>
    Effect.gen(function* () {
      if (id === GLOBAL_ID) {
        const { settings } = yield* environments.global;

        return {
          known: { environment: { id: GLOBAL_ID, name: GLOBAL_NAME }, own: false },
          settings,
          kept: settings.maxInstance,
          card: GLOBAL_NAME,
        };
      }

      const own = id === (yield* environments.current);
      const details = yield* environments.get(id);

      if (details === null) return yield* notFound(id);

      return {
        known: { environment: { id: details.id, name: details.name }, own },
        settings: details.settings,
        kept: details.overrides.maxInstance,
        card: `Environment ${JSON.stringify(details.name)}`,
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

  return {
    prepare: ({ id, size, reason }) =>
      Effect.gen(function* () {
        yield* plainText(reason, "the reason", "Say why without it.");

        const { known, settings, kept, card } = yield* read(id);

        const where = named(known.environment);
        const { instance, maxInstance } = settings;

        if (compareInstances(size, instance) < 0) {
          return yield* EnvironmentsError.make({
            message: `Nothing was asked or saved: ${size} is below the size of ${where}, ${instance}, and the limit cannot be below the size. Lower the size first with environment_container_resize.`,
          });
        }

        const prepared = {
          card: {
            tool: SIZE_LIMIT_TOOL,
            target: card,
            change: "Size limit",
            before: sizeWords(maxInstance),
            after: sizeWords(size),
            reason,
          },
          expected: maxInstance,
          known,
        };

        if (size === kept) {
          return {
            ...prepared,
            unchanged: {
              text: `The size limit of ${where} is ${size} already: nothing was asked, changed or recorded.`,
              structured: asOutput(
                EnvironmentChangeOutput,
                unchangedOutput(known.environment, "maxInstance"),
              ),
              details: {
                unchanged: {
                  environment: { id: known.environment.id, name: known.environment.name },
                  field: "maxInstance",
                },
              },
            },
          };
        }

        const above = id === GLOBAL_ID ? yield* inheritingAbove(instance, size) : [];

        if (above.length > 0) {
          return yield* EnvironmentsError.make({
            message: `Nothing was asked or saved: ${size} is below the own size of ${Arr.join(above, ", ")}, which inherit${above.length === 1 ? "s" : ""} the size limit at Global, and the limit cannot be below the size. Give each its own limit with environment_container_size_limit_set, or lower its size first with environment_container_resize.`,
          });
        }

        return prepared;
      }),

    apply: ({ id, size }, expected, author, given) =>
      Effect.gen(function* () {
        const known = given ?? (yield* read(id)).known;

        const result = yield* environments.change({
          environment: id,
          change: { field: "maxInstance", value: size },
          expected: { value: expected },
          author: { ...author, approved: true },
        });

        return { known, result };
      }),

    render: ({ id, size }, expected, { known, result }) => {
      const details = known.environment;
      const where = named(details);

      switch (result.status) {
        case "missing":
          return Effect.fail(notFound(id));
        case "rejected":
          return Effect.fail(
            EnvironmentsError.make({
              message: `The user approved, but nothing was saved: ${result.message}`,
            }),
          );
        case "changed-since":
          return Effect.fail(
            EnvironmentsError.make({
              message: changedSince(`the size limit of ${where}`, storedSizeWords(result.current)),
            }),
          );
        case "unchanged":
          return Effect.succeed({
            text: approvedAlready(`the size limit of ${where} is ${size}`),
            structured: asOutput(
              EnvironmentChangeOutput,
              unchangedOutput(details, "maxInstance", APPROVED),
            ),
            details: { approval: { approved: true } },
          });
        case "changed":
          return Effect.succeed({
            text: `The user approved: the size limit of ${named(result.environment)} was ${storedText(expected)}, and is ${size} now. environment_container_resize and container_resize may now use sizes up to ${size}. ${describeReach(result, known.own)} The change is recorded as approved, with your reason; the user can revert it on the Environments page.`,
            structured: asOutput(
              EnvironmentChangeOutput,
              changeOutput(result, known.own, APPROVED),
            ),
            details: {
              approval: { approved: true },
              agentChange: {
                id: result.change.id,
                environment: result.environment,
                field: "maxInstance",
                before: asJsonValue(result.change.before),
                after: asJsonValue(result.change.after),
              },
            },
          });
      }
    },

    declined: ({ size }, known, answer) =>
      declinedAnswer(
        answer,
        `the size limit of ${named(known.environment)} from ${storedText(answer.expected)} to ${size}`,
        (approval) =>
          asOutput(EnvironmentChangeOutput, declinedOutput(known.environment, approval)),
      ),
  };
};

/**
 * What a change of the limit says of whom it reaches. A change from the Registry's write says it all; one built from the
 * recorded Agent change does not know the Builds the upkeep asked for, and says where to look.
 */
const describeReach = (result: ChangedSetting, own: boolean): string => {
  if (result.global !== undefined) return describeAppliedGlobal("maxInstance", result.global);

  if (result.environment.id === GLOBAL_ID) {
    return "It applies at the next Container start of every Workspace that inherits it: a Container that runs keeps what it started with. environment_get shows the Builds.";
  }

  return describeApplied(own, result.newBuild);
};
