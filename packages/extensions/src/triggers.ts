// The `trigger_*` tools (`docs/architecture/triggers.md` → Agent tools and Approval, ADR-0019, ADR-0047): the agent
// lists and reads the Triggers, makes an Environment trigger or a Workspace trigger for its own Workspace (on a
// Schedule, or on a webhook with a `match`) or a Session trigger for itself (on a Schedule only), changes its message,
// Schedule, `match` or options, and pauses, resumes or removes one. Making a Trigger, changing what it sends, when or
// which deliveries (`trigger_create`, `trigger_message_set`, `trigger_schedule_set`, `trigger_match_set`,
// `trigger_options_set`) and `trigger_resume` wait for the owner's Approval (`withApproval`), since each makes cloudpid
// start Sessions unattended; `trigger_pause` and `trigger_remove` only narrow, so they apply at once. A Trigger's kind,
// Environment and source type never change. There is no fire-now tool: the agent can't start Sessions at will. A
// webhook Trigger's URL and Signing secret are the owner's alone: no card, result or output holds them, and the tools
// say where the owner finds them. A Session trigger has no webhook: it is the Session's own, sent into its own
// conversation, and a webhook's deliveries are the owner's to receive. Each tool refuses without asking what it would
// refuse anyway (a Schedule without a zone, a 6-field one, `L`, `W` or `#`; neither or both of a schedule and a
// webhook; a webhook or match for a Session trigger; a match that is no path with values; a reason, name, message or
// match holding a Secret; a message longer than the card shows), then makes the change through the Session's
// `TriggerAccess`, which records it as an Agent change of the field `triggers.<id>` under the Trigger's Environment and
// wakes the Trigger's object. An approved change is made only while the Trigger is still as the owner saw it;
// `trigger_create` draws its Trigger's id before asking and keeps it in the request, so a rerun after an eviction makes
// no second one. The tools are the root conversation's only (`trigger_` is in `PARENT_ONLY_TOOL_PREFIXES`) and
// deferred, and give programs their outcome (`./trigger-outputs.ts`).
// @effect-diagnostics missingPipeableSignature:off globalJsonInEffect:off
import { ModelId, ThinkingLevel } from "@cloudpid/config";
import { defineEffectTool } from "@cloudpid/effect-durable";
import {
  type AgentChange,
  KnownWhenBusy,
  fireTimeWords,
  matchProblem,
  nextFires,
  ownOptionsProblem,
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
  type TriggerKind,
  triggerMessageProblem,
  triggerNameProblem,
  TriggerMatch,
  type TriggerPatch,
  type TriggerSourceInput,
  webhookOf,
  WebhookFormat,
  defaultWhenBusy,
  type SessionTriggerInput,
  takesBase,
  takesModel,
  type WorkspaceRef,
  type WorkspaceTriggerInput,
  whenBusyProblem,
} from "@cloudpid/protocol";
import type { JsonValue } from "@earendil-works/chord";
import { defineExtension, type Extension } from "@earendil-works/pi-durable";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
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
  /**
   * `environment`'s Triggers, or every one, newest first: those this Session may change. A Session trigger is its own
   * Session's alone, so another Session's is neither listed nor found.
   */
  readonly list: (
    environment: string | undefined,
  ) => Effect.Effect<ReadonlyArray<TriggerDefinition>, EnvironmentsError>;
  /** Trigger `id`, or null when there is none (or it is another Session's Session trigger). */
  readonly get: (id: string) => Effect.Effect<TriggerDefinition | null, EnvironmentsError>;
  /** A fresh Trigger id. */
  readonly newId: Effect.Effect<string>;
  /** The Workspace this Session works in, with its Environment: all a Workspace trigger made here can mean. */
  readonly workspace: Effect.Effect<TriggerWorkspace, EnvironmentsError>;
  readonly create: (input: {
    readonly id: string;
    readonly trigger: OwnTriggerInput;
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

/** A Session trigger of the Session that makes it: the access gives it that Session's id. */
export type OwnSessionTriggerInput = Omit<SessionTriggerInput, "session">;

/** A Trigger the tools make: the Session trigger of the Session that makes it, or an Environment or Workspace trigger. */
export type OwnTriggerInput =
  | EnvironmentTriggerInput
  | WorkspaceTriggerInput
  | OwnSessionTriggerInput;

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

const Webhook = Schema.Struct({
  format: WebhookFormat.annotate({
    description:
      '"github": GitHub signs each delivery with X-Hub-Signature-256 (the repo or App webhook\'s secret); "standard": Standard Webhooks (webhook-id, webhook-timestamp and webhook-signature), which Svix-based senders use',
  }),
}).annotate({
  description:
    "Fire on each signed delivery to the Trigger's URL instead of on a Schedule (an Environment trigger or a Workspace trigger only). cloudpid makes the URL and the Signing secret when the Trigger is made and shows them only to the user, on the Trigger's page: you never see either",
});

const Match = TriggerMatch.annotate({
  description:
    'Only deliveries that match start a Session: each key is a dotted path into the delivery\'s JSON body (such as "workflow_run.conclusion", or "commits.0.message"; "event" is the event\'s name, such as "issues"), each value lists the texts it may have there. Every path must match (AND), any one of its values will do (OR); numbers and booleans compare as their text. An example: {"event": ["workflow_run"], "workflow_run.conclusion": ["failure"]}. Without a match, every delivery that is signed right starts a Session',
});

const WhenBusy = KnownWhenBusy.annotate({
  description:
    'What a Fire does while the work of the last one is still going on. Environment trigger: "skip" (the default for a Schedule) skips a Fire while the last Fire\'s Session is still running or waiting for the user; "start" (the default for a webhook) starts a Session anyway. Workspace trigger: "wait" (the default) keeps the Fire pending until no Session in the Workspace is at work (the user\'s own included), merging any later Fires into it; "skip" skips it; "start" starts a Session anyway. Session trigger: "queue" (the default) waits behind the Run going on, or the user\'s answer; "steer" joins the Run at its next boundary; "skip" skips a Fire while a Run goes on. Each kind refuses the values it does not take',
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

/** What a card says of a Trigger with no `match`. */
const NO_MATCH = "none: every delivery that is signed right starts a Session";

/** A Schedule as the owner reads it. */
const scheduleWords = (schedule: ScheduleSource | undefined): string =>
  schedule === undefined
    ? "a source this version can't read"
    : `"${schedule.cron}" in ${schedule.zone}`;

/**
 * A `match` as the owner reads it: each path with the values it may have, every one quoted, so that a value can't fake
 * a line or blur two values; or that there is none.
 */
const matchWords = (match: TriggerMatch | undefined): string => {
  const entries = Rec.toEntries(match ?? {});

  return entries.length === 0
    ? NO_MATCH
    : Arr.join(
        Arr.map(
          entries,
          ([path, values]) =>
            `${JSON.stringify(path)} is ${Arr.join(
              Arr.map(values, (value) => JSON.stringify(value)),
              " or ",
            )}`,
        ),
        "; ",
      );
};

/** `matchWords` of a match the Trigger holds, cut to what a card shows. */
const matchCard = (match: TriggerMatch | undefined): string =>
  clipped(matchWords(match), MAX_CARD_CHARS);

/** A `match` as the Trigger holds it, for comparing: its paths in order, each with its values in order. */
const matchKey = (match: TriggerMatch | undefined): string =>
  JSON.stringify(
    Arr.sort(
      Rec.toEntries(match ?? {}),
      Order.mapInput(Order.String, ([path]: readonly [string, ReadonlyArray<string>]) => path),
    ),
  );

/** What fires a Trigger, as the owner reads it: its Schedule, or the format of its webhook. */
const sourceWords = (holder: { readonly source: TriggerChangeValue["source"] }): string => {
  const webhook = webhookOf(holder);

  return webhook === undefined
    ? scheduleWords(scheduleOf(holder))
    : `a webhook (${webhook.format} format)`;
};

/** Where a webhook Trigger's URL and Signing secret are, which the agent never sees. */
const SECRETS_NOTE =
  "Its URL and Signing secret are the user's alone, on the Trigger's page in Settings; they are never shown to you.";

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

/** A Trigger's options as the owner reads them: each kind's own, and its `when busy`. */
const optionsWords = (options: {
  readonly kind: TriggerKind;
  readonly whenBusy: string;
  readonly base?: string | undefined;
  readonly model?: string | undefined;
  readonly thinking?: string | undefined;
}): string =>
  Arr.join(
    [
      `when busy: ${options.whenBusy}`,
      ...(takesBase(options.kind) ? [`base: ${options.base ?? "each Repo's default branch"}`] : []),
      ...(takesModel(options.kind)
        ? [
            `model: ${options.model ?? "the Environment's"}`,
            `thinking: ${options.thinking ?? "the Environment's"}`,
          ]
        : []),
    ],
    ", ",
  );

/** A Trigger as a card or listing describes it: its kind, and the Workspace a Workspace trigger keeps. */
type Held = { readonly kind: TriggerKind; readonly workspace?: WorkspaceRef | undefined };

/** What a card and a listing say of a Trigger of a kind, where kinds differ. */
type KindWords = {
  /** What a card says the Trigger acts on, given the Environment's name and the Workspace it keeps, if any. */
  readonly target: (environment: string, workspace: WorkspaceRef | undefined) => string;
  /** A listing line's note of the kind, with its separator, if the kind has one. */
  readonly listed: (workspace: WorkspaceRef | undefined) => string;
  /** The first line of `trigger_get`. */
  readonly heading: (
    id: string,
    environment: EnvironmentRef,
    workspace: WorkspaceRef | undefined,
  ) => string;
  /** The lines of a card that say what the Trigger acts on, if the kind has any to add. */
  readonly fires: (workspace: WorkspaceRef | undefined) => ReadonlyArray<string>;
  /**
   * The Trigger `trigger_create` asks the Registry for, in Environment `environment` (and `workspace`, its own), or
   * undefined when the kind can't fire on `source`: a Session trigger has a Schedule only.
   */
  readonly input: (fields: {
    readonly environment: string;
    readonly workspace: string | undefined;
    readonly name: string;
    readonly message: string;
    readonly source: TriggerSourceInput;
  }) => OwnTriggerInput | undefined;
  /** What an approval card's note says each Fire does, given the Environment's name and the Workspace it keeps. */
  readonly fireNote: (environmentName: string, workspace: WorkspaceRef | undefined) => string;
  /** What the result of a made Trigger says each Fire does, given its `when_busy`. */
  readonly madeNote: (whenBusy: string) => string;
};

const ENVIRONMENT_WORDS: KindWords = {
  target: (environment) => `Environment ${JSON.stringify(environment)}`,
  listed: () => "",
  heading: (id, environment) =>
    `Trigger ${id} of Environment "${environment.name}" (${environment.id}).`,
  fires: () => [],
  input: ({ environment, name, message, source }) => ({
    kind: "environment",
    environment,
    name,
    message,
    source,
  }),
  fireNote: (environmentName) =>
    `Each Fire starts a new Session in a new Workspace of Environment ${JSON.stringify(clipped(environmentName, 80))} and sends it the message, unattended.`,
  madeNote: () => "Each Fire starts a new Session there with the message",
};

/** Each kind's words: a later kind is one more entry. A kind this version doesn't know reads as an Environment trigger's. */
const KIND_WORDS: Record<TriggerKind, KindWords> = {
  environment: ENVIRONMENT_WORDS,
  workspace: {
    // A Workspace trigger always has its Workspace; one that does not read as an Environment trigger's.
    target: (environment, workspace) =>
      workspace === undefined
        ? ENVIRONMENT_WORDS.target(environment, workspace)
        : `Workspace ${JSON.stringify(workspace.branch)} of Environment ${JSON.stringify(environment)}`,
    listed: (workspace) => (workspace === undefined ? "" : `Workspace ${workspace.branch} of `),
    heading: (id, environment, workspace) =>
      workspace === undefined
        ? ENVIRONMENT_WORDS.heading(id, environment, workspace)
        : `Trigger ${id} of Workspace ${workspace.branch} in Environment "${environment.name}" (${environment.id}).`,
    fires: (workspace) => (workspace === undefined ? [] : [`Workspace: ${workspace.branch}`]),
    input: (fields) =>
      fields.workspace === undefined
        ? ENVIRONMENT_WORDS.input(fields)
        : {
            kind: "workspace",
            workspace: fields.workspace,
            name: fields.name,
            message: fields.message,
            source: fields.source,
          },
    fireNote: (environmentName, workspace) =>
      workspace === undefined
        ? ENVIRONMENT_WORDS.fireNote(environmentName, workspace)
        : `Each Fire starts a new Session in Workspace ${JSON.stringify(clipped(workspace.branch, 80))}, on its files and branch, and sends it the message, unattended. It keeps the Workspace: deleting the Workspace's last Session no longer removes it, while this Trigger exists.`,
    madeNote: (whenBusy) =>
      `Each Fire starts a new Session there with the message once the Workspace is idle (when busy: ${whenBusy})`,
  },
  session: {
    target: () => "This Session",
    listed: () => "Session trigger of this Session, ",
    heading: (id, environment) =>
      `Session trigger ${id} of this Session, in Environment "${environment.name}" (${environment.id}).`,
    fires: () => [
      "Kind: Session trigger: each Fire sends the message into this Session's root conversation",
    ],
    input: ({ name, message, source }) =>
      source.type === "schedule" ? { kind: "session", name, message, source } : undefined,
    fireNote: () =>
      "Each Fire sends the message into this Session's root conversation, on its active branch, unattended; while a Run goes on, when_busy queues it, steers it or skips it.",
    madeNote: () => "Each Fire sends the message into this Session's root conversation",
  },
  unknown: ENVIRONMENT_WORDS,
};

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
      ...KIND_WORDS[value.kind].fires(value.workspace),
      ...(webhookOf(value) === undefined
        ? [`Schedule: ${scheduleWords(scheduleOf(value))}`]
        : [`Webhook: ${sourceWords(value)}`, `Match: ${matchCard(webhookOf(value)?.match)}`]),
      `Options: ${optionsWords(value)}`,
      ...(value.paused ? ["Paused"] : []),
      `Message:\n${cardMessage(value.message)}`,
    ],
    "\n",
  );

const decodeExpected = Schema.decodeUnknownOption(TriggerChangeValue);

/** `trigger_create`'s owner for a Session trigger: this Session. */
const SESSION_OWNER = "session";

/** Why a Session trigger can't be made on a webhook. */
const SESSION_SCHEDULE_ONLY =
  "a Session trigger fires on a Schedule only: give a schedule, with no webhook or match. Webhook deliveries go to an Environment trigger or a Workspace trigger";

/** The kind of Trigger `trigger_create`'s `owner` asks for: an Environment's id is an Environment trigger's. */
const kindOfOwner = (owner: string): TriggerKind => {
  if (owner === WORKSPACE_OWNER) return "workspace";

  return owner === SESSION_OWNER ? "session" : "environment";
};

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

  /**
   * Where a Trigger of `kind` made by `owner` lives: its Environment's id, and the Workspace it keeps. A Workspace
   * trigger keeps this Session's own Workspace (the agent has no tool that lists others), and a Session trigger lives in
   * this Session's own Environment.
   */
  const homeOf = (kind: TriggerKind, owner: string) =>
    Effect.gen(function* () {
      if (kind === "workspace") {
        const { environment, ...workspace } = yield* access.workspace;

        return { environment, workspace };
      }

      if (kind === "session") {
        const own = yield* environments.current;

        if (own === null) {
          return yield* refuse("this Session has no Environment to keep a Trigger in");
        }

        return { environment: own, workspace: undefined };
      }

      return { environment: (yield* target(owner)).environment, workspace: undefined };
    });

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

  /** A Trigger's `match` held to what the Registry accepts and to plain text, asking nothing. */
  const plainMatch = (match: TriggerMatch) =>
    Effect.gen(function* () {
      yield* plainText(
        JSON.stringify(match),
        "the match",
        "A match names what to look for in a delivery: leave the Secret out of it.",
      );

      const problem = matchProblem(match);

      if (problem !== undefined) return yield* refuse(problem);

      // The card shows the whole match, or the owner would approve what they can't read.
      if (matchWords(match).length > MAX_CARD_CHARS) {
        return yield* refuse(
          `the match is longer than the ${String(MAX_CARD_CHARS)} characters the card shows: use fewer paths or values`,
        );
      }
    });

  /**
   * The source `trigger_create` was asked for: a Schedule or a webhook (with its `match`), exactly one of them, or a
   * refusal, asking nothing, of what the Registry would refuse.
   */
  const createSource = ({
    schedule,
    webhook,
    match,
  }: {
    readonly schedule: typeof Schedule.Type | undefined;
    readonly webhook: typeof Webhook.Type | undefined;
    readonly match: TriggerMatch | undefined;
  }) =>
    Effect.gen(function* () {
      if (schedule !== undefined && webhook === undefined) {
        if (match !== undefined) {
          return yield* refuse("a match filters a webhook's deliveries: a Schedule has none");
        }

        return yield* scheduleSource(schedule);
      }

      if (webhook === undefined || schedule !== undefined) {
        return yield* refuse("give either a schedule or a webhook, one of them");
      }

      if (match !== undefined) yield* plainMatch(match);

      const source: TriggerSourceInput = { type: "webhook", format: webhook.format };

      // An empty match is none, as the Trigger holds it.
      return match === undefined || Rec.isEmptyRecord(match) ? source : { ...source, match };
    });

  /** Trigger `id`, or a refusal naming the tool that lists them. */
  const found = (id: string) =>
    access.get(id).pipe(Effect.filterOrFail(Predicate.isNotNull, () => noTrigger(id)));

  /** The Environment `id`, by id and name (its id for one gone). */
  const environmentNamed = (id: string) =>
    Effect.map(environments.get(id), (details) => ({ id, name: details?.name ?? id }));

  /** The card's target for a Trigger of Environment `environment`, kept for `held`'s Workspace if it is a Workspace trigger's. */
  const targetOf = (environment: { readonly name: string }, held: Held) =>
    KIND_WORDS[held.kind].target(environment.name, held.workspace);

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
    read,
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
    /** The Trigger as the caller read it just now, which the change takes as the Trigger rather than reading it again. */
    readonly read?: TriggerDefinition | undefined;
  }) =>
    Effect.gen(function* () {
      const definition = read ?? (yield* found(id));
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
          target: targetOf(environment, definition),
          change,
          before: before(definition),
          after,
          reason,
          notice: `${change} "${definition.name}", ${targetOf(environment, definition)}`,
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
      "List the Triggers: what makes cloudpid act unattended. An Environment trigger fires on its Schedule or on a webhook, each Fire starting a new Session in a new Workspace of its Environment with the Trigger message; a Workspace trigger starts each Fire's Session in one Workspace, on its files and branch; a Session trigger (this Session's own, on a Schedule) sends the message into this Session's root conversation. Gives each one's id, name, kind, Environment, Workspace (a Workspace trigger's), Schedule or, for a webhook Trigger, its format and match (never its URL or Signing secret), options, whether it is paused, and its next Fires (none for a webhook Trigger); trigger_get gives one with its message.",
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
            `- ${definition.id}: "${definition.name}", ${KIND_WORDS[definition.kind].listed(definition.workspace)}Environment "${where.name}" (${where.id}), ${sourceWords(definition)}${definition.paused ? ", paused" : ""}`,
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
      "Get one Trigger: its name, kind (an Environment trigger, a Workspace trigger, or this Session's own Session trigger), Environment, Workspace (a Workspace trigger's), Trigger message, Schedule or, for a webhook Trigger, its format and match (never its URL or Signing secret), options, whether it is paused, and its next Fires (none for a webhook Trigger).",
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
                  KIND_WORDS[definition.kind].heading(
                    definition.id,
                    environment,
                    definition.workspace,
                  ),
                  triggerWords(triggerChangeValue(definition)),
                  webhookOf(definition) !== undefined
                    ? SECRETS_NOTE
                    : next.length === 0
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
        'Make a Trigger: on its Schedule, or on each webhook delivery to its URL that passes its match, cloudpid acts unattended. An Environment trigger (owner: the Environment\'s id) starts a new Session in a new Workspace of the Environment with the Trigger message (with the delivery\'s body, as untrusted content, for a webhook); a Workspace trigger (owner: "workspace") starts each one in this Session\'s own Workspace, on its files and branch, once no Session there is at work, and keeps that Workspace until it is removed; a Session trigger (owner: "session", on a Schedule only: no webhook or match) sends the Trigger message into this Session\'s root conversation, on its active branch, as a message of its own ("check CI every hour"). Use it when the user asks for recurring work, such as a weekly report, or for work on an event, such as a failed CI run (an Environment or Workspace trigger). Give a schedule or a webhook, not both. For a webhook, cloudpid makes the URL and the Signing secret and shows them only to the user, on the Trigger\'s page: tell the user to open it and set up the sender (you never see either). The user must approve it, as it acts on its own. Its kind, owner and Workspace never change: to move one, remove it and make another.',
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      owner: Id.annotate({
        description:
          'Whose Trigger it is: an Environment\'s id (each Fire starts a Session in a new Workspace of that Environment), "workspace" (this Session\'s own Workspace only: each Fire starts a Session in it, which then cannot be removed with its last Session while the Trigger exists), or "session" (this Session: each Fire sends the message into its root conversation, which carries on with its history, so say what to check as of then; it takes no base, model or thinking, and when_busy queue, steer or skip)',
      }),
      name: Schema.String.annotate({
        description: "1 to 80 characters, which titles each Fire's Session with the Fire's time",
      }),
      message: Message,
      schedule: Schema.optionalKey(Schedule),
      webhook: Schema.optionalKey(Webhook),
      match: Schema.optionalKey(Match),
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
    execute: (
      { owner, name, message, schedule, webhook, match, when_busy, base, model, thinking, reason },
      api,
    ) =>
      Effect.gen(function* () {
        yield* plainReason(reason);
        yield* plainText(name, "the name", "Name it without it.");
        yield* plainMessage(message);

        const source = yield* createSource({ schedule, webhook, match });
        const kind = kindOfOwner(owner);
        const words = KIND_WORDS[kind];

        // Before anything is read: a Session trigger has a Schedule only.
        if (kind === "session" && source.type !== "schedule") {
          return yield* refuse(SESSION_SCHEDULE_ONLY);
        }

        const problem =
          triggerNameProblem(name) ??
          (base !== undefined && base.trim() === "" ? "a base branch can't be empty" : undefined) ??
          (when_busy === undefined ? undefined : whenBusyProblem(kind, when_busy)) ??
          ownOptionsProblem(kind, { base, model, thinking });

        if (problem !== undefined) return yield* refuse(problem);

        // The Trigger's Environment, and for a Workspace trigger this Session's own Workspace (the agent has no tool that lists others).
        const home = yield* homeOf(kind, owner);
        const details = yield* environments.get(home.environment);

        if (details === null) {
          return yield* EnvironmentsError.make({
            message: `No Environment has the id ${JSON.stringify(home.environment)}. Call environment_list for the Environments and their ids.`,
          });
        }

        const environment = { id: details.id, name: details.name };
        const where = targetOf(environment, { kind, workspace: home.workspace });

        const input = words.input({
          environment: environment.id,
          workspace: home.workspace?.id,
          name: name.trim(),
          message,
          source,
        });

        // Refused above already; this narrows what `input` is for the kinds that take a Schedule only.
        if (input === undefined) return yield* refuse(SESSION_SCHEDULE_ONLY);

        const trigger: Types.Mutable<OwnTriggerInput> = input;

        // The Trigger as the card shows it: the options not given are their defaults.
        const value: Types.Mutable<TriggerChangeValue> = {
          kind,
          name: name.trim(),
          message,
          source,
          whenBusy: when_busy ?? defaultWhenBusy(kind, source),
          paused: false,
        };

        if (home.workspace !== undefined) value.workspace = home.workspace;

        if (when_busy !== undefined) trigger.whenBusy = when_busy;

        if (trigger.kind === "environment" && base !== undefined) {
          trigger.base = value.base = base.trim();
        }

        if (trigger.kind !== "session") {
          if (model !== undefined) trigger.model = value.model = model;

          if (thinking !== undefined) trigger.thinking = value.thinking = thinking;
        }

        const now = yield* Clock.currentTimeMillis;
        const drawn = yield* access.newId;

        return yield* withApproval(
          approvals,
          api,
          {
            tool: "trigger_create",
            target: where,
            change: "Create a Trigger",
            before: "None",
            after: triggerWords(value),
            reason,
            notice: `Create the Trigger "${trigger.name}", ${where}`,
            notes: [
              words.fireNote(environment.name, home.workspace),
              ...(source.type === "schedule"
                ? [nextFiresNote(source, now)]
                : [
                    source.match === undefined
                      ? "No match: every delivery that is signed right starts a Session."
                      : "Only deliveries that pass the match start a Session.",
                    "Its URL and Signing secret are made with it and shown only to the user, on its page.",
                  ]),
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
                  message: `The user approved, but ${where} is gone: nothing was made.`,
                });
              }

              return yield* outcome({
                tool: "trigger_create",
                id: asked.value.id,
                name: trigger.name,
                applied,
                approval: APPROVED,
                made: (definition) =>
                  `made the Trigger "${trigger.name}" (id ${asked.value.id}) in ${where}. ${definition === null ? "" : source.type === "schedule" ? `It fires ${scheduleWords(source)}; ${nextFiresNote(source, now)}.` : `It fires on each ${source.format} delivery to its URL that passes its match. ${SECRETS_NOTE} Tell the user to open the Trigger's page and set up the sender there.`} ${words.madeNote(value.whenBusy)}; the user is notified when its Run ends, or if a Fire fails. trigger_pause stops it at once.`,
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
        "Change a Schedule Trigger's Schedule: when it fires (a webhook Trigger has none: trigger_match_set changes its filter). The user must approve the change. Times due before the change are not caught up.",
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

        const held = yield* found(id);

        if (webhookOf(held) !== undefined) {
          return yield* refuse(
            "this Trigger fires on a webhook, which has no Schedule: trigger_match_set changes which deliveries it takes",
          );
        }

        const source = yield* scheduleSource(schedule);
        const now = yield* Clock.currentTimeMillis;

        return yield* approvedChange({
          tool: "trigger_schedule_set",
          id,
          reason,
          api,
          read: held,
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

  const matchSet = yield* defineEffectTool({
    name: "trigger_match_set",
    description: Arr.join(
      [
        "Change which deliveries a webhook Trigger takes: its match, the paths of a delivery's JSON body with the values they may have (every path must match, any one of a path's values will do; \"event\" is the event's name). A delivery that doesn't match is answered and counted, and starts nothing. null takes the match away, so every delivery that is signed right starts a Session. Only a webhook Trigger has a match. The user must approve the change.",
        APPROVAL,
      ],
      "\n\n",
    ),
    parameters: Schema.Struct({
      id: TriggerId,
      match: Schema.NullOr(Match),
      reason: Reason,
    }),
    structuredOutputSchema: outputSchema(TriggerChangeOutput),
    executionMode: "sequential",
    replay: "safe",
    execute: ({ id, match, reason }, api) =>
      Effect.gen(function* () {
        yield* plainReason(reason);

        if (match !== null) yield* plainMatch(match);

        const definition = yield* found(id);

        if (webhookOf(definition) === undefined) {
          return yield* refuse(
            scheduleOf(definition) === undefined
              ? "only a webhook Trigger has a match: this Trigger's source is one this version can't read"
              : "only a webhook Trigger has a match: this one fires on a Schedule",
          );
        }

        // The match as the Trigger holds it: none for an empty one.
        const wanted = match === null || Rec.isEmptyRecord(match) ? undefined : match;

        return yield* approvedChange({
          tool: "trigger_match_set",
          id,
          reason,
          api,
          read: definition,
          change: "Change a Trigger's match",
          same: (held) => matchKey(webhookOf(held)?.match) === matchKey(wanted),
          before: (held) => matchCard(webhookOf(held)?.match),
          after: matchWords(wanted),
          notes: () => [
            wanted === undefined
              ? "No match: every delivery that is signed right starts a Session."
              : "A delivery must pass every path, and any of a path's values will do.",
          ],
          apply: (expected, author) =>
            access.update({ id, patch: { match: wanted ?? null }, expected, author }),
          made: () =>
            `the Trigger's match is ${wanted === undefined ? "none" : matchWords(wanted)} now: deliveries that don't pass it are answered and counted, and start nothing.`,
          already: "The Trigger has that match already",
        });
      }),
  });

  const optionsSet = yield* defineEffectTool({
    name: "trigger_options_set",
    description: Arr.join(
      [
        "Change a Trigger's options, each where its kind takes it: when_busy, base, model and thinking (an Environment trigger takes all four; a Workspace trigger takes when_busy, model and thinking, and no base; a Session trigger takes only when_busy). Give only those to change; null puts base, model or thinking back to its default. The user must approve the change.",
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
        if (definition.kind === "unknown") {
          return yield* refuse("this version can't change the options of this Trigger's kind");
        }

        const optionProblem =
          (when_busy === undefined ? undefined : whenBusyProblem(definition.kind, when_busy)) ??
          ownOptionsProblem(definition.kind, { base, model, thinking });

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

        // What it was not caught up on: the times a Schedule missed, the deliveries a webhook was sent.
        const missed =
          webhookOf(definition) !== undefined
            ? "Deliveries that arrived while it was paused are not caught up."
            : schedule === undefined
              ? ""
              : "The times it missed while paused are not caught up.";

        return yield* approvedChange({
          tool: "trigger_resume",
          id,
          reason,
          api,
          read: definition,
          change: "Resume a Trigger",
          same: (held) => !held.paused,
          before: () => "Paused",
          after: `Active: fires ${sourceWords(definition)}`,
          notes: () => (schedule === undefined ? [] : [nextFiresNote(schedule, now)]),
          apply: (expected, author) => access.setPaused({ id, paused: false, expected, author }),
          made: () =>
            `the Trigger is active again${schedule === undefined ? "" : `; ${nextFiresNote(schedule, now)}`}.${missed === "" ? "" : ` ${missed}`}`,
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
      "Remove a Trigger: it never fires again, and its fire log goes with it. It applies at once, with no Approval; the user can revert it on the Environments page, which brings the Trigger back (a webhook Trigger with a new URL and Signing secret, which the user pastes again where the old ones were used).",
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
    tools: [
      list,
      get,
      create,
      messageSet,
      scheduleSet,
      matchSet,
      optionsSet,
      pause,
      resume,
      remove,
    ],
  });
});
