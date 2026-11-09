// @effect-diagnostics missingPipeableSignature:off preferEffectRecord:off preferEffectArray:off -- plain functions over a Trigger and its form, not combinators; a match's paths are the sender's own keys.

// The Settings page's Triggers section, as values (`docs/architecture/triggers.md` → The owner's UI): the form that makes
// or edits an Environment trigger, or a Workspace trigger (its name, message, Schedule with the next Fires it gives,
// and options), what it sends the Registry, and the words a Trigger's row and its fire log show.

import {
  defaultWhenBusy,
  type EnvironmentTriggerInput,
  type FireOutcome,
  type FireRecord,
  type FireSkip,
  fireTimeWords,
  nextFires,
  scheduleOf,
  type ScheduleSource,
  webhookOf,
  scheduleProblem,
  type TriggerDefinition,
  type OwnerTriggerInput,
  type TriggerDeliveries,
  type TriggerHook,
  matchProblem,
  type TriggerMatch,
  type TriggerSourceInput,
  type WebhookFormat,
  type TriggerKind,
  triggerMessageProblem,
  triggerNameProblem,
  type TriggerPatch,
  type TriggerWhenBusy,
  takesBase,
  whenBusyValues,
  type WorkspaceTriggerInput,
} from "@cloudpid/protocol";
import { ThinkingLevel } from "@cloudpid/config";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";

/** How many next Fires the form previews. */
export const PREVIEWED_FIRES = 5;

/**
 * One row of a webhook Trigger's `match` as typed: a path of the delivery's body and the values it may have there, one
 * to a line.
 */
export type MatchRow = { readonly path: string; readonly values: string };

/**
 * What is typed in the Trigger form. An option left empty is the Environment's own (`base`: each Repo's default).
 * `scheduled` says the Trigger fires on a Schedule (a new one does), so the form asks for `cron` and `zone`; else it
 * fires on a webhook, signed in `format`, whose deliveries must pass the `match` rows. A Trigger's source type and format
 * are fixed at creation, so editing a webhook Trigger sends only its `match`. A Workspace trigger's form names its
 * Workspace (`workspace`, by id) and has no `base`.
 */
export type TriggerDraft = {
  /**
   * The kind of Trigger edited. A new one is an Environment trigger's, or a Workspace trigger's when it names a
   * Workspace; a Session trigger's form has no base, model or thinking.
   */
  readonly kind: TriggerKind;
  readonly environment: string;
  readonly scheduled: boolean;
  /** The Workspace a Workspace trigger is kept for; null for an Environment trigger. */
  readonly workspace: string | null;
  readonly name: string;
  readonly message: string;
  readonly cron: string;
  readonly zone: string;
  readonly format: WebhookFormat;
  readonly match: ReadonlyArray<MatchRow>;
  readonly whenBusy: TriggerWhenBusy;
  readonly base: string;
  readonly model: string;
  readonly thinking: string;
};

/**
 * Stands in for the source of a new draft, which is always a Schedule, to pick `defaultWhenBusy` (and the form's first
 * `when_busy` choice) before any cron is typed.
 */
const SCHEDULE_DEFAULT: ScheduleSource = { type: "schedule", cron: "", zone: "" };

/** The source a new draft switched to a webhook has, to pick `defaultWhenBusy`. */
const WEBHOOK_DEFAULT: TriggerSourceInput = { type: "webhook", format: "github" };

/**
 * An empty form for a Trigger of `environment`, its zone `zone` (the browser's): a Workspace trigger's when `workspace`
 * names its Workspace, which waits when busy by default.
 */
export const emptyTriggerDraft = (
  environment: string,
  zone: string,
  workspace: string | null = null,
): TriggerDraft => ({
  kind: workspace === null ? "environment" : "workspace",
  environment,
  scheduled: true,
  workspace,
  name: "",
  message: "",
  cron: "",
  zone,
  format: "github",
  match: [],
  whenBusy: defaultWhenBusy(workspace === null ? "environment" : "workspace", SCHEDULE_DEFAULT),
  base: "",
  model: "",
  thinking: "",
});

/** The form holding `definition`, to edit it. A source this version can't read leaves its Schedule empty. */
export const triggerDraftOf = (definition: TriggerDefinition): TriggerDraft => {
  const schedule = scheduleOf(definition);

  return {
    kind: definition.kind,
    environment: definition.environment,
    scheduled: definition.source.type !== "webhook",
    workspace: definition.workspace?.id ?? null,
    name: definition.name,
    message: definition.message,
    cron: schedule?.cron ?? "",
    zone: schedule?.zone ?? "",
    format: webhookOf(definition)?.format ?? "github",
    match: rowsOfMatch(webhookOf(definition)?.match),
    whenBusy: definition.whenBusy,
    base: definition.base ?? "",
    model: definition.model ?? "",
    thinking: definition.thinking ?? "",
  };
};

/** The rows that hold `match`, in its order; none for no match. */
export const rowsOfMatch = (match: TriggerMatch | undefined): ReadonlyArray<MatchRow> =>
  Arr.map(Object.entries(match ?? {}), ([path, values]) => ({
    path,
    values: Arr.join(values, "\n"),
  }));

/** The values typed in a row: one to a line, a line's trailing carriage return and empty lines left out. */
const valuesOfRow = (row: MatchRow): ReadonlyArray<string> =>
  Arr.filter(
    Arr.map(row.values.split("\n"), (line) => line.replace(/\r$/u, "")),
    (line) => line !== "",
  );

/** Whether a row holds nothing: a blank row is the form's spare one, and means no filter. */
const blankRow = (row: MatchRow): boolean =>
  row.path.trim() === "" && valuesOfRow(row).length === 0;

/** The `match` the rows make, in their order; a path typed twice keeps its first row's values. */
export const matchOfRows = (rows: ReadonlyArray<MatchRow>): TriggerMatch => {
  const match: Types.Mutable<TriggerMatch> = {};

  for (const row of rows) {
    const path = row.path.trim();

    if (blankRow(row) || Object.hasOwn(match, path)) continue;

    match[path] = valuesOfRow(row);
  }

  return match;
};

/** Why the rows can't make a `match` the Registry keeps (a path typed twice, a path with no values, a value with no path), or null. */
export const matchRowsProblem = (rows: ReadonlyArray<MatchRow>): string | null => {
  const paths = Arr.map(
    Arr.filter(rows, (row) => !blankRow(row)),
    (row) => row.path.trim(),
  );

  const twice = Arr.findFirst(paths, (path, at) => paths.indexOf(path) !== at);

  if (Option.isSome(twice))
    return `The path "${twice.value}" is typed twice: list its values in one row`;

  return problemOf(matchProblem(matchOfRows(rows)));
};

/** Whether two matches filter the same: the same paths, each with the same values in order (the paths' order is free). */
const sameMatch = (a: TriggerMatch | undefined, b: TriggerMatch | undefined): boolean => {
  const left = Object.entries(a ?? {});
  const right = b ?? {};

  return (
    left.length === Object.keys(right).length &&
    left.every(([path, values]) => {
      const other = Object.hasOwn(right, path) ? right[path] : undefined;

      return (
        other !== undefined &&
        other.length === values.length &&
        values.every((value, at) => value === other[at])
      );
    })
  );
};

/**
 * `draft` with its source switched to a Schedule (`scheduled`) or a webhook: `when_busy` follows to the new source's
 * default while it still is the old one's (a webhook Trigger starts a Session for each delivery, a Schedule's skips).
 */
export const withSource = (draft: TriggerDraft, scheduled: boolean): TriggerDraft => {
  if (draft.scheduled === scheduled) return draft;

  const kind = draft.workspace === null ? "environment" : "workspace";
  const was = defaultWhenBusy(kind, draft.scheduled ? SCHEDULE_DEFAULT : WEBHOOK_DEFAULT);
  const now = defaultWhenBusy(kind, scheduled ? SCHEDULE_DEFAULT : WEBHOOK_DEFAULT);

  return { ...draft, scheduled, whenBusy: draft.whenBusy === was ? now : draft.whenBusy };
};

/** Why each field of the form can't be saved, or null. */
export type TriggerDraftProblems = {
  readonly name: string | null;
  readonly message: string | null;
  readonly schedule: string | null;
  readonly match: string | null;
};

const problemOf = (problem: string | undefined): string | null => problem ?? null;

/** What keeps `draft` from being saved, field by field, as the Registry would refuse it. */
export const triggerDraftProblems = (draft: TriggerDraft): TriggerDraftProblems => ({
  name: problemOf(triggerNameProblem(draft.name)),
  message: problemOf(triggerMessageProblem(draft.message)),
  schedule: draft.scheduled
    ? problemOf(scheduleProblem({ cron: draft.cron, zone: draft.zone }))
    : null,
  match: draft.scheduled ? null : matchRowsProblem(draft.match),
});

/** Whether `draft` can be saved. */
export const triggerDraftReady = (draft: TriggerDraft): boolean => {
  const problems = triggerDraftProblems(draft);

  return (
    problems.name === null &&
    problems.message === null &&
    problems.schedule === null &&
    problems.match === null
  );
};

/** The next Fires the form's Schedule gives after `now`, or none while it can't be saved. */
export const previewFires = (draft: TriggerDraft, now: number): ReadonlyArray<number> =>
  draft.scheduled && scheduleProblem({ cron: draft.cron, zone: draft.zone }) === undefined
    ? nextFires({ cron: draft.cron.trim(), zone: draft.zone.trim() }, now, PREVIEWED_FIRES)
    : [];

const optional = (text: string): string | undefined =>
  text.trim() === "" ? undefined : text.trim();

const isThinkingLevel = Schema.is(ThinkingLevel);

const thinkingOf = (text: string): ThinkingLevel | undefined =>
  isThinkingLevel(text) ? text : undefined;

/** The source `draft` makes: its Schedule, or its webhook with the `match` its rows make (none for no row). */
const sourceOf = (draft: TriggerDraft): TriggerSourceInput => {
  if (draft.scheduled) {
    return { type: "schedule", cron: draft.cron.trim(), zone: draft.zone.trim() };
  }

  const match = matchOfRows(draft.match);

  return Object.keys(match).length === 0
    ? { type: "webhook", format: draft.format }
    : { type: "webhook", format: draft.format, match };
};

/** The new Trigger `draft` makes: the owner's own, active. */
export const triggerInput = (draft: TriggerDraft): OwnerTriggerInput => {
  const model = optional(draft.model);
  const thinking = thinkingOf(draft.thinking);
  const source = sourceOf(draft);

  if (draft.kind === "workspace" && draft.workspace !== null) {
    const input: Types.Mutable<WorkspaceTriggerInput> = {
      kind: "workspace",
      workspace: draft.workspace,
      name: draft.name.trim(),
      message: draft.message,
      source,
      whenBusy: draft.whenBusy,
    };

    if (model !== undefined) input.model = model;

    if (thinking !== undefined) input.thinking = thinking;

    return input;
  }

  const input: Types.Mutable<EnvironmentTriggerInput> = {
    kind: "environment",
    environment: draft.environment,
    name: draft.name.trim(),
    message: draft.message,
    source,
    whenBusy: draft.whenBusy,
  };

  const base = optional(draft.base);

  if (base !== undefined) input.base = base;

  if (model !== undefined) input.model = model;

  if (thinking !== undefined) input.thinking = thinking;

  return input;
};

/**
 * The change `draft` makes to `definition`: each field it changed, an option emptied set to null (back to the
 * Environment's own). Nothing changed is an empty change.
 */
export const triggerPatch = (definition: TriggerDefinition, draft: TriggerDraft): TriggerPatch => {
  const input = triggerInput(draft);
  const schedule = scheduleOf(definition);
  const webhook = webhookOf(definition);
  const patch: Types.Mutable<TriggerPatch> = {};
  const base = optional(draft.base);

  if (input.name !== definition.name) patch.name = input.name;

  if (input.message !== definition.message) patch.message = input.message;

  // A source's type and format are fixed at creation: a Schedule's source is sent when it changed, a webhook's `match`
  // alone, null once its rows are all gone.
  if (draft.scheduled && input.source.type === "schedule") {
    if (schedule?.cron !== input.source.cron || schedule.zone !== input.source.zone) {
      patch.source = input.source;
    }
  } else if (!draft.scheduled && webhook !== undefined) {
    const match = matchOfRows(draft.match);

    if (!sameMatch(webhook.match, match)) {
      patch.match = Object.keys(match).length === 0 ? null : match;
    }
  }

  if (input.whenBusy !== definition.whenBusy) patch.whenBusy = input.whenBusy;

  // A Workspace or Session trigger has no base to change.
  if (takesBase(definition.kind) && base !== definition.base) patch.base = base ?? null;

  if (input.model !== definition.model) patch.model = input.model ?? null;

  if (input.thinking !== definition.thinking) patch.thinking = input.thinking ?? null;

  return patch;
};

/** A Trigger's source as its row says it: "0 9 * * 1 · America/Chicago" for a Schedule, "Webhook · github". */
export const triggerSourceWords = (definition: TriggerDefinition): string => {
  const schedule = scheduleOf(definition);
  const webhook = webhookOf(definition);

  if (webhook !== undefined) return `Webhook · ${webhook.format}`;

  return schedule === undefined
    ? "A source this version can't read"
    : `${schedule.cron} · ${schedule.zone}`;
};

/** The next time `definition` fires after `now`, or null: none while it is paused, or for a source it can't read. */
export const nextFireOf = (definition: TriggerDefinition, now: number): number | null => {
  const schedule = scheduleOf(definition);

  if (definition.paused || schedule === undefined) return null;

  return nextFires(schedule, now, 1)[0] ?? null;
};

/** The zone a Trigger's times are shown in: its Schedule's, or UTC for a source this version can't read. */
export const zoneOf = (definition: TriggerDefinition): string =>
  scheduleOf(definition)?.zone ?? "UTC";

const whenBusyLabels: Record<TriggerWhenBusy, string> = {
  wait: "Wait until the workspace is idle",
  skip: "Skip this fire",
  start: "Start another session",
  queue: "Queue it after the run",
  steer: "Steer the run with it",
};

/** What the "when busy" choice offers a Trigger of `kind`, each with the words that name it. */
export const whenBusyChoices = (
  kind: TriggerKind,
): ReadonlyArray<{ readonly value: TriggerWhenBusy; readonly label: string }> =>
  Arr.map(whenBusyValues(kind), (value) => ({ value, label: whenBusyLabels[value] }));

/** The `when_busy` a select's text names; unknown text is the kind's default for a Schedule. */
export const whenBusyOfText = (kind: TriggerKind, text: string): TriggerWhenBusy =>
  Arr.findFirst(whenBusyValues(kind), (value) => value === text).pipe(
    Option.getOrElse(() => defaultWhenBusy(kind, SCHEDULE_DEFAULT)),
  );

/** What the Settings page says of a Trigger of a kind, where kinds differ. */
type KindWords = {
  /** The badge on its row, if the kind has one. */
  readonly badge: string | undefined;
  /** The label of its "when busy" choice. */
  readonly whenBusyLabel: string;
  /** What "busy" means for it, in the choice's hint. */
  readonly whenBusyHint: string;
  /** What each Fire sends its message to, in the message's hint. */
  readonly messageTarget: string;
  /** What its Remove confirm says of what it leaves. */
  readonly removeNote: string;
  /** What the fire log says of a Fire skipped as `coalesced`. */
  readonly coalescedWords: string;
};

const ENVIRONMENT_WORDS: KindWords = {
  badge: undefined,
  whenBusyLabel: "When the last fire's session is busy",
  whenBusyHint: "Busy: still running, or waiting for you.",
  messageTarget: "a new session",
  removeNote: "The sessions it started stay.",
  coalescedWords: "Skipped: coalesced",
};

/** Each kind's words: a later kind is one more entry. A kind this version doesn't know reads as an Environment trigger's. */
const KIND_WORDS: Record<TriggerKind, KindWords> = {
  environment: ENVIRONMENT_WORDS,
  workspace: {
    badge: undefined,
    whenBusyLabel: "When the workspace is busy",
    whenBusyHint:
      "Busy: any session in the workspace is running or waiting for you, yours included. A waiting fire starts once it is idle; later ones are merged into it.",
    messageTarget: "a new session",
    removeNote: "The sessions it started stay.",
    coalescedWords: "Skipped: merged into the waiting fire",
  },
  session: {
    badge: "Session trigger",
    whenBusyLabel: "When its session is busy",
    whenBusyHint: "Busy: its run is going on, or waiting for you.",
    messageTarget: "its session",
    removeNote: "Its session stays.",
    coalescedWords: "Skipped: an earlier fire is still queued",
  },
  unknown: ENVIRONMENT_WORDS,
};

export const kindWords = (kind: TriggerKind): KindWords => KIND_WORDS[kind];

const skippedWords = (reason: FireSkip, kind: TriggerKind): string => {
  switch (reason) {
    case "unknown":
      return "Skipped";
    case "coalesced":
      return KIND_WORDS[kind].coalescedWords;
    case "archived":
      return "Skipped: its session is archived";
    case "importing":
      return "Skipped: its session is still importing";
    default:
      return `Skipped: ${reason}`;
  }
};

/** What came of a Fire of a Trigger of `kind`, as its fire log says it; a started one links its Session apart. */
export const outcomeWords = (outcome: FireOutcome, kind: TriggerKind): string => {
  switch (outcome.type) {
    case "started":
      return "Started a session";
    case "sent":
      return outcome.delivery === "unknown" ? "Sent" : `Sent (${outcome.delivery})`;
    case "skipped":
      return `${skippedWords(outcome.reason, kind)}${
        outcome.merged === undefined ? "" : `, ${String(outcome.merged)} merged`
      }`;
    case "failed":
      return `Failed: ${outcome.reason}`;
    case "unknown":
      return "An outcome this version can't read";
  }
};

/** What made a Fire, in `zone`: its Schedule's time, the owner's Fire now, or a source this version can't read. */
export const sourceWords = (fire: FireRecord, zone: string): string => {
  switch (fire.source.type) {
    case "schedule":
      return `Scheduled for ${fireTimeWords(fire.source.scheduledAt, zone)}`;
    case "webhook":
      return `Webhook delivery ${fire.source.delivery}${fire.source.event === undefined ? "" : ` (${fire.source.event})`}`;
    case "manual":
      return "Fired by hand";
    case "unknown":
      return "A source this version can't read";
  }
};

/** What a Workspace trigger's waiting Fire says of itself: since when it waits, and how many more were merged into it. */
export const waitingWords = (
  waiting: { readonly since: number; readonly merged: number },
  zone: string,
): string =>
  `Waiting for the workspace to be idle (since ${fireTimeWords(waiting.since, zone)}${
    waiting.merged === 0 ? "" : `, ${String(waiting.merged)} more merged`
  })`;

/** `one` for a count of 1, else `many`: "trigger" or "triggers", "keeps" or "keep". */
export const oneOrMany = (count: number, one: string, many: string): string =>
  count === 1 ? one : many;

/** The names of `triggers`, quoted: "“A”", "“A” and “B”" or "“A”, “B” and “C”". */
export const triggerNames = (triggers: ReadonlyArray<{ readonly name: string }>): string => {
  const names = Arr.map(triggers, (trigger) => `“${trigger.name}”`);
  const last = Arr.last(names);

  if (Option.isNone(last)) return "";

  const rest = Arr.dropRight(names, 1);

  return rest.length === 0 ? last.value : `${Arr.join(rest, ", ")} and ${last.value}`;
};

/** The Workspace triggers kept for Workspace `workspace`, among `triggers` as last listed (none until they are). */
export const workspaceTriggersOf = (
  triggers: ReadonlyArray<{ readonly definition: TriggerDefinition }> | null,
  workspace: string,
): Array<TriggerDefinition> =>
  Arr.filter(
    Arr.map(triggers ?? [], (overview) => overview.definition),
    (definition) => definition.workspace?.id === workspace,
  );

/** What a webhook Trigger's `match` says on its row: each path with the values it may have, or that there is none. */
export const matchWords = (match: TriggerMatch | undefined): string => {
  const entries = Object.entries(match ?? {});

  return entries.length === 0
    ? "No match: every signed delivery starts a session"
    : `Match: ${Arr.join(
        Arr.map(entries, ([path, values]) => `${path} is ${Arr.join(values, " or ")}`),
        "; ",
      )}`;
};

/** What a delivery counter's outcome says: the answer the sender got, and why; an outcome a later version names says itself. */
const outcomeWordsOf = (outcome: string): string => {
  switch (outcome) {
    case "filtered":
      return "filtered out by the match";
    case "bot_unverified":
      return "dropped as a bot's, the App's own not being known";
    case "unauthorized":
      return "unauthorized (401)";
    case "not_found":
      return "wrong URL (404)";
    case "too_large":
      return "too large (413)";
    case "unsupported":
      return "unsupported content type (415)";
    default:
      return outcome;
  }
};

/** The words for the deliveries refused or filtered on one day: "3 filtered out by the match, 1 unauthorized (401)". */
const dayWords = (
  counts: ReadonlyArray<{ readonly outcome: string; readonly n: number }>,
): string =>
  Arr.join(
    Arr.map(counts, ({ outcome, n }) => `${String(n)} ${outcomeWordsOf(outcome)}`),
    ", ",
  );

/**
 * The per-day counts of the deliveries a Trigger refused or filtered, newest day first, each day as one line of words
 * ("2026-11-08": "3 filtered out by the match, 1 unauthorized (401)"): the days are UTC's, as they are counted.
 */
export const deliveryDays = (
  counts: TriggerDeliveries["counts"],
): ReadonlyArray<{ readonly day: string; readonly words: string }> =>
  Arr.map(
    Arr.sort(Arr.dedupe(Arr.map(counts, (count) => count.day)), Order.flip(Order.String)),
    (day) => ({ day, words: dayWords(Arr.filter(counts, (count) => count.day === day)) }),
  );

/** What a webhook row says of its last authentic delivery, in `zone`. */
export const lastDeliveryWords = (deliveries: TriggerDeliveries, zone: string): string =>
  deliveries.lastDeliveryAt === null
    ? "No delivery yet"
    : `Last delivery: ${fireTimeWords(deliveries.lastDeliveryAt, zone)}`;

/** What a GitHub ping says on the row: when GitHub last reached the Trigger, or nothing. */
export const pingWords = (deliveries: TriggerDeliveries, zone: string): string | null =>
  deliveries.pingAt === null
    ? null
    : `GitHub reached this trigger (${fireTimeWords(deliveries.pingAt, zone)})`;

/** A Trigger URL as the sender is given it: the stage's origin before the path, or just the path where the page's own is the one. */
export const hookUrl = (hook: TriggerHook, pageOrigin: string): string =>
  `${hook.origin ?? pageOrigin}${hook.path}`;
