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
 * Environment. Workspace and Session triggers are later slices' members.
 */
export const TriggerKind = openLiterals(Schema.Literals(["environment", "unknown"]), "unknown");

export type TriggerKind = typeof TriggerKind.Type;

/** A Schedule source: 5-field cron in an IANA zone (`./trigger-schedule.ts`). */
export const ScheduleSource = Schema.Struct({
  type: Schema.Literal("schedule"),
  cron: Schema.String,
  zone: Schema.String,
});

export type ScheduleSource = typeof ScheduleSource.Type;

/** A source this version does not know (a later slice's webhook, say): its Trigger is listed, and never fired here. */
export const UnknownSource = Schema.Struct({ type: Schema.Literal("unknown") });

/** What makes a Trigger fire. */
export const TriggerSource = Schema.Union([ScheduleSource, UnknownSource]).pipe(
  Schema.catchDecoding(() => Effect.succeedSome({ type: "unknown" as const })),
);

export type TriggerSource = typeof TriggerSource.Type;

/** The Schedule `holder` fires on, or undefined for none (a source this version doesn't know). */
export const scheduleOf = (
  holder: { readonly source: TriggerSource } | undefined,
): ScheduleSource | undefined => (holder?.source.type === "schedule" ? holder.source : undefined);

/**
 * What a Fire does while the last Fire's Session is still running or waiting for the owner (`triggers.md` → Overlap):
 * `skip` records it `skipped: overlap`, `start` starts its Session anyway. A value a later kind adds reads as `skip`.
 */
export const TriggerWhenBusy = openLiterals(Schema.Literals(["skip", "start"]), "skip");

export type TriggerWhenBusy = typeof TriggerWhenBusy.Type;

/** A Trigger as the Registry keeps it, at `revision`, which every change raises. */
export const TriggerDefinition = Schema.Struct({
  id: Schema.String,
  revision: Schema.Int,
  kind: TriggerKind,
  /** The Environment it belongs to: an Environment trigger's own, and the Scope its Agent changes are recorded under. */
  environment: Schema.String,
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
  source: ScheduleSource,
  /** `skip` when absent, a Schedule's default (`triggers.md` → Overlap). */
  whenBusy: Schema.optional(TriggerWhenBusy),
  base: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  thinking: Schema.optional(ThinkingLevel),
  paused: Schema.optional(Schema.Boolean),
});

export type EnvironmentTriggerInput = typeof EnvironmentTriggerInput.Type;

/**
 * A change of a Trigger's fields: each absent field is kept, and an option set to null goes back to its default. A
 * Trigger's kind and Environment are fixed at creation, so no change names them.
 */
export const TriggerPatch = Schema.Struct({
  name: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  source: Schema.optional(ScheduleSource),
  whenBusy: Schema.optional(TriggerWhenBusy),
  base: Schema.NullOr(Schema.String).pipe(Schema.optional),
  model: Schema.NullOr(Schema.String).pipe(Schema.optional),
  thinking: Schema.NullOr(ThinkingLevel).pipe(Schema.optional),
});

export type TriggerPatch = typeof TriggerPatch.Type;

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

/** What made a Fire: a Schedule's time coming due, or the owner's **Fire now** (`manual`). */
export const FireSource = Schema.Union([
  Schema.Struct({ type: Schema.Literal("schedule"), scheduledAt: Schema.Finite }),
  Schema.Struct({ type: Schema.Literal("manual") }),
  Schema.Struct({ type: Schema.Literal("unknown") }),
]).pipe(Schema.catchDecoding(() => Effect.succeedSome({ type: "unknown" as const })));

export type FireSource = typeof FireSource.Type;

/**
 * Why a Fire was skipped: `overlap`, `missed`, or `paused` (its Trigger was paused before it went out); a later slice
 * adds `coalesced`, `archived` and `importing`.
 */
export const FireSkip = openLiterals(
  Schema.Literals(["overlap", "missed", "paused", "unknown"]),
  "unknown",
);

export type FireSkip = typeof FireSkip.Type;

/** What came of a Fire: `started <session>`, `skipped: <why>` or `failed: <reason>`. */
export const FireOutcome = Schema.Union([
  Schema.Struct({ type: Schema.Literal("started"), session: Schema.String }),
  Schema.Struct({ type: Schema.Literal("skipped"), reason: FireSkip }),
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
});

export type TriggerOverview = typeof TriggerOverview.Type;

/** What the owner's Fire now answers: the Fire's key, which its fire log records once it went out. */
export const FireNowQueued = Schema.Struct({ key: Schema.String });

export type FireNowQueued = typeof FireNowQueued.Type;

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

/** What cloudpid's header of a Fire's message says: the Trigger's name, and its scheduled (if any) and actual time. */
export const FireHeader = Schema.Struct({
  name: Schema.String,
  zone: Schema.String,
  /** The Schedule's time the Fire is for; absent for the owner's Fire now. */
  scheduledAt: Schema.optionalKey(Schema.Finite),
  firedAt: Schema.Finite,
});

export type FireHeader = typeof FireHeader.Type;

/** cloudpid's header of a Fire's message, before the Trigger message (`triggers.md` → Payload and untrusted content). */
export const renderFireHeader = (header: FireHeader): string => {
  const at = (time: number) => fireTimeWords(time, header.zone);

  return Arr.join(
    [
      `[cloudpid] Trigger "${header.name.trim()}" fired.`,
      header.scheduledAt === undefined
        ? "Source: the owner's Fire now."
        : `Scheduled for: ${at(header.scheduledAt)}.`,
      `Fired at: ${at(header.firedAt)}.`,
    ],
    "\n",
  );
};

/** A Fire's message as its Session is given it: cloudpid's header, then the Trigger message as written. */
export const fireText = (header: FireHeader, message: string): string =>
  `${renderFireHeader(header)}\n\n${message}`;

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
  model: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(ThinkingLevel),
});

export type FireRequest = typeof FireRequest.Type;
