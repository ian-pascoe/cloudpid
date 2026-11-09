// @effect-diagnostics missingPipeableSignature:off -- plain functions over a Trigger and its form, not combinators.

// The Settings page's Triggers section, as values (`docs/architecture/triggers.md` → The owner's UI): the form that makes
// or edits an Environment trigger, or a Workspace trigger (its name, message, its source, a Schedule with the next Fires
// it gives or a webhook with its format and `match` rows, and a github one's repo and events for a GitHub-managed hook,
// and options), what it sends the Registry (an edit sends only what changed, and for a webhook only its `match`), and the
// words a Trigger's row, its hook, its deliveries and its fire log show.

import {
  defaultWhenBusy,
  type EnvironmentTriggerInput,
  type FireOutcome,
  type FireRecord,
  type FireSkip,
  fireTimeWords,
  type GitHubHookStatus,
  githubHookOf,
  githubHookProblem,
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
  type WebhookSource,
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
import * as Rec from "effect/Record";
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
 * are fixed at creation, so editing a webhook Trigger sends only its `match`. A new github webhook may name a `repo`
 * and its `events` (typed apart by commas, spaces or lines): cloudpid makes its hook there, as the GitHub App; both are
 * fixed at creation too. A Workspace trigger's form names its Workspace (`workspace`, by id) and has no `base`.
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
  /** A github webhook's repo (`owner/name`) for a GitHub-managed hook; empty for a hook the owner makes. */
  readonly repo: string;
  /** The GitHub events that hook is sent, as typed. */
  readonly events: string;
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
  repo: "",
  events: "",
  whenBusy: defaultWhenBusy(workspace === null ? "environment" : "workspace", SCHEDULE_DEFAULT),
  base: "",
  model: "",
  thinking: "",
});

/** The form holding `definition`, to edit it. A source this version can't read leaves its Schedule empty. */
export const triggerDraftOf = (definition: TriggerDefinition): TriggerDraft => {
  const schedule = scheduleOf(definition);
  const hook = githubHookOf(definition);

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
    repo: hook?.repo ?? "",
    events: Arr.join(hook?.events ?? [], ", "),
    whenBusy: definition.whenBusy,
    base: definition.base ?? "",
    model: definition.model ?? "",
    thinking: definition.thinking ?? "",
  };
};

/** The rows that hold `match`, in its order; none for no match. */
export const rowsOfMatch = (match: TriggerMatch | undefined): ReadonlyArray<MatchRow> =>
  Arr.map(Rec.toEntries(match ?? {}), ([path, values]) => ({
    path,
    values: Arr.join(values, "\n"),
  }));

/** The values typed in a row: one to a line, each trimmed, and the empty lines left out. */
const valuesOfRow = (row: MatchRow): ReadonlyArray<string> =>
  Arr.filter(
    Arr.map(row.values.split("\n"), (line) => line.trim()),
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

    if (blankRow(row) || Rec.has(match, path)) continue;

    match[path] = valuesOfRow(row);
  }

  return match;
};

/**
 * Why the rows can't make a `match` the Registry keeps, or null: a path typed twice is the form's own refusal, the rest
 * (a path with no values, a value with no path, an empty part of a path) are `matchProblem`'s words.
 */
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

/**
 * Whether the rows of `draft` are the ones `opened` is held as, as typed. A match is compared by its rows and not by
 * what they make, which can't hold everything a match can (an empty value, a value with a line break, a path with edge
 * spaces: the agent's `match` may), so a Trigger edited in another field never has its `match` rewritten.
 */
const rowsUnchanged = (draft: TriggerDraft, opened: TriggerDefinition | undefined): boolean => {
  const held = rowsOfMatch(webhookOf(opened)?.match);

  return (
    opened !== undefined &&
    held.length === draft.match.length &&
    Arr.every(
      held,
      (row, at) => row.path === draft.match[at]?.path && row.values === draft.match[at]?.values,
    )
  );
};

/**
 * `draft` with its source switched to a Schedule or a webhook: `when_busy` follows to the new source's default while it
 * still is the old one's (a webhook Trigger starts a Session for each delivery, a Schedule's skips). A Session trigger
 * takes a Schedule only, so its draft never switches.
 */
export const withSource = (draft: TriggerDraft, source: "schedule" | "webhook"): TriggerDraft => {
  const scheduled = source === "schedule";

  if (draft.scheduled === scheduled || draft.kind === "session") return draft;

  const { kind } = draft;
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
  /** Why a new github webhook's repo and events make no GitHub-managed hook. */
  readonly hook: string | null;
};

const problemOf = (problem: string | undefined): string | null => problem ?? null;

/**
 * What keeps `draft` from being saved, field by field, as the Registry would refuse it. The rows of a Trigger being
 * edited (`opened`) that were not touched are never refused: its `match` is not sent.
 */
export const triggerDraftProblems = (
  draft: TriggerDraft,
  opened?: TriggerDefinition,
): TriggerDraftProblems => ({
  name: problemOf(triggerNameProblem(draft.name)),
  message: problemOf(triggerMessageProblem(draft.message)),
  schedule: draft.scheduled
    ? problemOf(scheduleProblem({ cron: draft.cron, zone: draft.zone }))
    : null,
  match: draft.scheduled || rowsUnchanged(draft, opened) ? null : matchRowsProblem(draft.match),
  // Fixed at creation: an edit never sends them.
  hook:
    draft.scheduled || opened !== undefined
      ? null
      : problemOf(githubHookProblem(webhookSourceOf(draft))),
});

/** Whether `draft` can be saved (as an edit of `opened`, if it is one). */
export const triggerDraftReady = (draft: TriggerDraft, opened?: TriggerDefinition): boolean => {
  const problems = triggerDraftProblems(draft, opened);

  return (
    problems.name === null &&
    problems.message === null &&
    problems.schedule === null &&
    problems.match === null &&
    problems.hook === null
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

/** The events typed for a GitHub-managed hook: apart by commas, spaces or lines, the empty ones left out. */
const eventsOf = (text: string): ReadonlyArray<string> =>
  Arr.filter(text.split(/[\s,]+/u), (event) => event !== "");

/**
 * The webhook `draft` makes: its format, the `match` its rows make (none for no row), and for a github one the repo and
 * events typed (neither when both are empty).
 */
const webhookSourceOf = (draft: TriggerDraft): WebhookSource => {
  const source: Types.Mutable<WebhookSource> = { type: "webhook", format: draft.format };
  const match = matchOfRows(draft.match);
  const repo = draft.repo.trim();
  const events = eventsOf(draft.events);

  if (!Rec.isEmptyRecord(match)) source.match = match;

  if (draft.format === "github" && repo !== "") source.repo = repo;

  if (draft.format === "github" && events.length > 0) source.events = events;

  return source;
};

/** The source `draft` makes: its Schedule, or its webhook. */
const sourceOf = (draft: TriggerDraft): TriggerSourceInput =>
  draft.scheduled
    ? { type: "schedule", cron: draft.cron.trim(), zone: draft.zone.trim() }
    : webhookSourceOf(draft);

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
  const patch: Types.Mutable<TriggerPatch> = {};
  const base = optional(draft.base);

  if (input.name !== definition.name) patch.name = input.name;

  if (input.message !== definition.message) patch.message = input.message;

  // A source's type and format are fixed at creation: a Schedule's source is sent when it changed, a webhook's `match`
  // alone and only when its rows were edited (null once they are all gone).
  if (draft.scheduled && input.source.type === "schedule") {
    if (schedule?.cron !== input.source.cron || schedule.zone !== input.source.zone) {
      patch.source = input.source;
    }
  } else if (
    !draft.scheduled &&
    webhookOf(definition) !== undefined &&
    !rowsUnchanged(draft, definition)
  ) {
    const match = matchOfRows(draft.match);

    patch.match = Rec.isEmptyRecord(match) ? null : match;
  }

  if (input.whenBusy !== definition.whenBusy) patch.whenBusy = input.whenBusy;

  // A Workspace or Session trigger has no base to change.
  if (takesBase(definition.kind) && base !== definition.base) patch.base = base ?? null;

  if (input.model !== definition.model) patch.model = input.model ?? null;

  if (input.thinking !== definition.thinking) patch.thinking = input.thinking ?? null;

  return patch;
};

/**
 * A Trigger's source as its row says it: "0 9 * * 1 · America/Chicago" for a Schedule, "Webhook · github", and
 * "Webhook · github · octo-org/octo-repo" for one with a GitHub-managed hook.
 */
export const triggerSourceWords = (definition: TriggerDefinition): string => {
  const schedule = scheduleOf(definition);
  const webhook = webhookOf(definition);
  const hook = githubHookOf(definition);

  if (webhook !== undefined) {
    return hook === undefined
      ? `Webhook · ${webhook.format}`
      : `Webhook · ${webhook.format} · ${hook.repo}`;
  }

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
  const entries = Rec.toEntries(match ?? {});

  return entries.length === 0
    ? "No match: every signed delivery starts a session"
    : `Match: ${Arr.join(
        Arr.map(entries, ([path, values]) => `${path} is ${Arr.join(values, " or ")}`),
        "; ",
      )}`;
};

/** What a delivery counter's outcome says: the answer the sender got, and why; an outcome a later version names says itself. */
export const deliveryOutcomeWords = (outcome: string): string => {
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

/**
 * The per-day counts of the deliveries a Trigger refused or filtered, newest day first, each day with its counts in the
 * order they came: the days are UTC's, as they are counted.
 */
export const deliveryDays = (
  counts: TriggerDeliveries["counts"],
): ReadonlyArray<{
  readonly day: string;
  readonly counts: ReadonlyArray<{ readonly outcome: string; readonly n: number }>;
}> =>
  Arr.map(
    Arr.sort(Arr.dedupe(Arr.map(counts, (count) => count.day)), Order.flip(Order.String)),
    (day) => ({
      day,
      counts: Arr.map(
        Arr.filter(counts, (count) => count.day === day),
        ({ outcome, n }) => ({ outcome, n }),
      ),
    }),
  );

/** What a row says of its GitHub-managed hook: made, not made yet, or why GitHub refused it so far. */
export const githubHookWords = (status: GitHubHookStatus): string => {
  switch (status.state) {
    case "ready":
      return `GitHub hook on ${status.repo}: made`;
    case "pending":
      return `GitHub hook on ${status.repo}: not made yet, tried again soon`;
    case "failed":
      return `GitHub hook on ${status.repo} failed: ${status.problem?.message ?? "GitHub refused it"}`;
    case "unknown":
      return `GitHub hook on ${status.repo}: a state this version can't read`;
  }
};

/** The events of a GitHub-managed hook, as its row lists them. */
export const githubEventWords = (definition: TriggerDefinition): string | null => {
  const hook = githubHookOf(definition);

  return hook === undefined ? null : `Events: ${Arr.join(hook.events, ", ")}`;
};

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
export const triggerUrl = (hook: TriggerHook, pageOrigin: string): string =>
  `${hook.origin ?? pageOrigin}${hook.path}`;
