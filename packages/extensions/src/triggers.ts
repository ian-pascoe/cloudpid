// The `trigger_*` tools (`docs/architecture/triggers.md` → Agent tools and Approval, ADR-0019, ADR-0047): the agent
// lists and reads the Triggers, makes an Environment trigger or a Workspace trigger for its own Workspace, changes its
// message, Schedule or options, and pauses, resumes or removes one. Making a Trigger, changing what it sends or when (`trigger_create`, `trigger_message_set`,
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
  fireTimeWords,
  nextFires,
  scheduleOf,
  scheduleProblem,
  type ScheduleSource,
  type EnvironmentRef,
  triggerChangeJson,
  type TriggerChanged,
  triggerChangeValue,
  TriggerChangeValue,
  type TriggerDefinition,
  triggerField,
  type EnvironmentTriggerInput,
  type TriggerInput,
  type TriggerKind,
  triggerMessageProblem,
  triggerNameProblem,
  type TriggerPatch,
  baseProblem,
  whenBusyProblem,
  defaultWhenBusy,
  type WorkspaceRef,
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
  plainTextCheck,
} from "./environment.ts";
import { MAX_CARD_CHARS } from "./environment-skills-global.ts";
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
 * The most characters of a Trigger message an Approval card shows, as of a Skill's files (`MAX_CARD_CHARS`): a longer
 * one is shown cut, with a warning that the rest is not, since the owner approves what they can read.
 */
const MAX_CARD_MESSAGE = MAX_CARD_CHARS;

/** How many of a Trigger's next Fires a result and a card show. */
const NEXT_FIRES = 3;

/** The Workspace this Session works in, which a Workspace trigger made from it keeps. */
export type TriggerWorkspace = WorkspaceRef & { readonly environment: string };

/** What `trigger_create`'s `owner` says for a Trigger kept for this Session's own Workspace. */
export const WORKSPACE_OWNER = "workspace";

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
  /** The Workspace this Session works in, with its Environment: all a Workspace trigger made here can mean. */
  readonly workspace: Effect.Effect<TriggerWorkspace, EnvironmentsError>;
  readonly create: (input: {
    readonly id: string;
    readonly trigger: TriggerInput;
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

const WhenBusy = Schema.Literals(["wait", "skip", "start"]).annotate({
  description:
    'What a Fire does while the work of the last one is still going on. Environment trigger: "skip" (the default) skips a Fire while the last Fire\'s Session is still running or waiting for the user; "start" starts a Session anyway. Workspace trigger: "wait" (the default) keeps the Fire pending until no Session in the Workspace is at work (the user\'s own included), merging any later Fires into it; "skip" skips it; "start" starts a Session anyway. "wait" is refused for an Environment trigger',
});

const Base = Schema.String.check(Schema.isMinLength(1)).annotate({
  description:
    "The remote branch each Fire's Workspace starts from; default each Repo's default branch",
});

const Message = Schema.String.annotate({
  description: `The Trigger message: what each Fire's new Session is sent, after cloudpid's header (the Trigger's name, the scheduled and actual time). It runs unattended, so say everything the work needs; a long one can point to a file in a Repo`,
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

/** A Trigger's options as the owner reads them; a Workspace trigger holds no base. */
const optionsWords = (options: {
  readonly kind?: TriggerKind | undefined;
  readonly whenBusy: string;
  readonly base?: string | undefined;
  readonly model?: string | undefined;
  readonly thinking?: string | undefined;
}): string =>
  Arr.join(
    [
      `when busy: ${options.whenBusy}`,
      ...(options.kind === "workspace"
        ? []
        : [`base: ${options.base ?? "each Repo's default branch"}`]),
      `model: ${options.model ?? "the Environment's"}`,
      `thinking: ${options.thinking ?? "the Environment's"}`,
    ],
    ", ",
  );

/**
 * A Trigger message as a card shows it: as written, or its first `MAX_CARD_MESSAGE` characters with a warning, before
 * and after, that the rest is not shown.
 */
const cardMessage = (message: string): string => {
  if (message.length <= MAX_CARD_MESSAGE) return message;

  const warning = `[The card shows only the first ${String(MAX_CARD_MESSAGE)} of the message's ${String(message.length)} characters: Approve keeps the rest unreviewed.]`;

  return `${warning}\n${message.slice(0, MAX_CARD_MESSAGE)}\n${warning}`;
};

/** The card's note for a message too long to show in full, if `messages` holds one. */
const cutMessageNotes = (...messages: ReadonlyArray<string>): ReadonlyArray<string> =>
  Arr.some(messages, (message) => message.length > MAX_CARD_MESSAGE)
    ? [
        `The message is longer than the card shows: only its first ${String(MAX_CARD_MESSAGE)} characters are shown, so the rest is not reviewed.`,
      ]
    : [];

/** `text` held to `max` characters, ending in "…" when cut. */
const clipped = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

/** A Trigger as a card describes it in full, its message as `cardMessage` shows it. */
const triggerWords = (value: TriggerChangeValue): string =>
  Arr.join(
    [
      `Name: ${value.name}`,
      ...(value.workspace === undefined ? [] : [`Workspace: ${value.workspace.branch}`]),
      `Schedule: ${scheduleWords(scheduleOf(value))}`,
      `Options: ${optionsWords(value)}`,
      ...(value.paused ? ["Paused"] : []),
      `Message:\n${cardMessage(value.message)}`,
    ],
    "\n",
  );

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

/** A refusal made before asking. */
const refuse = (problem: string) =>
  EnvironmentsError.make({ message: `Nothing was asked or saved: ${problem}.` });

/** A change's Agent change, as a result's details give it. */
// SAFETY: the two types describe the same values; the details are never mutated.
const changeDetails = (environment: EnvironmentRef, change: AgentChange) => ({
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

  /** Fails, asking nothing, for a Trigger message that holds a Secret or that the Registry would refuse. */
  const plainMessage = (message: string) =>
    Effect.gen(function* () {
      yield* plainText(
        message,
        "the message",
        "Have the message name the Secret instead: the Session the Fire starts holds the Environment's Secrets.",
      );

      const problem = triggerMessageProblem(message);

      if (problem !== undefined) return yield* refuse(problem);
    });

  /** `schedule` as a Trigger's source, or a refusal, asking nothing, of one the Registry would refuse. */
  const scheduleSource = (schedule: typeof Schedule.Type) =>
    Effect.gen(function* () {
      const source: ScheduleSource = { type: "schedule", cron: schedule.cron, zone: schedule.zone };
      const problem = scheduleProblem(source);

      if (problem !== undefined) return yield* refuse(problem);

      return source;
    });

  /** Trigger `id`, or a refusal naming the tool that lists them. */
  const found = (id: string) =>
    access.get(id).pipe(Effect.filterOrFail(Predicate.isNotNull, () => noTrigger(id)));

  /** The Environment `id`, by id and name (its id for one gone). */
  const environmentNamed = (id: string) =>
    Effect.map(environments.get(id), (details) => ({ id, name: details?.name ?? id }));

  /** The card's target for a Trigger of Environment `environment`, kept for `workspace` if it is a Workspace trigger's. */
  const targetOf = (
    environment: { readonly name: string },
    workspace?: { readonly branch: string },
  ) =>
    workspace === undefined
      ? `Environment ${JSON.stringify(environment.name)}`
      : `Workspace ${JSON.stringify(workspace.branch)} of Environment ${JSON.stringify(environment.name)}`;

  /** `definition` as a result gives it, with its next Fires. */
  const outputOf = (definition: TriggerDefinition, environment: EnvironmentRef) =>
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
    environment: EnvironmentRef,
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
    readonly notes?: ((definition: TriggerDefinition) => ReadonlyArray<string>) | undefined;
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

      // A Trigger that has the values asks nothing; the call still goes to the Registry, which changes nothing, so the
      // Trigger's object is woken (a call cut off after the change may never have woken it). It changes only while the
      // Trigger is as read here, so a change made meanwhile is not made without the owner's Approval.
      if (same(definition) && !(yield* askedBefore(approvals, api))) {
        return yield* outcome({
          tool,
          id,
          name: definition.name,
          applied: yield* apply(triggerChangeValue(definition), {
            conversation: api.conversationId,
            tool,
            reason,
          }),
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
          target: targetOf(environment, definition.workspace),
          change,
          before: before(definition),
          after,
          reason,
          notice: `${change} "${definition.name}", ${targetOf(environment, definition.workspace)}`,
          notes: notes?.(definition) ?? [],
          expected: triggerChangeJson(definition),
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
      "List the Triggers: what makes cloudpid start a Session unattended. An Environment trigger fires on its Schedule, each Fire starting a new Session in a new Workspace of its Environment with the Trigger message; a Workspace trigger starts each Fire's Session in one Workspace, on its files and branch. Gives each one's id, name, kind, Environment, Workspace (a Workspace trigger's), Schedule, options, whether it is paused, and its next Fires; trigger_get gives one with its message.",
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
            `- ${definition.id}: "${definition.name}", ${definition.workspace === undefined ? "" : `Workspace ${definition.workspace.branch} of `}Environment "${where.name}" (${where.id}), ${scheduleWords(scheduleOf(definition))}${definition.paused ? ", paused" : ""}`,
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
      "Get one Trigger: its name, kind, Environment, Workspace (a Workspace trigger's), Trigger message, Schedule, options, whether it is paused, and its next Fires.",
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
                  `Trigger ${definition.id} of ${definition.workspace === undefined ? "" : `Workspace ${definition.workspace.branch} in `}Environment "${environment.name}" (${environment.id}).`,
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
        "Make a Trigger: on its Schedule, cloudpid starts a new Session and sends it the Trigger message, unattended. An Environment trigger (owner: the Environment's id) starts each Session in a new Workspace of the Environment; a Workspace trigger (owner: \"workspace\") starts each one in this Session's own Workspace, on its files and branch, once no Session there is at work, and keeps that Workspace until it is removed. Use it when the user asks for recurring work, such as a weekly report. The user must approve it, as it starts Sessions on its own. Its kind, Environment and Workspace never change: to move one, remove it and make another.",
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      owner: Id.annotate({
        description:
          "Whose Trigger it is: an Environment's id (each Fire starts a Session in a new Workspace of that Environment), or \"workspace\" (this Session's own Workspace only: each Fire starts a Session in it, which then cannot be removed with its last Session while the Trigger exists)",
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
        yield* plainMessage(message);

        const source = yield* scheduleSource(schedule);

        const problem =
          triggerNameProblem(name) ??
          (base !== undefined && base.trim() === "" ? "a base branch can't be empty" : undefined);

        if (problem !== undefined) return yield* refuse(problem);

        // `workspace` is this Session's own Workspace: the agent has no tool that lists others.
        const here = owner === WORKSPACE_OWNER ? yield* access.workspace : undefined;
        const kind = here === undefined ? "environment" : "workspace";

        const optionProblem =
          baseProblem(kind, base) ??
          whenBusyProblem(kind, when_busy ?? defaultWhenBusy(kind, source));

        if (optionProblem !== undefined) return yield* refuse(optionProblem);

        const { environment: id } = here ?? (yield* target(owner));
        const details = yield* environments.get(id);

        if (details === null) {
          return yield* EnvironmentsError.make({
            message: `No Environment has the id ${JSON.stringify(id)}. Call environment_list for the Environments and their ids.`,
          });
        }

        const environment = { id: details.id, name: details.name };

        // The Trigger as the card shows it: the options not given are their defaults.
        const value: Types.Mutable<TriggerChangeValue> = {
          kind,
          name: name.trim(),
          message,
          source,
          whenBusy: when_busy ?? defaultWhenBusy(kind, source),
          paused: false,
        };

        // What both kinds are made with: the options not given are left for the Registry's defaults.
        const shared: Types.Mutable<
          Pick<
            EnvironmentTriggerInput,
            "name" | "message" | "source" | "whenBusy" | "model" | "thinking"
          >
        > = { name: value.name, message, source };

        if (when_busy !== undefined) shared.whenBusy = when_busy;

        if (model !== undefined) shared.model = value.model = model;

        if (thinking !== undefined) shared.thinking = value.thinking = thinking;

        let trigger: TriggerInput;

        if (here === undefined) {
          const made: Types.Mutable<EnvironmentTriggerInput> = {
            kind: "environment",
            environment: environment.id,
            ...shared,
          };

          if (base !== undefined) made.base = value.base = base.trim();

          trigger = made;
        } else {
          value.workspace = { id: here.id, branch: here.branch };
          trigger = { kind: "workspace", workspace: here.id, ...shared };
        }

        const now = yield* Clock.currentTimeMillis;
        const drawn = yield* access.newId;

        return yield* withApproval(
          approvals,
          api,
          {
            tool: "trigger_create",
            target: targetOf(environment, here),
            change: "Create a Trigger",
            before: "None",
            after: triggerWords(value),
            reason,
            notice: `Create the Trigger "${trigger.name}", ${targetOf(environment, here)}`,
            notes: [
              here === undefined
                ? `Each Fire starts a new Session in a new Workspace of Environment ${JSON.stringify(clipped(environment.name, 80))} and sends it the message, unattended.`
                : `Each Fire starts a new Session in Workspace ${JSON.stringify(clipped(here.branch, 80))}, on its files and branch, and sends it the message, unattended. It keeps the Workspace: deleting the Workspace's last Session no longer removes it, while this Trigger exists.`,
              nextFiresNote(source, now),
              ...cutMessageNotes(message),
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
                  message: `The user approved, but ${targetOf(environment, here)} is gone: nothing was made.`,
                });
              }

              return yield* outcome({
                tool: "trigger_create",
                id: asked.value.id,
                name: trigger.name,
                applied,
                approval: APPROVED,
                made: (definition) =>
                  `made the Trigger "${trigger.name}" (id ${asked.value.id}) in ${targetOf(environment, here)}. ${definition === null ? "" : `It fires ${scheduleWords(source)}; ${nextFiresNote(source, now)}.`} Each Fire starts a new Session there with the message${here === undefined ? "" : ` once the Workspace is idle (when busy: ${trigger.whenBusy ?? "wait"})`}; the user is notified when its Run ends, or if a Fire fails. trigger_pause stops it at once.`,
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
        yield* plainMessage(message);

        return yield* approvedChange({
          tool: "trigger_message_set",
          id,
          reason,
          api,
          change: "Change a Trigger's message",
          same: (definition) => definition.message === message,
          before: (definition) => cardMessage(definition.message),
          after: cardMessage(message),
          notes: (definition) => cutMessageNotes(definition.message, message),
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

        const source = yield* scheduleSource(schedule);
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
          notes: () => [nextFiresNote(source, now)],
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
        "Change a Trigger's options, each where its kind takes it: when_busy, base, model and thinking (an Environment trigger takes all four; a Workspace trigger takes when_busy, model and thinking, and no base). Give only those to change; null puts base, model or thinking back to its default. The user must approve the change.",
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

        // A kind a later version added is not this version's to change.
        if (definition.kind !== "environment" && definition.kind !== "workspace") {
          return yield* refuse("this version can't change the options of this Trigger's kind");
        }

        const optionProblem =
          baseProblem(definition.kind, base) ??
          (when_busy === undefined ? undefined : whenBusyProblem(definition.kind, when_busy));

        if (optionProblem !== undefined) return yield* refuse(optionProblem);

        const patch: Types.Mutable<TriggerPatch> = {};

        if (when_busy !== undefined) patch.whenBusy = when_busy;

        if (base !== undefined) patch.base = base === null ? null : base.trim();

        if (model !== undefined) patch.model = model;

        if (thinking !== undefined) patch.thinking = thinking;

        const next = (held: TriggerDefinition) => ({
          kind: held.kind,
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
          notes: () => (schedule === undefined ? [] : [nextFiresNote(schedule, now)]),
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
