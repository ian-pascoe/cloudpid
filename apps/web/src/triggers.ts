// @effect-diagnostics missingPipeableSignature:off -- plain functions over a Trigger and its form, not combinators.

// The Settings page's Triggers section, as values (`docs/architecture/triggers.md` → The owner's UI): the form that makes
// or edits an Environment trigger (its name, message, Schedule with the next Fires it gives, and options), what it sends
// the Registry, and the words a Trigger's row and its fire log show.

import {
  type EnvironmentTriggerInput,
  type FireOutcome,
  type FireRecord,
  fireTimeWords,
  nextFires,
  scheduleOf,
  type ScheduleSource,
  webhookOf,
  scheduleProblem,
  type TriggerDefinition,
  triggerMessageProblem,
  triggerNameProblem,
  type TriggerPatch,
  type TriggerWhenBusy,
} from "@cloudpid/protocol";
import { ThinkingLevel } from "@cloudpid/config";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";

/** How many next Fires the form previews. */
export const PREVIEWED_FIRES = 5;

/**
 * What is typed in the Trigger form. An option left empty is the Environment's own (`base`: each Repo's default).
 * `scheduled` says the Trigger fires on a Schedule (a new one does), so the form asks for `cron` and `zone`; a webhook
 * Trigger has none, and its source is fixed at creation, so editing it never sends one.
 */
export type TriggerDraft = {
  readonly environment: string;
  readonly scheduled: boolean;
  readonly name: string;
  readonly message: string;
  readonly cron: string;
  readonly zone: string;
  readonly whenBusy: TriggerWhenBusy;
  readonly base: string;
  readonly model: string;
  readonly thinking: string;
};

/** An empty form for a Trigger of `environment`, its zone `zone` (the browser's). */
export const emptyTriggerDraft = (environment: string, zone: string): TriggerDraft => ({
  environment,
  scheduled: true,
  name: "",
  message: "",
  cron: "",
  zone,
  whenBusy: "skip",
  base: "",
  model: "",
  thinking: "",
});

/** The form holding `definition`, to edit it. A source this version can't read leaves its Schedule empty. */
export const triggerDraftOf = (definition: TriggerDefinition): TriggerDraft => {
  const schedule = scheduleOf(definition);

  return {
    environment: definition.environment,
    scheduled: definition.source.type !== "webhook",
    name: definition.name,
    message: definition.message,
    cron: schedule?.cron ?? "",
    zone: schedule?.zone ?? "",
    whenBusy: definition.whenBusy,
    base: definition.base ?? "",
    model: definition.model ?? "",
    thinking: definition.thinking ?? "",
  };
};

/** Why each field of the form can't be saved, or null. */
export type TriggerDraftProblems = {
  readonly name: string | null;
  readonly message: string | null;
  readonly schedule: string | null;
};

const problemOf = (problem: string | undefined): string | null => problem ?? null;

/** What keeps `draft` from being saved, field by field, as the Registry would refuse it. */
export const triggerDraftProblems = (draft: TriggerDraft): TriggerDraftProblems => ({
  name: problemOf(triggerNameProblem(draft.name)),
  message: problemOf(triggerMessageProblem(draft.message)),
  schedule: draft.scheduled
    ? problemOf(scheduleProblem({ cron: draft.cron, zone: draft.zone }))
    : null,
});

/** Whether `draft` can be saved. */
export const triggerDraftReady = (draft: TriggerDraft): boolean => {
  const problems = triggerDraftProblems(draft);

  return problems.name === null && problems.message === null && problems.schedule === null;
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

/** The new Trigger `draft` makes: the owner's own, active. */
export const triggerInput = (
  draft: TriggerDraft,
): EnvironmentTriggerInput & { readonly source: ScheduleSource } => {
  const input: Types.Mutable<EnvironmentTriggerInput & { source: ScheduleSource }> = {
    kind: "environment",
    environment: draft.environment,
    name: draft.name.trim(),
    message: draft.message,
    source: { type: "schedule", cron: draft.cron.trim(), zone: draft.zone.trim() },
    whenBusy: draft.whenBusy,
  };

  const base = optional(draft.base);
  const model = optional(draft.model);
  const thinking = thinkingOf(draft.thinking);

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

  if (input.name !== definition.name) patch.name = input.name;

  if (input.message !== definition.message) patch.message = input.message;

  // A webhook Trigger's source is fixed at creation: only a Schedule's is ever sent.
  if (
    draft.scheduled &&
    (schedule?.cron !== input.source.cron || schedule.zone !== input.source.zone)
  ) {
    patch.source = input.source;
  }

  if (input.whenBusy !== definition.whenBusy) patch.whenBusy = input.whenBusy;

  if (input.base !== definition.base) patch.base = input.base ?? null;

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

/** What came of a Fire, as its fire log says it; a started one links its Session apart. */
export const outcomeWords = (outcome: FireOutcome): string => {
  switch (outcome.type) {
    case "started":
      return "Started a session";
    case "skipped":
      return outcome.reason === "unknown" ? "Skipped" : `Skipped: ${outcome.reason}`;
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
      return `Webhook delivery ${fire.source.delivery}`;
    case "manual":
      return "Fire now";
    case "unknown":
      return "A source this version can't read";
  }
};
