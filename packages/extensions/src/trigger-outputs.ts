// What the `trigger_*` tools give programs (`docs/architecture/agent-capabilities.md` → Values for programs,
// `./triggers.ts`): a Trigger as `trigger_get` gives it, the Triggers `trigger_list` lists, and the outcome of each
// change in the shape of a change at a Scope (`ChangeOutputFields`: the Trigger's Environment, the Agent changes made,
// the fields that already had their value, the owner's Approval) with the Trigger after it. A Trigger message is cut as
// `boundText` cuts it, and the list as `boundItems` cuts it, each with a `<field>_truncated` flag. Times are ISO 8601.
// @effect-diagnostics missingPipeableSignature:off globalDate:off -- plain functions that write times as ISO text.
import { type EnvironmentRef, scheduleOf, type TriggerDefinition } from "@cloudpid/protocol";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import {
  boundItems,
  boundText,
  ChangeOutputFields,
  ScopeRef,
  scopeRef,
  type ApprovalOutcome,
  changesOutput,
} from "./outputs.ts";
import type { AgentChange } from "@cloudpid/protocol";

const Time = Schema.String.annotate({ description: "A time, as ISO 8601 text in UTC" });

const iso = (at: number): string => new Date(at).toISOString();

/** What every Trigger output says of a Trigger, but its message. */
const TriggerSummaryFields = {
  id: Schema.String.annotate({
    description: "The Trigger's id, which the other trigger_* tools take",
  }),
  name: Schema.String.annotate({ description: "The Trigger's name, which titles its Sessions" }),
  kind: Schema.String.annotate({
    description:
      '"environment": each Fire starts a new Session in a new Workspace of its Environment; "workspace": each Fire starts a new Session in its Workspace',
  }),
  environment: ScopeRef.annotate({ description: "The Environment the Trigger belongs to" }),
  workspace: Schema.NullOr(
    Schema.Struct({
      id: Schema.String.annotate({ description: "The Workspace's id" }),
      branch: Schema.String.annotate({ description: "The Workspace's branch" }),
    }),
  ).annotate({
    description:
      "The Workspace a Workspace trigger is kept for, which it keeps; null for an Environment trigger",
  }),
  schedule: Schema.NullOr(
    Schema.Struct({
      cron: Schema.String.annotate({ description: "The 5-field cron expression" }),
      zone: Schema.String.annotate({ description: "The IANA time zone it is read in" }),
    }),
  ).annotate({
    description: "The Schedule it fires on; null for a source this version can't read",
  }),
  when_busy: Schema.String.annotate({
    description:
      '"skip": a Fire while the last Fire\'s Session (a Workspace trigger\'s: any Session in its Workspace) is still at work is skipped; "start": it starts a Session anyway; "wait" (a Workspace trigger\'s default): it stays pending until the Workspace is idle',
  }),
  base: Schema.NullOr(Schema.String).annotate({
    description:
      "The branch each Fire's Workspace starts from; null for each Repo's default branch, and for a Workspace trigger, which holds none",
  }),
  model: Schema.NullOr(Schema.String).annotate({
    description: "The model of each Fire's Session; null for the Environment's",
  }),
  thinking: Schema.NullOr(Schema.String).annotate({
    description: "The thinking level of each Fire's Session; null for the Environment's",
  }),
  paused: Schema.Boolean.annotate({ description: "A Paused trigger doesn't fire" }),
  next_fires: Schema.Array(Time).annotate({
    description: "The next times it fires, soonest first; empty while it is paused",
  }),
};

export const TriggerSummaryOutput = Schema.Struct(TriggerSummaryFields);

/** A Trigger with its message. */
export const TriggerOutput = Schema.Struct({
  ...TriggerSummaryFields,
  message: Schema.String.annotate({
    description: "The Trigger message each Fire's Session is sent",
  }),
  message_truncated: Schema.Boolean.annotate({
    description: "The message was too large to give: its start is given",
  }),
  created_at: Time,
  updated_at: Time,
});

export const TriggerListOutput = Schema.Struct({
  triggers: Schema.Array(TriggerSummaryOutput).annotate({
    description: "The Triggers, newest first",
  }),
  triggers_truncated: Schema.Boolean.annotate({
    description: "More Triggers than fit this value: the first are listed",
  }),
});

/** A Trigger changed: the change at its Environment's Scope, and the Trigger after it (null once removed). */
export const TriggerChangeOutput = Schema.Struct({
  ...ChangeOutputFields,
  trigger: Schema.NullOr(TriggerOutput).annotate({
    description: "The Trigger after the call; null once it is removed, or when nothing was made",
  }),
});

/** `definition` in its Environment `environment`, as a summary gives it, with its next Fires (`next`). */
export const triggerSummaryOutput = (
  definition: TriggerDefinition,
  environment: EnvironmentRef,
  next: ReadonlyArray<number>,
): typeof TriggerSummaryOutput.Type => {
  const schedule = scheduleOf(definition);

  return {
    id: definition.id,
    name: definition.name,
    kind: definition.kind,
    environment: scopeRef(environment),
    workspace: definition.workspace === undefined ? null : { ...definition.workspace },
    schedule: schedule === undefined ? null : { cron: schedule.cron, zone: schedule.zone },
    when_busy: definition.whenBusy,
    base: definition.base ?? null,
    model: definition.model ?? null,
    thinking: definition.thinking ?? null,
    paused: definition.paused,
    next_fires: Arr.map(next, iso),
  };
};

/** `definition` with its message, as `trigger_get` and a change give it. */
export const triggerOutput = (
  definition: TriggerDefinition,
  environment: EnvironmentRef,
  next: ReadonlyArray<number>,
): typeof TriggerOutput.Type => {
  const message = boundText(definition.message);

  return {
    ...triggerSummaryOutput(definition, environment, next),
    message: message.text,
    message_truncated: message.truncated,
    created_at: iso(definition.createdAt),
    updated_at: iso(definition.updatedAt),
  };
};

/** The Triggers `trigger_list` gives: the first that fit, and whether any were left out. */
export const triggerListOutput = (
  triggers: ReadonlyArray<typeof TriggerSummaryOutput.Type>,
): typeof TriggerListOutput.Type => {
  const { items, truncated } = boundItems(triggers);

  return { triggers: items, triggers_truncated: truncated };
};

/** A change's outcome: `changes` made (none when `unchanged` names the field), and the Trigger after it. */
export const triggerChangeOutput = ({
  environment,
  changes,
  unchanged = [],
  approval,
  trigger,
}: {
  readonly environment: EnvironmentRef;
  readonly changes: ReadonlyArray<AgentChange>;
  readonly unchanged?: ReadonlyArray<string>;
  readonly approval: typeof ApprovalOutcome.Type;
  readonly trigger: typeof TriggerOutput.Type | null;
}): typeof TriggerChangeOutput.Type => ({
  scope: scopeRef(environment),
  ...changesOutput(changes),
  unchanged,
  approval,
  trigger,
});
