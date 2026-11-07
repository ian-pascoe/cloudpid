// The `trigger_*` tools (`docs/architecture/triggers.md` → Agent tools and Approval, ADR-0019, ADR-0047): the agent
// lists and reads the Triggers, makes an Environment trigger, changes its message, Schedule or options, and pauses,
// resumes or removes one. Making a Trigger, changing what it sends or when (`trigger_create`, `trigger_message_set`,
// `trigger_schedule_set`, `trigger_options_set`) and `trigger_resume` wait for the owner's Approval (`withApproval`),
// since each makes cloudpid start Sessions unattended; `trigger_pause` and `trigger_remove` only narrow, so they apply at
// once. A Trigger's kind and Environment never change. There is no fire-now tool: the agent can't start Sessions at
// will. Each tool refuses without asking what it would refuse anyway (a Schedule without a zone, a 6-field one, `L`,
// `W` or `#`; a reason, name or message holding a Secret; a message longer than the card shows), then makes the change
// through the Session's `TriggerAccess`, which records it as an Agent change of the field `triggers.<id>` under the
// Trigger's Environment and wakes the Trigger's object. An approved change is made only while the Trigger is still as
// the owner saw it; `trigger_create` draws its Trigger's id before asking and keeps it in the request, so a rerun after
// an eviction makes no second one. The tools are the root conversation's only (`trigger_` is in
// `PARENT_ONLY_TOOL_PREFIXES`) and deferred, and give programs their outcome (`./trigger-outputs.ts`).
// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off
import { ModelId, ThinkingLevel } from "@cloudpid/config";
import { defineEffectTool } from "@cloudpid/effect-durable";
import {
  type AgentChange,
  type EnvironmentTriggerInput,
  fireTimeWords,
  nextFires,
  scheduleOf,
  scheduleProblem,
  type ScheduleSource,
  triggerChangeValue,
  TriggerChangeValue,
  type TriggerDefinition,
  triggerField,
  triggerMessageProblem,
  triggerNameProblem,
  type TriggerPatch,
} from "@cloudpid/protocol";
import type { JsonValue } from "@earendil-works/chord";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { plainTextCheck } from "./approval-tools.ts";
import {
  type ApprovalAnswer,
  type ApprovalCall,
  Approvals,
  approvedAlready,
  askedBefore,
  declinedWith,
  withApproval,
} from "./approvals.ts";
import {
  AgentChangeLog,
  type ChangeAuthor,
  type DeployCredentials,
  Environments,
  EnvironmentsError,
  environmentTarget,
  Id,
  MAX_CHANGE_REASON,
} from "./environment.ts";
import { APPROVED, asOutput, outputSchema } from "./outputs.ts";
import type { Secrets } from "./secrets/store.ts";
import {
  TriggerChangeOutput,
  triggerChangeOutput,
  TriggerListOutput,
  triggerListOutput,
  TriggerOutput,
  triggerOutput,
  triggerSummaryOutput,
} from "./trigger-outputs.ts";

export const extensionName = "triggers";

/** The prefix of the `trigger_*` tools, the root conversation's only. */
export const TRIGGER_TOOL_PREFIX = "trigger_";

/**
 * The longest Trigger message the agent writes, in characters: what an Approval card shows in full, so the owner
 * approves only what they can read. The owner's own form takes far more (`MAX_TRIGGER_MESSAGE_BYTES`).
 */
export const MAX_AGENT_TRIGGER_MESSAGE = 16_000;

/** How many of a Trigger's next Fires a result and a card show. */
const NEXT_FIRES = 3;

/** How an agent's change of a Trigger went, as the Registry answers it. */
export type TriggerChanged =
  | {
      readonly status: "changed";
      /** The Trigger after the change; null once removed. */
      readonly definition: TriggerDefinition | null;
      /** Its Environment, whose history records the change. */
      readonly environment: { readonly id: string; readonly name: string };
      readonly change: AgentChange;
    }
  /** It already was as asked: nothing was saved or recorded. */
  | { readonly status: "unchanged"; readonly definition: TriggerDefinition }
  /** It is no longer as the owner saw it (`current`; null once gone): nothing was saved. */
  | { readonly status: "changed-since"; readonly current: TriggerDefinition | null }
  /** Not allowed, said as the owner's form says it: nothing was saved. */
  | { readonly status: "invalid"; readonly problem: string }
  /** No such Trigger, or (for a new one) no such Environment. */
  | { readonly status: "missing" };

/**
 * What the Session does for the `trigger_*` tools, over the Registry and the Trigger objects: it reads the Triggers,
 * and makes each change as the Registry's Agent change of `triggers.<id>`, by `author` in this Session, then wakes the
 * Trigger's object (`Trigger.sync`).
 */
export type TriggerAccessService = {
  /** `environment`'s Triggers, or every one, newest first. */
  readonly list: (
    environment: string | undefined,
  ) => Effect.Effect<ReadonlyArray<TriggerDefinition>, EnvironmentsError>;
  /** Trigger `id`, or null when there is none. */
  readonly get: (id: string) => Effect.Effect<TriggerDefinition | null, EnvironmentsError>;
  /** A fresh Trigger id. */
  readonly newId: Effect.Effect<string>;
  readonly create: (input: {
    readonly id: string;
    readonly trigger: EnvironmentTriggerInput;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<TriggerChanged, EnvironmentsError>;
  /** Change Trigger `id`'s fields; with `expected`, only while it is as the owner saw it. */
  readonly update: (input: {
    readonly id: string;
    readonly patch: TriggerPatch;
    readonly expected?: TriggerChangeValue | undefined;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<TriggerChanged, EnvironmentsError>;
  /** Pause or resume Trigger `id`; with `expected`, only while it is as the owner saw it. */
  readonly setPaused: (input: {
    readonly id: string;
    readonly paused: boolean;
    readonly expected?: TriggerChangeValue | undefined;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<TriggerChanged, EnvironmentsError>;
  readonly remove: (input: {
    readonly id: string;
    readonly author: ChangeAuthor;
  }) => Effect.Effect<TriggerChanged, EnvironmentsError>;
};

export class TriggerAccess extends Context.Service<TriggerAccess, TriggerAccessService>()(
  "@cloudpid/extensions/triggers/TriggerAccess",
) {}

const TriggerId = Schema.String.check(Schema.isMinLength(1)).annotate({
  description: "The Trigger's id, as trigger_list gives it",
});

const Reason = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_CHANGE_REASON),
).annotate({
  description:
    "Why you make the change, shown to the user (on the Approval card, for a change that waits for it) and kept with the change, such as 'the user asked for a summary of the week's PRs every Monday'",
});

const Schedule = Schema.Struct({
  cron: Schema.String.annotate({
    description:
      "A 5-field cron expression (minute hour day-of-month month day-of-week; names such as MON and JAN, ranges, lists and steps), or @hourly, @daily or @weekly. 6- and 7-field forms and L, W and # are refused",
  }),
  zone: Schema.String.annotate({
    description:
      "The IANA time zone it is read in, such as America/Chicago or UTC: required, there is no default",
  }),
}).annotate({ description: "When the Trigger fires" });

const WhenBusy = Schema.Literals(["skip", "start"]).annotate({
  description:
    '"skip" (the default): a Fire while the last Fire\'s Session is still running or waiting for the user is skipped; "start": it starts a Session anyway',
});

const Base = Schema.String.check(Schema.isMinLength(1)).annotate({
  description:
    "The remote branch each Fire's Workspace starts from; default each Repo's default branch",
});

const Message = Schema.String.annotate({
  description: `The Trigger message: what each Fire's new Session is sent, after cloudpid's header (the Trigger's name, the scheduled and actual time). It runs unattended, so say everything the work needs. At most ${String(MAX_AGENT_TRIGGER_MESSAGE)} characters`,
});

const APPROVAL =
  "The user is asked for their Approval on a card in the Session (and a notification): the call waits for the answer, with no deadline. On Approve the change is made and recorded as approved; on Decline nothing changes, and the result carries their reason. If the user changes the Trigger meanwhile, the approval does not apply and you are told to ask again.";

const RECORDED =
  "The change is recorded as an Agent change of the Trigger's Environment, which the user can revert on the Environments page.";

/** A Schedule as the owner reads it. */
const scheduleWords = (schedule: ScheduleSource | undefined): string =>
  schedule === undefined
    ? "a source this version can't read"
    : `"${schedule.cron}" in ${schedule.zone}`;

/** The next Fires of `definition` after `now`: none while it is paused or has no Schedule. */
const nextOf = (definition: TriggerDefinition, now: number): ReadonlyArray<number> => {
  const schedule = scheduleOf(definition);

  return definition.paused || schedule === undefined ? [] : nextFires(schedule, now, NEXT_FIRES);
};

/** The next Fires of `schedule` after `now`, as a card's note says them. */
const nextFiresNote = (schedule: ScheduleSource, now: number): string =>
  `Next Fires: ${Arr.join(
    Arr.map(nextFires(schedule, now, NEXT_FIRES), (at) => fireTimeWords(at, schedule.zone)),
    "; ",
  )}`;

/** A Trigger's options as the owner reads them. */
const optionsWords = (options: {
  readonly whenBusy: string;
  readonly base?: string | undefined;
  readonly model?: string | undefined;
  readonly thinking?: string | undefined;
}): string =>
  Arr.join(
    [
      `when busy: ${options.whenBusy}`,
      `base: ${options.base ?? "each Repo's default branch"}`,
      `model: ${options.model ?? "the Environment's"}`,
      `thinking: ${options.thinking ?? "the Environment's"}`,
    ],
    ", ",
  );

/** A Trigger as a card and a result describe it in full. */
const triggerWords = (value: TriggerChangeValue): string =>
  Arr.join(
    [
      `Name: ${value.name}`,
      `Schedule: ${scheduleWords(scheduleOf(value))}`,
      `Options: ${optionsWords(value)}`,
      ...(value.paused ? ["Paused"] : []),
      `Message:\n${value.message}`,
    ],
    "\n",
  );

/** The Trigger the owner saw, as a change's request keeps it. */
// SAFETY: a Trigger's value is plain JSON, its optional keys left out when absent.
const asExpected = (value: TriggerChangeValue): Schema.Json => value as Schema.Json;

const decodeExpected = Schema.decodeUnknownOption(TriggerChangeValue);

/** The id `trigger_create` drew before asking, as its request keeps it. */
const CreateAsked = Schema.Struct({ id: Schema.String });

/** What a change the owner approved says when the Trigger changed between the request and the answer. */
const changedSince = (name: string) =>
  `The user approved, but the Trigger "${name}" changed since they were asked, so the change they saw was not made and nothing was saved. Call trigger_get for it as it is now, and ask again if the change is still needed.`;

/** The refusal for an `id` that names no Trigger. */
const noTrigger = (id: string) =>
  EnvironmentsError.make({
    message: `No Trigger has the id ${JSON.stringify(id)}. Call trigger_list for the Triggers and their ids.`,
  });

/** Why the agent can't give a Trigger `message`, or undefined when it can. */
const agentMessageProblem = (message: string): string | undefined =>
  triggerMessageProblem(message) ??
  (message.length > MAX_AGENT_TRIGGER_MESSAGE
    ? `A Trigger message you write has at most ${String(MAX_AGENT_TRIGGER_MESSAGE)} characters, so that the user's Approval card shows all of it: put the rest in a file in a Repo, and have the message say to read it`
    : undefined);

/** A refusal made before asking. */
const refuse = (problem: string) =>
  EnvironmentsError.make({ message: `Nothing was asked or saved: ${problem}.` });

/** A change's Agent change, as a result's details give it. */
// SAFETY: the two types describe the same values; the details are never mutated.
const changeDetails = (
  environment: { readonly id: string; readonly name: string },
  change: AgentChange,
) => ({
  id: change.id,
  environment,
  field: change.field,
  before: change.before as JsonValue | null,
  after: change.after as JsonValue | null,
});

/**
 * The `trigger_*` tools over the Session's `TriggerAccess` and `Environments`, asking through its `Approvals`, refusing a
 * text that holds a Secret (`Secrets`) or a deploy-time credential (`DeployCredentials`), and telling the Session of each
 * change for the Run's Notification (`AgentChangeLog`).
 */
export const TriggerTools: Effect.Effect<
  Extension,
  never,
  TriggerAccess | Environments | Approvals | AgentChangeLog | Secrets | DeployCredentials
> = Effect.gen(function* () {
  const access = yield* TriggerAccess;
  const environments = yield* Environments;
  const approvals = yield* Approvals;
  const log = yield* AgentChangeLog;

  const plainText = yield* plainTextCheck;
  const target = environmentTarget(environments);

  const plainReason = (reason: string) => plainText(reason, "the reason", "Say why without it.");

  /** Trigger `id`, or a refusal naming the tool that lists them. */
  const found = (id: string) =>
    access.get(id).pipe(Effect.filterOrFail(Predicate.isNotNull, () => noTrigger(id)));

  /** The Environment `id`, by id and name (its id for one gone). */
  const environmentNamed = (id: string) =>
    Effect.map(environments.get(id), (details) => ({ id, name: details?.name ?? id }));

  /** The card's target for a Trigger of Environment `environment`. */
  const targetOf = (environment: { readonly name: string }) =>
    `Environment ${JSON.stringify(environment.name)}`;

  /** `definition` as a result gives it, with its next Fires. */
  const outputOf = (
    definition: TriggerDefinition,
    environment: { readonly id: string; readonly name: string },
  ) =>
    Effect.map(Clock.currentTimeMillis, (now) =>
      triggerOutput(definition, environment, nextOf(definition, now)),
    );

  /**
   * The result of a change the Registry answered, made by `tool` (`approval`: the owner's answer, or null for a change
   * that does not wait for it): `made` says what was done, `already` what was so already.
   */
  const outcome = ({
    tool,
    id,
    name,
    applied,
    approval,
    made,
    already,
  }: {
    readonly tool: string;
    readonly id: string;
    readonly name: string;
    readonly applied: TriggerChanged;
    readonly approval: typeof APPROVED | null;
    readonly made: (definition: TriggerDefinition | null) => string;
    readonly already: string;
  }) =>
    Effect.gen(function* () {
      switch (applied.status) {
        case "missing":
          return yield* noTrigger(id);
        case "invalid":
          return yield* EnvironmentsError.make({
            message: `${approval === null ? "" : "The user approved, but "}nothing was saved: ${applied.problem}.`,
          });
        case "changed-since":
          return yield* EnvironmentsError.make({ message: changedSince(name) });
        case "unchanged": {
          const environment = yield* environmentNamed(applied.definition.environment);

          return {
            output: [
              {
                type: "text" as const,
                text:
                  approval === null
                    ? `${already}: nothing was changed or recorded.`
                    : approvedAlready(already.replace(/^The Trigger/, "the Trigger")),
              },
            ],
            structuredOutput: asOutput(
              TriggerChangeOutput,
              triggerChangeOutput({
                environment,
                changes: [],
                unchanged: [triggerField(id)],
                approval,
                trigger: yield* outputOf(applied.definition, environment),
              }),
            ),
            details: { approval, agentChanges: [] },
          };
        }

        case "changed": {
          yield* log.record({
            tool,
            environmentName: applied.environment.name,
            field: applied.change.field,
          });

          return {
            output: [
              {
                type: "text" as const,
                text: `${approval === null ? "" : "The user approved: "}${made(applied.definition)} ${RECORDED}`,
              },
            ],
            structuredOutput: asOutput(
              TriggerChangeOutput,
              triggerChangeOutput({
                environment: applied.environment,
                changes: [applied.change],
                approval,
                trigger:
                  applied.definition === null
                    ? null
                    : yield* outputOf(applied.definition, applied.environment),
              }),
            ),
            details: {
              approval,
              agentChange: changeDetails(applied.environment, applied.change),
            },
          };
        }
      }
    });

  /** The result of a request the owner declined, for the change `what` of Trigger `definition`. */
  const declinedChange = (
    answer: Extract<ApprovalAnswer, { approved: false }>,
    what: string,
    definition: TriggerDefinition | null,
    environment: { readonly id: string; readonly name: string },
  ) =>
    Effect.map(
      definition === null ? Effect.succeed(null) : outputOf(definition, environment),
      (trigger) =>
        declinedWith(answer, what, (approval) =>
          asOutput(
            TriggerChangeOutput,
            triggerChangeOutput({ environment, changes: [], approval, trigger }),
          ),
        ),
    );

  /**
   * A change of Trigger `id` that waits for the owner's Approval, made as `tool`: unless the Trigger has the values
   * already (`same`; then nothing is asked, but by a rerun that asked already), the card shows `change` from `before`
   * to `after`, and on Approve `apply` makes it, while the Trigger is still as the owner saw it.
   */
  const approvedChange = ({
    tool,
    id,
    reason,
    api,
    change,
    same,
    before,
    after,
    notes,
    apply,
    made,
    already,
  }: {
    readonly tool: string;
    readonly id: string;
    readonly reason: string;
    readonly api: ApprovalCall;
    readonly change: string;
    readonly same: (definition: TriggerDefinition) => boolean;
    readonly before: (definition: TriggerDefinition) => string;
    readonly after: string;
    readonly notes?: ReadonlyArray<string> | undefined;
    readonly apply: (
      expected: TriggerChangeValue | undefined,
      author: ChangeAuthor,
    ) => Effect.Effect<TriggerChanged, EnvironmentsError>;
    readonly made: (definition: TriggerDefinition | null) => string;
    readonly already: string;
  }) =>
    Effect.gen(function* () {
      const definition = yield* found(id);
      const environment = yield* environmentNamed(definition.environment);

      if (same(definition) && !(yield* askedBefore(approvals, api))) {
        return yield* outcome({
          tool,
          id,
          name: definition.name,
          applied: { status: "unchanged", definition },
          approval: null,
          made,
          already,
        });
      }

      return yield* withApproval(
        approvals,
        api,
        {
          tool,
          target: targetOf(environment),
          change,
          before: before(definition),
          after,
          reason,
          notice: `${change} "${definition.name}", ${targetOf(environment)}`,
          notes: notes ?? [],
          expected: asExpected(triggerChangeValue(definition)),
        },
        (answer) =>
          Effect.gen(function* () {
            if (!answer.approved) {
              return yield* declinedChange(
                answer,
                `${change.toLowerCase()} "${definition.name}"`,
                definition,
                environment,
              );
            }

            const applied = yield* apply(Option.getOrUndefined(decodeExpected(answer.expected)), {
              conversation: api.conversationId,
              tool,
              reason,
              approved: true,
            });

            return yield* outcome({
              tool,
              id,
              name: definition.name,
              applied,
              approval: APPROVED,
              made,
              already,
            });
          }),
      );
    });

  const list = yield* defineEffectTool({
    name: "trigger_list",
    description:
      "List the Triggers: what makes cloudpid start a Session unattended. An Environment trigger fires on its Schedule, each Fire starting a new Session in a new Workspace of its Environment with the Trigger message. Gives each one's id, name, Environment, Schedule, options, whether it is paused, and its next Fires; trigger_get gives one with its message.",
    parameters: Schema.Struct({
      environment: Schema.optionalKey(
        Id.annotate({
          description: "An Environment's id: list only its Triggers. Default: every Trigger",
        }),
      ),
    }),
    structuredOutputSchema: outputSchema(TriggerListOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ environment }) =>
      Effect.gen(function* () {
        const listed = yield* access.list(environment);
        const now = yield* Clock.currentTimeMillis;

        const named = yield* Effect.forEach(listed, (definition) =>
          Effect.map(environmentNamed(definition.environment), (where) => ({
            definition,
            where,
          })),
        );

        const lines = Arr.map(
          named,
          ({ definition, where }) =>
            `- ${definition.id}: "${definition.name}", Environment "${where.name}" (${where.id}), ${scheduleWords(scheduleOf(definition))}${definition.paused ? ", paused" : ""}`,
        );

        return {
          output: [
            {
              type: "text" as const,
              text:
                lines.length === 0
                  ? "No Triggers."
                  : `${String(lines.length)} Trigger${lines.length === 1 ? "" : "s"}:\n${Arr.join(lines, "\n")}`,
            },
          ],
          structuredOutput: asOutput(
            TriggerListOutput,
            triggerListOutput(
              Arr.map(named, ({ definition, where }) =>
                triggerSummaryOutput(definition, where, nextOf(definition, now)),
              ),
            ),
          ),
        };
      }),
  });

  const get = yield* defineEffectTool({
    name: "trigger_get",
    description:
      "Get one Trigger: its name, Environment, Trigger message, Schedule, options, whether it is paused, and its next Fires.",
    parameters: Schema.Struct({ id: TriggerId }),
    structuredOutputSchema: outputSchema(TriggerOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ id }) =>
      Effect.gen(function* () {
        const definition = yield* found(id);
        const environment = yield* environmentNamed(definition.environment);
        const now = yield* Clock.currentTimeMillis;
        const zone = scheduleOf(definition)?.zone ?? "UTC";
        const upcoming = nextOf(definition, now);

        const next = Arr.map(upcoming, (at) => fireTimeWords(at, zone));

        return {
          output: [
            {
              type: "text" as const,
              text: Arr.join(
                [
                  `Trigger ${definition.id} of Environment "${environment.name}" (${environment.id}).`,
                  triggerWords(triggerChangeValue(definition)),
                  next.length === 0
                    ? "No Fires are coming."
                    : `Next Fires: ${Arr.join(next, "; ")}`,
                ],
                "\n",
              ),
            },
          ],
          structuredOutput: asOutput(
            TriggerOutput,
            triggerOutput(definition, environment, upcoming),
          ),
        };
      }),
  });

  const create = yield* defineEffectTool({
    name: "trigger_create",
    description: Arr.join(
      [
        "Make a Trigger: on its Schedule, cloudpid starts a new Session in a new Workspace of the Environment and sends it the Trigger message, unattended (an Environment trigger). Use it when the user asks for recurring work, such as a weekly report. The user must approve it, as it starts Sessions on its own. Its kind and Environment never change: to move one, remove it and make another.",
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      owner: Id.annotate({
        description:
          "Whose Trigger it is: an Environment's id (each Fire starts a Session in a new Workspace of that Environment)",
      }),
      name: Schema.String.annotate({
        description: "1 to 80 characters, which titles each Fire's Session with the Fire's time",
      }),
      message: Message,
      schedule: Schedule,
      when_busy: Schema.optionalKey(WhenBusy),
      base: Schema.optionalKey(Base),
      model: Schema.optionalKey(
        ModelId.annotate({
          description: "The model of each Fire's Session; default the Environment's",
        }),
      ),
      thinking: Schema.optionalKey(
        ThinkingLevel.annotate({
          description: "The thinking level of each Fire's Session; default the Environment's",
        }),
      ),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(TriggerChangeOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ owner, name, message, schedule, when_busy, base, model, thinking, reason }, api) =>
      Effect.gen(function* () {
        yield* plainReason(reason);
        yield* plainText(name, "the name", "Name it without it.");
        yield* plainText(
          message,
          "the message",
          "Have the message name the Secret instead: the Session the Fire starts holds the Environment's Secrets.",
        );

        const source: ScheduleSource = {
          type: "schedule",
          cron: schedule.cron,
          zone: schedule.zone,
        };

        const problem =
          triggerNameProblem(name) ??
          agentMessageProblem(message) ??
          scheduleProblem(source) ??
          (base !== undefined && base.trim() === "" ? "a base branch can't be empty" : undefined);

        if (problem !== undefined) return yield* refuse(problem);

        const { environment: id } = yield* target(owner);
        const details = yield* environments.get(id);

        if (details === null) {
          return yield* EnvironmentsError.make({
            message: `No Environment has the id ${JSON.stringify(id)}. Call environment_list for the Environments and their ids.`,
          });
        }

        const environment = { id: details.id, name: details.name };

        const trigger: Types.Mutable<EnvironmentTriggerInput> = {
          kind: "environment",
          environment: environment.id,
          name: name.trim(),
          message,
          source,
        };

        // The Trigger as the card shows it: the options not given are their defaults.
        const value: Types.Mutable<TriggerChangeValue> = {
          kind: "environment",
          name: trigger.name,
          message,
          source,
          whenBusy: when_busy ?? "skip",
          paused: false,
        };

        if (when_busy !== undefined) trigger.whenBusy = when_busy;

        if (base !== undefined) trigger.base = value.base = base.trim();

        if (model !== undefined) trigger.model = value.model = model;

        if (thinking !== undefined) trigger.thinking = value.thinking = thinking;

        const now = yield* Clock.currentTimeMillis;
        const drawn = yield* access.newId;

        return yield* withApproval(
          approvals,
          api,
          {
            tool: "trigger_create",
            target: targetOf(environment),
            change: "Create a Trigger",
            before: "None",
            after: triggerWords(value),
            reason,
            notice: `Create the Trigger "${trigger.name}", ${targetOf(environment)}`,
            notes: [
              `Each Fire starts a new Session in a new Workspace of ${targetOf(environment)} and sends it the message, unattended.`,
              nextFiresNote(source, now),
            ],
            // The id the Trigger is made under, drawn now: a rerun after an eviction makes this one, not a second.
            expected: { id: drawn },
          },
          (answer) =>
            Effect.gen(function* () {
              if (!answer.approved) {
                return yield* declinedChange(
                  answer,
                  `creating the Trigger "${trigger.name}"`,
                  null,
                  environment,
                );
              }

              const asked = Schema.decodeUnknownOption(CreateAsked)(answer.expected);

              if (Option.isNone(asked)) {
                return yield* EnvironmentsError.make({
                  message:
                    "The user approved, but the request lost its Trigger's id: nothing was made. Ask again.",
                });
              }

              const applied = yield* access.create({
                id: asked.value.id,
                trigger,
                author: {
                  conversation: api.conversationId,
                  tool: "trigger_create",
                  reason,
                  approved: true,
                },
              });

              if (applied.status === "missing") {
                return yield* EnvironmentsError.make({
                  message: `The user approved, but ${targetOf(environment)} is gone: nothing was made.`,
                });
              }

              return yield* outcome({
                tool: "trigger_create",
                id: asked.value.id,
                name: trigger.name,
                applied,
                approval: APPROVED,
                made: (definition) =>
                  `made the Trigger "${trigger.name}" (id ${asked.value.id}) in ${targetOf(environment)}. ${definition === null ? "" : `It fires ${scheduleWords(source)}; ${nextFiresNote(source, now)}.`} Each Fire starts a new Session there with the message; the user is notified when its Run ends, or if a Fire fails. trigger_pause stops it at once.`,
                already: `The Trigger "${trigger.name}" exists`,
              });
            }),
        );
      }),
  });

  const messageSet = yield* defineEffectTool({
    name: "trigger_message_set",
    description: Arr.join(
      [
        "Change a Trigger's message: what each of its Fires' Sessions is sent. The user must approve the change.",
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({ id: TriggerId, message: Message, reason: Reason }),
    structuredOutputSchema: outputSchema(TriggerChangeOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ id, message, reason }, api) =>
      Effect.gen(function* () {
        yield* plainReason(reason);
        yield* plainText(
          message,
          "the message",
          "Have the message name the Secret instead: the Session the Fire starts holds the Environment's Secrets.",
        );

        const problem = agentMessageProblem(message);

        if (problem !== undefined) return yield* refuse(problem);

        return yield* approvedChange({
          tool: "trigger_message_set",
          id,
          reason,
          api,
          change: "Change a Trigger's message",
          same: (definition) => definition.message === message,
          before: (definition) => definition.message,
          after: message,
          apply: (expected, author) => access.update({ id, patch: { message }, expected, author }),
          made: () => "the Trigger's message is changed: its next Fires send the new one.",
          already: "The Trigger has that message already",
        });
      }),
  });

  const scheduleSet = yield* defineEffectTool({
    name: "trigger_schedule_set",
    description: Arr.join(
      [
        "Change a Trigger's Schedule: when it fires. The user must approve the change. Times due before the change are not caught up.",
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({ id: TriggerId, schedule: Schedule, reason: Reason }),
    structuredOutputSchema: outputSchema(TriggerChangeOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ id, schedule, reason }, api) =>
      Effect.gen(function* () {
        yield* plainReason(reason);

        const source: ScheduleSource = {
          type: "schedule",
          cron: schedule.cron,
          zone: schedule.zone,
        };

        const problem = scheduleProblem(source);

        if (problem !== undefined) return yield* refuse(problem);

        const now = yield* Clock.currentTimeMillis;

        return yield* approvedChange({
          tool: "trigger_schedule_set",
          id,
          reason,
          api,
          change: "Change a Trigger's Schedule",
          same: (definition) => {
            const held = scheduleOf(definition);

            return held?.cron === source.cron && held.zone === source.zone;
          },
          before: (definition) => scheduleWords(scheduleOf(definition)),
          after: scheduleWords(source),
          notes: [nextFiresNote(source, now)],
          apply: (expected, author) => access.update({ id, patch: { source }, expected, author }),
          made: (definition) =>
            `the Trigger fires ${scheduleWords(source)} now${definition?.paused === true ? " (once resumed)" : `; ${nextFiresNote(source, now)}`}.`,
          already: `The Trigger fires ${scheduleWords(source)} already`,
        });
      }),
  });

  const optionsSet = yield* defineEffectTool({
    name: "trigger_options_set",
    description: Arr.join(
      [
        "Change a Trigger's options, each where its kind takes it: when_busy, base, model and thinking (an Environment trigger takes all four). Give only those to change; null puts base, model or thinking back to its default. The user must approve the change.",
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: TriggerId,
      when_busy: Schema.optionalKey(WhenBusy),
      base: Schema.optionalKey(Base.pipe(Schema.NullOr)),
      model: Schema.optionalKey(
        Schema.NullOr(ModelId).annotate({
          description: "The model of each Fire's Session; null for the Environment's",
        }),
      ),
      thinking: Schema.optionalKey(
        Schema.NullOr(ThinkingLevel).annotate({
          description: "The thinking level of each Fire's Session; null for the Environment's",
        }),
      ),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(TriggerChangeOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ id, when_busy, base, model, thinking, reason }, api) =>
      Effect.gen(function* () {
        yield* plainReason(reason);

        if (
          when_busy === undefined &&
          base === undefined &&
          model === undefined &&
          thinking === undefined
        ) {
          return yield* refuse("give at least one of when_busy, base, model and thinking");
        }

        if (base !== undefined && base !== null && base.trim() === "") {
          return yield* refuse("a base branch can't be empty");
        }

        const definition = yield* found(id);

        // Every option is an Environment trigger's; a kind a later version added is not this version's to change.
        if (definition.kind !== "environment") {
          return yield* refuse("this version can't change the options of this Trigger's kind");
        }

        const patch: Types.Mutable<TriggerPatch> = {};

        if (when_busy !== undefined) patch.whenBusy = when_busy;

        if (base !== undefined) patch.base = base === null ? null : base.trim();

        if (model !== undefined) patch.model = model;

        if (thinking !== undefined) patch.thinking = thinking;

        const next = (held: TriggerDefinition) => ({
          whenBusy: patch.whenBusy ?? held.whenBusy,
          base: patch.base === undefined ? held.base : (patch.base ?? undefined),
          model: patch.model === undefined ? held.model : (patch.model ?? undefined),
          thinking: patch.thinking === undefined ? held.thinking : (patch.thinking ?? undefined),
        });

        const after = optionsWords(next(definition));

        return yield* approvedChange({
          tool: "trigger_options_set",
          id,
          reason,
          api,
          change: "Change a Trigger's options",
          same: (held) => optionsWords(held) === optionsWords(next(held)),
          before: optionsWords,
          after,
          apply: (expected, author) => access.update({ id, patch, expected, author }),
          made: () => `the Trigger's options are ${after} now.`,
          already: `The Trigger's options are ${after} already`,
        });
      }),
  });

  const resume = yield* defineEffectTool({
    name: "trigger_resume",
    description: Arr.join(
      [
        "Resume a Paused trigger: it fires on its Schedule again, from the next time due; the times it missed while paused are not caught up. The user must approve it.",
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({ id: TriggerId, reason: Reason }),
    structuredOutputSchema: outputSchema(TriggerChangeOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ id, reason }, api) =>
      Effect.gen(function* () {
        yield* plainReason(reason);

        const definition = yield* found(id);
        const schedule = scheduleOf(definition);
        const now = yield* Clock.currentTimeMillis;

        return yield* approvedChange({
          tool: "trigger_resume",
          id,
          reason,
          api,
          change: "Resume a Trigger",
          same: (held) => !held.paused,
          before: () => "Paused",
          after: `Active: fires ${scheduleWords(schedule)}`,
          notes: schedule === undefined ? [] : [nextFiresNote(schedule, now)],
          apply: (expected, author) => access.setPaused({ id, paused: false, expected, author }),
          made: () =>
            `the Trigger is active again${schedule === undefined ? "" : `; ${nextFiresNote(schedule, now)}`}. The times it missed while paused are not caught up.`,
          already: "The Trigger is active already",
        });
      }),
  });

  /** A change that only narrows what a Trigger does, made at once as `tool`, with no Approval. */
  const narrowing = (
    tool: string,
    id: string,
    reason: string,
    conversation: number,
    apply: (author: ChangeAuthor) => Effect.Effect<TriggerChanged, EnvironmentsError>,
    made: string,
    already: string,
  ) =>
    Effect.gen(function* () {
      yield* plainReason(reason);

      const definition = yield* found(id);
      const applied = yield* apply({ conversation, tool, reason });

      return yield* outcome({
        tool,
        id,
        name: definition.name,
        applied,
        approval: null,
        made: () => made,
        already,
      });
    });

  const pause = yield* defineEffectTool({
    name: "trigger_pause",
    description:
      "Pause a Trigger: it doesn't fire until resumed, and a Fire it had queued is skipped. It only narrows what the Trigger does, so it applies at once, with no Approval; trigger_resume, which needs the user's, starts it again.",
    parameters: Schema.Struct({ id: TriggerId, reason: Reason }),
    structuredOutputSchema: outputSchema(TriggerChangeOutput),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, reason }, api) =>
      narrowing(
        "trigger_pause",
        id,
        reason,
        api.conversationId,
        (author) => access.setPaused({ id, paused: true, author }),
        "The Trigger is paused: it doesn't fire until resumed (trigger_resume, which the user must approve).",
        "The Trigger is paused already",
      ),
  });

  const remove = yield* defineEffectTool({
    name: "trigger_remove",
    description:
      "Remove a Trigger: it never fires again, and its fire log goes with it. It applies at once, with no Approval; the user can revert it on the Environments page, which brings the Trigger back.",
    parameters: Schema.Struct({ id: TriggerId, reason: Reason }),
    structuredOutputSchema: outputSchema(TriggerChangeOutput),
    executionMode: "sequential",
    replay: "unsafe",
    execute: ({ id, reason }, api) =>
      narrowing(
        "trigger_remove",
        id,
        reason,
        api.conversationId,
        (author) => access.remove({ id, author }),
        "The Trigger is removed: it never fires again.",
        "The Trigger is removed already",
      ),
  });

  return defineExtension({
    name: extensionName,
    tools: [list, get, create, messageSet, scheduleSet, optionsSet, pause, resume, remove],
  });
});
