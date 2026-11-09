// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off
// The core of `environment_container_size_limit_set` (`docs/architecture/mcp-endpoint.md` → Environment and Settings
// tools → Approvals with no Session; #685 L2): `prepare`, `apply` and `render` over the Registry's Environments, as
// `./approval-cores.ts` describes them. The size limit is a Limit, so the change waits for the owner's Approval. The card
// shows the limit as it is now and after, and the change is made only while the limit is still as the owner saw it. Its
// words are a Session's, or on the endpoint (`surface`) the owner's, naming only the tools the endpoint serves.
import { compareInstances, InstanceType } from "@cloudpid/config";
import { GLOBAL_ID, GLOBAL_NAME, type Surface, whoWords } from "@cloudpid/protocol/harness-tools";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ApprovalCore, PlainText } from "./approval-cores.ts";
import { approvedAlready, changedSince, declinedAnswer } from "./approvals.ts";
import {
  type ChangedEnvironment,
  describeLimitReach,
  type EnvironmentsService,
  type ContainerSettingResult,
  sizeWords,
  storedText,
} from "./environment.ts";
import { EnvironmentsError, notFound } from "./environment-describe.ts";
import { changeOutput, declinedOutput, unchangedOutput } from "./environment-outputs.ts";
import { asJsonValue, named } from "./environment-skill-results.ts";
import { APPROVED, asOutput, EnvironmentChangeOutput } from "./outputs.ts";

/** The tool's name, which its cards and the changes it makes carry. */
export const SIZE_LIMIT_TOOL = "environment_container_size_limit_set";

/**
 * What the core reads and writes: the Registry's Environments, and the check of the reason; and whose words it answers in
 * (`surface`, a Session's when absent).
 */
export type SizeLimitServices = {
  readonly environments: Pick<
    EnvironmentsService,
    "current" | "list" | "get" | "global" | "change"
  >;
  readonly plainText: PlainText;
  readonly surface?: Surface;
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

const isInstanceType = Schema.is(InstanceType);

/** A stored size limit as the owner reads it. */
const storedSizeWords = (stored: Schema.Json | null): string =>
  isInstanceType(stored) ? sizeWords(stored) : JSON.stringify(stored);

/** The core of `environment_container_size_limit_set`. */
export const sizeLimitCore = ({
  environments,
  plainText,
  surface = "session",
}: SizeLimitServices): ApprovalCore<
  SizeLimitArgs,
  SizeLimitKnown,
  ContainerSettingResult,
  EnvironmentsError
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
    tool: SIZE_LIMIT_TOOL,
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

    apply: ({ id, size }, expected, author, known) =>
      Effect.gen(function* () {
        const found = known ?? (yield* read(id)).known;

        const result = yield* environments.change({
          environment: id,
          change: { field: "maxInstance", value: size },
          expected: { value: expected },
          author: { ...author, approved: true },
        });

        return { known: found, result };
      }),

    render: ({ id, size }, expected, { known, result }) => {
      const details = known.environment;
      const where = named(details);
      const who = whoWords(surface);

      // The endpoint serves no Session's `container_resize`.
      const resizers =
        surface === "session"
          ? "environment_container_resize and container_resize may"
          : "environment_container_resize may";

      switch (result.status) {
        case "missing":
          return Effect.fail(notFound(id));
        case "rejected":
          return Effect.fail(
            EnvironmentsError.make({
              message: `The ${who} approved, but nothing was saved: ${result.message}`,
            }),
          );
        case "changed-since":
          return Effect.fail(
            EnvironmentsError.make({
              message: changedSince(
                `the size limit of ${where}`,
                storedSizeWords(result.current),
                surface,
              ),
            }),
          );
        case "unchanged":
          return Effect.succeed({
            text: approvedAlready(`the size limit of ${where} is ${size}`, surface),
            structured: asOutput(
              EnvironmentChangeOutput,
              unchangedOutput(details, "maxInstance", APPROVED),
            ),
            details: { approval: { approved: true } },
          });
        case "changed":
          return Effect.succeed({
            text: `The ${who} approved: the size limit of ${named(result.environment)} was ${storedText(expected)}, and is ${size} now. ${resizers} now use sizes up to ${size}. ${describeLimitReach(result, known.own, surface)} The change is recorded as approved, with your reason; the ${who} can revert it on the ${surface === "session" ? "Environments" : "Settings"} page.`,
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
