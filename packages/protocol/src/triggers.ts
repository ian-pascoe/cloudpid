// Triggers (`docs/architecture/triggers.md`, ADR-0047): a definition the Registry keeps at a revision number, the Fires
// its `Trigger` object records, and the words a Fire's Session is given. Every union here is one a later slice extends
// (a kind, a source, an outcome), so each reads a member it does not know as a fallback (`docs/development/workers.md` →
// Bindings).
// @effect-diagnostics globalDate:off missingPipeableSignature:off -- plain functions that format times in a zone.
import { ThinkingLevel } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { MAX_MCP_INPUT_BYTES, TriggerMark } from "./mcp-api.ts";
import type { AgentChange, EnvironmentRef } from "./registry.ts";
import { openLiterals } from "./open-literals.ts";
import { scheduleProblem } from "./trigger-schedule.ts";
import { matchProblem, TriggerMatch } from "./trigger-match.ts";
import { FirePayload, WebhookFormat } from "./trigger-payload.ts";

/** The longest Trigger name, in characters after trimming. */
export const MAX_TRIGGER_NAME_LENGTH = 80;

/** How many Fires a Trigger's fire log keeps, the latest. */
export const MAX_FIRE_LOG = 1000;

/** Why `name` can't name a Trigger, or undefined when it can. */
export const triggerNameProblem = (name: string): string | undefined => {
  const trimmed = name.trim();

  if (trimmed === "") return "A Trigger needs a name";

  return trimmed.length > MAX_TRIGGER_NAME_LENGTH
    ? `A Trigger's name has at most ${String(MAX_TRIGGER_NAME_LENGTH)} characters`
    : undefined;
};

/** The longest Trigger message, in bytes of UTF-8: as long as any input (`docs/architecture/mcp-endpoint.md` → Limits). */
export const MAX_TRIGGER_MESSAGE_BYTES = MAX_MCP_INPUT_BYTES;

/** Why `message` can't be a Trigger message, or undefined when it can. */
export const triggerMessageProblem = (message: string): string | undefined => {
  if (message.trim() === "") return "A Trigger needs a message to send";

  return new TextEncoder().encode(message).length > MAX_TRIGGER_MESSAGE_BYTES
    ? `A Trigger message has at most ${String(MAX_TRIGGER_MESSAGE_BYTES)} bytes: put the rest in a file in a Repo`
    : undefined;
};

/**
 * What keeps a Trigger, and so what each Fire does: an Environment trigger starts a new Session in a new Workspace of its
 * Environment, a Workspace trigger one in its Workspace. Session triggers are a later slice's member.
 */
export const TriggerKind = openLiterals(
  Schema.Literals(["environment", "workspace", "unknown"]),
  "unknown",
);

export type TriggerKind = typeof TriggerKind.Type;

/** A Schedule source: 5-field cron in an IANA zone (`./trigger-schedule.ts`). */
export const ScheduleSource = Schema.Struct({
  type: Schema.Literal("schedule"),
  cron: Schema.String,
  zone: Schema.String,
});

export type ScheduleSource = typeof ScheduleSource.Type;

/**
 * A webhook source: deliveries to the Trigger's URL, signed in `format`, and passed on only when they match `match`
 * (`docs/architecture/triggers.md` → Webhooks, Filters). The URL and Signing secret are the Trigger object's alone, never
 * part of the definition.
 */
export const WebhookSource = Schema.Struct({
  type: Schema.Literal("webhook"),
  format: WebhookFormat,
  match: Schema.optionalKey(TriggerMatch),
});

export type WebhookSource = typeof WebhookSource.Type;

/** A source this version does not know (a later slice's, say): its Trigger is listed, and never fired here. */
export const UnknownSource = Schema.Struct({ type: Schema.Literal("unknown") });

/** What makes a Trigger fire. */
export const TriggerSource = Schema.Union([ScheduleSource, WebhookSource, UnknownSource]).pipe(
  Schema.catchDecoding(() => Effect.succeedSome({ type: "unknown" as const })),
);

export type TriggerSource = typeof TriggerSource.Type;

/** The sources the owner's form and `trigger_create` can give a Trigger. */
export const TriggerSourceInput = Schema.Union([ScheduleSource, WebhookSource]);

export type TriggerSourceInput = typeof TriggerSourceInput.Type;

/** Why `source` can't make a Trigger fire, or undefined when it can. */
export const sourceProblem = (source: TriggerSourceInput): string | undefined =>
  source.type === "schedule"
    ? scheduleProblem(source)
    : source.match === undefined
      ? undefined
      : matchProblem(source.match);

/** The webhook `holder` fires on, or undefined for none. */
export const webhookOf = (
  holder: { readonly source: TriggerSource } | undefined,
): WebhookSource | undefined => (holder?.source.type === "webhook" ? holder.source : undefined);

/** The Schedule `holder` fires on, or undefined for none (a source this version doesn't know). */
export const scheduleOf = (
  holder: { readonly source: TriggerSource } | undefined,
): ScheduleSource | undefined => (holder?.source.type === "schedule" ? holder.source : undefined);

/**
 * What a Fire does while the work of the last one is still going on (`triggers.md` → Overlap): `skip` records it
 * `skipped: overlap`, `start` starts its Session anyway, and `wait` (a Workspace trigger's, its default) keeps it pending
 * until the Workspace is idle. A value a later kind adds reads as `skip`.
 */
export const TriggerWhenBusy = openLiterals(Schema.Literals(["skip", "start", "wait"]), "skip");

export type TriggerWhenBusy = typeof TriggerWhenBusy.Type;

/**
 * What a Trigger of `kind` on `source` does by default while busy: a Workspace trigger waits; an Environment trigger skips
 * for a Schedule and starts for a webhook, whose deliveries are each their own event.
 */
export const defaultWhenBusy = (kind: TriggerKind, source: TriggerSourceInput): TriggerWhenBusy => {
  if (kind === "workspace") return "wait";

  return source.type === "webhook" ? "start" : "skip";
};

/** Why a Trigger of `kind` can't take `whenBusy`, or undefined when it can: only a Workspace trigger waits. */
export const whenBusyProblem = (kind: TriggerKind, whenBusy: string): string | undefined =>
  whenBusy === "wait" && kind !== "workspace"
    ? "Only a Workspace trigger can wait for a busy Workspace"
    : undefined;

/** Why a Trigger of `kind` can't take `base`, or undefined when it can: a Workspace trigger works on its Workspace's branch. */
export const baseProblem = (
  kind: TriggerKind,
  base: string | null | undefined,
): string | undefined =>
  kind === "workspace" && base !== null && base !== undefined
    ? "A Workspace trigger works on its Workspace's branch: it takes no base"
    : undefined;

/** A Workspace as a Trigger names it: its id, and its branch, which is how the owner reads it. */
export const WorkspaceRef = Schema.Struct({ id: Schema.String, branch: Schema.String });

export type WorkspaceRef = typeof WorkspaceRef.Type;

/** A Trigger as the Registry keeps it, at `revision`, which every change raises. */
export const TriggerDefinition = Schema.Struct({
  id: Schema.String,
  revision: Schema.Int,
  kind: TriggerKind,
  /** The Environment it belongs to: an Environment trigger's own, and the Scope its Agent changes are recorded under. */
  environment: Schema.String,
  /** The Workspace a Workspace trigger is kept for, which it keeps; absent for the other kinds. */
  workspace: Schema.optionalKey(WorkspaceRef),
  name: Schema.String,
  /** The Trigger message, as written: the owner's words, or the agent's the owner approved. */
  message: Schema.String,
  source: TriggerSource,
  whenBusy: TriggerWhenBusy,
  /** The branch each Fire's Workspace starts from (an Environment trigger's); absent: each Repo's default branch. */
  base: Schema.optionalKey(Schema.String),
  /** The model and thinking level of each Fire's Session; absent: the Environment's Settings at the Fire. */
  model: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(ThinkingLevel),
  paused: Schema.Boolean,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
});

export type TriggerDefinition = typeof TriggerDefinition.Type;

/** A new Environment trigger, as the owner's form or `trigger_create` gives it. */
export const EnvironmentTriggerInput = Schema.Struct({
  kind: Schema.Literal("environment"),
  environment: Schema.String,
  name: Schema.String,
  message: Schema.String,
  source: TriggerSourceInput,
  /** When absent: `skip` for a Schedule, `start` for a webhook (`triggers.md` → Overlap). */
  whenBusy: TriggerWhenBusy.pipe(Schema.optional),
  base: Schema.String.pipe(Schema.optional),
  model: Schema.String.pipe(Schema.optional),
  thinking: ThinkingLevel.pipe(Schema.optional),
  paused: Schema.Boolean.pipe(Schema.optional),
});

export type EnvironmentTriggerInput = typeof EnvironmentTriggerInput.Type;

/**
 * A new Workspace trigger: kept for Workspace `workspace` (an Environment's Workspace a Session works in: a Subagent
 * Workspace and a spare are refused), whose Environment it takes. It holds no `base` and no Role.
 */
export const WorkspaceTriggerInput = Schema.Struct({
  kind: Schema.Literal("workspace"),
  workspace: Schema.String,
  name: Schema.String,
  message: Schema.String,
  source: TriggerSourceInput,
  /** `wait` when absent, a Workspace trigger's default (`triggers.md` → Overlap). */
  whenBusy: TriggerWhenBusy.pipe(Schema.optional),
  model: Schema.String.pipe(Schema.optional),
  thinking: ThinkingLevel.pipe(Schema.optional),
  paused: Schema.Boolean.pipe(Schema.optional),
});

export type WorkspaceTriggerInput = typeof WorkspaceTriggerInput.Type;

/** A new Trigger of any kind the owner's form or `trigger_create` makes. */
export const TriggerInput = Schema.Union([EnvironmentTriggerInput, WorkspaceTriggerInput]);

export type TriggerInput = typeof TriggerInput.Type;

/**
 * A change of a Trigger's fields: each absent field is kept, and an option set to null goes back to its default. A
 * Trigger's kind and Environment are fixed at creation, so no change names them.
 */
export const TriggerPatch = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  message: Schema.String.pipe(Schema.optional),
  source: TriggerSourceInput.pipe(Schema.optional),
  /** A webhook Trigger's `match` alone (null: none); a Trigger with another source refuses it. */
  match: Schema.NullOr(TriggerMatch).pipe(Schema.optional),
  whenBusy: TriggerWhenBusy.pipe(Schema.optional),
  base: Schema.NullOr(Schema.String).pipe(Schema.optional),
  model: Schema.NullOr(Schema.String).pipe(Schema.optional),
  thinking: Schema.NullOr(ThinkingLevel).pipe(Schema.optional),
});

export type TriggerPatch = typeof TriggerPatch.Type;

/** An id or key a client draws for a Trigger or a Fire now (a UUID, say): what makes its retry one call. */
export const TriggerKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,64}$/));

/**
 * The owner's Trigger was saved (made, resumed), but its object never answered, so it isn't scheduled yet: pausing and
 * resuming it tries again.
 */
export class TriggerUnscheduled extends Schema.TaggedError<
  TriggerUnscheduled,
  { readonly brand: unique symbol }
>()("TriggerUnscheduled", {
  message: Schema.String,
}) {}

const TRIGGER_FIELD = "triggers.";

/** The field of Trigger `id`'s Agent changes, recorded under its Environment's Scope (`triggers.md` → Agent tools). */
export const triggerField = (id: string): string => `${TRIGGER_FIELD}${id}`;

/** The Trigger an Agent change's `field` is of, or null for a field that is not a Trigger's. */
export const fieldTrigger = (field: string): string | null =>
  field.startsWith(TRIGGER_FIELD) ? field.slice(TRIGGER_FIELD.length) : null;

/**
 * A Trigger as its Agent changes record it, before and after (null: none, as before its creation or after its
 * removal): what the owner reads and a revert puts back, without its id, Environment, revision or times.
 */
export const TriggerChangeValue = Schema.Struct({
  kind: TriggerKind,
  /** The Workspace a Workspace trigger keeps, by id and branch. */
  workspace: Schema.optionalKey(WorkspaceRef),
  name: Schema.String,
  message: Schema.String,
  source: TriggerSource,
  whenBusy: TriggerWhenBusy,
  base: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(ThinkingLevel),
  paused: Schema.Boolean,
});

export type TriggerChangeValue = typeof TriggerChangeValue.Type;

/** `definition` as its Agent changes record it. */
export const triggerChangeValue = ({
  id: _id,
  revision: _revision,
  environment: _environment,
  createdAt: _createdAt,
  updatedAt: _updatedAt,
  ...value
}: TriggerDefinition): TriggerChangeValue => value;

const sameChangeValue = Schema.toEquivalence(TriggerChangeValue);

/**
 * Whether `definition` still has the fields an editor opened on (`expected`), whether it is paused aside: a pause or
 * resume meanwhile is not a change of what the editor edits.
 */
export const holdsEditedFields = (
  definition: TriggerDefinition,
  expected: TriggerChangeValue,
): boolean =>
  sameChangeValue(
    { ...triggerChangeValue(definition), paused: false },
    { ...expected, paused: false },
  );

/** `definition` as its Agent changes record it, as JSON (null: none, before its creation or after its removal). */
export const triggerChangeJson = (definition: TriggerDefinition | null): Schema.Json | null =>
  definition === null ? null : asChangeJson(triggerChangeValue(definition));

/** A Trigger's value as the JSON its Agent change records and its Approval request keeps. */
// SAFETY: a Trigger's value is plain JSON, its optional keys left out when absent.
export const asChangeJson = (value: TriggerChangeValue): Schema.Json => value as Schema.Json;

const decodeChangeValue = Schema.decodeUnknownOption(TriggerChangeValue);

/**
 * Whether a Trigger change from `before` to `after` (as its Agent change records them) leaves an active Trigger that had
 * no alarm: one made, brought back or resumed. Its object must be woken to schedule it, since nothing else will.
 */
export const armsTrigger = (before: Schema.Json | null, after: Schema.Json | null): boolean => {
  const now = decodeChangeValue(after);

  if (Option.isNone(now) || now.value.paused) return false;

  return Option.match(decodeChangeValue(before), {
    onNone: () => true,
    onSome: (was) => was.paused,
  });
};

/** How the agent's change of a Trigger went, as the Registry answers it. */
export type TriggerChanged =
  | {
      readonly status: "changed";
      /** The Trigger after the change; null once removed. */
      readonly definition: TriggerDefinition | null;
      /** Its Environment, whose history records the change. */
      readonly environment: EnvironmentRef;
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
 * What made a Fire: a Schedule's time coming due, a webhook delivery (its id, and its event), or the owner's **Fire now**
 * or **Fire again** (`manual`).
 */
export const FireSource = Schema.Union([
  Schema.Struct({ type: Schema.Literal("schedule"), scheduledAt: Schema.Finite }),
  Schema.Struct({
    type: Schema.Literal("webhook"),
    delivery: Schema.String,
    event: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("manual") }),
  Schema.Struct({ type: Schema.Literal("unknown") }),
]).pipe(Schema.catchDecoding(() => Effect.succeedSome({ type: "unknown" as const })));

export type FireSource = typeof FireSource.Type;

/**
 * Why a Fire was skipped: `overlap`, `missed`, `paused` (its Trigger was paused before it went out), or `coalesced` (a
 * Workspace trigger's Fire that came while another waited, merged into it); a later slice adds `archived` and `importing`.
 */
export const FireSkip = openLiterals(
  Schema.Literals(["overlap", "missed", "paused", "coalesced", "unknown"]),
  "unknown",
);

export type FireSkip = typeof FireSkip.Type;

/** What came of a Fire: `started <session>`, `skipped: <why>` or `failed: <reason>`. */
export const FireOutcome = Schema.Union([
  Schema.Struct({ type: Schema.Literal("started"), session: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("skipped"),
    reason: FireSkip,
    /** For a waiting Fire skipped for good: how many later Fires were merged into it, which are lost with it. */
    merged: Schema.optionalKey(Schema.Int),
  }),
  Schema.Struct({ type: Schema.Literal("failed"), reason: Schema.String }),
  Schema.Struct({ type: Schema.Literal("unknown") }),
]).pipe(Schema.catchDecoding(() => Effect.succeedSome({ type: "unknown" as const })));

export type FireOutcome = typeof FireOutcome.Type;

/** One row of a Trigger's fire log: its key, when it was settled, what made it and what came of it. */
export const FireRecord = Schema.Struct({
  key: Schema.String,
  at: Schema.Finite,
  source: FireSource,
  outcome: FireOutcome,
});

export type FireRecord = typeof FireRecord.Type;

/**
 * A Trigger as the owner's Settings list it: its definition, and its last Fire as its object records it (`reached`
 * false: the object didn't answer, so its last Fire is unknown rather than none).
 */
export const TriggerOverview = Schema.Struct({
  definition: TriggerDefinition,
  lastFire: Schema.NullOr(FireRecord),
  reached: Schema.Boolean,
  /**
   * The Fire of a Workspace trigger waiting for its Workspace to be idle, when there is one: when it was queued and how
   * many later Fires were merged into it. Absent for none, and from a server that doesn't say.
   */
  waiting: Schema.optionalKey(Schema.Struct({ since: Schema.Finite, merged: Schema.Int })),
});

export type TriggerOverview = typeof TriggerOverview.Type;

/** What the owner's Fire now answers: the Fire's key, which its fire log records once it went out. */
export const FireNowQueued = Schema.Struct({ key: Schema.String });

export type FireNowQueued = typeof FireNowQueued.Type;

/**
 * A webhook Trigger's URL and Signing secret, as the owner reveals them (`triggers.md` → Secrets): the URL's `path`
 * (`/hooks/<id>/<token>`), and the stage's `origin` before it, absent where the page's own is the one (`alchemy dev`).
 * The `secret` is as the sender is given it: `whsec_<base64>` for a `standard` Trigger, else the key itself. The agent
 * never reads this.
 */
export const TriggerHook = Schema.Struct({
  origin: Schema.optionalKey(Schema.String),
  path: Schema.String,
  secret: Schema.String,
});

export type TriggerHook = typeof TriggerHook.Type;

/** Which of a webhook Trigger's two secrets the owner replaces: its URL's token, or its Signing secret. */
export const TriggerRotation = Schema.Literals(["url", "secret"]);

export type TriggerRotation = typeof TriggerRotation.Type;

/**
 * How many deliveries a Trigger refused or filtered on one UTC `day` (`YYYY-MM-DD`), by `outcome`: one of
 * `DELIVERY_OUTCOMES` but `accepted` and `ping`, or one a later version names.
 */
export const TriggerDeliveryCount = Schema.Struct({
  day: Schema.String,
  outcome: Schema.String,
  n: Schema.Int,
});

export type TriggerDeliveryCount = typeof TriggerDeliveryCount.Type;

/**
 * What a webhook Trigger says of its deliveries (`triggers.md` → The owner's UI): the counts of the last 30 days, the
 * time of the last authentic delivery, and GitHub's last ping.
 */
export const TriggerDeliveries = Schema.Struct({
  counts: Schema.Array(TriggerDeliveryCount),
  lastDeliveryAt: Schema.NullOr(Schema.Finite),
  pingAt: Schema.NullOr(Schema.Finite),
});

export type TriggerDeliveries = typeof TriggerDeliveries.Type;

/**
 * A Fire's key, the `requestId` of its Session's `createSession` and `fire`: `<trigger>:<scheduled time>` for a
 * Schedule, so a retried alarm never starts a second Session (`triggers.md` → Pending Fires).
 */
export const scheduledFireKey = (trigger: string, scheduledAt: number): string =>
  `${trigger}:${new Date(scheduledAt).toISOString()}`;

/** A time as the owner reads it in `zone`, with the narrow spaces some ICU builds put before AM/PM made plain. */
const formatIn = (zone: string, at: number, options: Intl.DateTimeFormatOptions): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: zone, ...options })
    .format(new Date(at))
    .replaceAll("\u202f", " ");

const DATE_TIME: Intl.DateTimeFormatOptions = {
  weekday: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
};

/** A Fire's time as the owner reads it in `zone`, with the zone's short name: "Mon, Nov 9, 2026, 9:00 AM CST". */
export const fireTimeWords = (at: number, zone: string): string =>
  formatIn(zone, at, { ...DATE_TIME, timeZoneName: "short" });

/** The title of the Session a Fire starts, "`<name>` · `<date, time>`" in the Trigger's zone: never generated. */
export const fireTitle = (name: string, at: number, zone: string): string =>
  `${name.trim()} · ${formatIn(zone, at, DATE_TIME)}`;

/**
 * The title of the Session a webhook's Fire starts, "`<name>` · `<event>` · `<date, time> UTC`": never generated. A
 * webhook has no zone, so the time is UTC, which the title says. `event` is the sender's word, made plain by the
 * caller (`senderText`).
 */
export const webhookFireTitle = (name: string, at: number, event: string): string =>
  `${name.trim()} · ${event} · ${formatIn("UTC", at, { ...DATE_TIME, timeZoneName: "short" })}`;

/** What cloudpid's header of a Fire's message says: the Trigger's name, and its scheduled (if any) and actual time. */
export const FireHeader = Schema.Struct({
  name: Schema.String,
  zone: Schema.String,
  /** The Schedule's time the Fire is for; absent for the owner's Fire now. */
  scheduledAt: Schema.optionalKey(Schema.Finite),
  firedAt: Schema.Finite,
  /** The owner sent the last delivery again (**Fire again**). */
  again: Schema.optionalKey(Schema.Boolean),
  /** How many more Fires came in while this one waited for its Workspace to be idle (`coalesced`); absent for none. */
  coalesced: Schema.optionalKey(Schema.Int),
});

export type FireHeader = typeof FireHeader.Type;

/** The line of a webhook Fire's header that says where it came from: the format, the event (and its action) and the delivery id. */
const webhookLine = (payload: FirePayload, again: boolean): string => {
  const event =
    payload.event === undefined
      ? ""
      : `, event ${payload.event}${payload.action === undefined ? "" : ` (action ${payload.action})`}`;

  return `Source: a ${payload.format} webhook${event}, delivery ${payload.delivery}${again ? ", sent again by the owner from the last delivery" : ""}.`;
};

/**
 * cloudpid's header of a Fire's message, before the Trigger message (`triggers.md` → Payload and untrusted content).
 * With a `payload` (its sender's words made plain: `cleanPayload`) it says where the delivery came from; its body is not
 * here but in a block after the message.
 */
export const renderFireHeader = (header: FireHeader, payload?: FirePayload): string => {
  const at = (time: number) => fireTimeWords(time, header.zone);

  const source =
    payload !== undefined
      ? webhookLine(payload, header.again === true)
      : header.scheduledAt === undefined
        ? "Source: the owner's Fire now."
        : `Scheduled for: ${at(header.scheduledAt)}.`;

  return Arr.join(
    [
      `[cloudpid] Trigger "${header.name.trim()}" fired.`,
      source,
      `Fired at: ${at(header.firedAt)}.`,
      ...(header.coalesced === undefined || header.coalesced < 1
        ? []
        : [
            `${String(header.coalesced)} more ${header.coalesced === 1 ? "Fire" : "Fires"} of this Trigger came in while this one waited for the Workspace to be idle, and ${header.coalesced === 1 ? "was" : "were"} merged into it. Check the current state before you act.`,
          ]),
    ],
    "\n",
  );
};

/** A Fire's message as its Session is given it: cloudpid's header, then the Trigger message as written. */
export const fireText = (header: FireHeader, message: string, payload?: FirePayload): string =>
  `${renderFireHeader(header, payload)}\n\n${message}`;

/**
 * The Session's `fire` argument (`docs/architecture/triggers.md` → Pending Fires): a new method, never a field on
 * `submit`, so a Session on older code fails loudly rather than take the Trigger message as the owner's own words.
 * `requestId` is the Fire's key: the same Fire sent again finds its first input. `model` and `thinking` pick the
 * Session's model and thinking level at its first Fire.
 */
export const FireRequest = Schema.Struct({
  trigger: TriggerMark,
  requestId: Schema.String,
  message: Schema.String,
  header: FireHeader,
  /** A webhook delivery's body and where it came from: fenced after the message, and its whole body kept as a file. */
  payload: Schema.optionalKey(FirePayload),
  model: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(ThinkingLevel),
});

export type FireRequest = typeof FireRequest.Type;

/**
 * How a delivery to a Trigger URL came out (`triggers.md` → Observability): `accepted` (a pending Fire stored), `filtered`
 * (by `match` or the bot-loop guard), `unauthorized` (no or a wrong signature, a stale timestamp), `too_large`,
 * `unsupported` (content type), `not_found` (an unknown id, a wrong token) and `ping`.
 */
export const DELIVERY_OUTCOMES = [
  "accepted",
  "filtered",
  "unauthorized",
  "too_large",
  "unsupported",
  "not_found",
  "ping",
] as const;

export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];
